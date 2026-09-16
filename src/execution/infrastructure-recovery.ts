import type { InfrastructureScope } from "../domain/harness-failure.js";
import type { GenerationHarness, HarnessRunContext, ResolvedBenchmarkConfig, RunRecord } from "../domain/types.js";
import type { BenchmarkDatabase } from "../persistence/database.js";
import type { InfrastructureCircuit, InfrastructureProbe } from "./contracts.js";
import { initialBuildDeadline } from "./generation-budget.js";

export const MINIMUM_INFRASTRUCTURE_COOLDOWN_MS = 60_000;
export const MAXIMUM_INFRASTRUCTURE_COOLDOWN_MS = 15 * 60_000;
export const MAXIMUM_INFRASTRUCTURE_OUTAGE_MS = 30 * 60_000;

/** Owns circuit recovery and queued transport probes; never claims or executes runs. */
export class InfrastructureRecovery {
  private engineCircuit: InfrastructureCircuit | null = null;
  private readonly providerCircuits = new Map<string, InfrastructureCircuit>();
  constructor(
    private readonly db: BenchmarkDatabase,
    private readonly experimentId: string,
    private readonly config: ResolvedBenchmarkConfig,
    private readonly harness: GenerationHarness,
    private readonly emitEvent: HarnessRunContext["emit"],
    private readonly emitRunEvent: (runId: string, ...args: Parameters<HarnessRunContext["emit"]>) => void,
    private readonly isStopping: () => boolean,
    private readonly wakeDispatch: () => void,
  ) {}

  get engine(): Readonly<InfrastructureCircuit> | null { return this.engineCircuit; }

  get hasProviderCircuits(): boolean { return this.providerCircuits.size > 0; }

  hasProviderCircuit(providerId: string): boolean { return this.providerCircuits.has(providerId); }

  canDispatchProvider(providerId: string, now: number): boolean {
    const circuit = this.providerCircuits.get(providerId);
    return !circuit || (now >= circuit.blockedUntil && !circuit.probeInFlight);
  }

  reserveProbes(run: RunRecord, includeEngine: boolean, now: number): InfrastructureProbe[] {
    const probes: InfrastructureProbe[] = [];
    const engine = includeEngine ? this.engineCircuit : null;
    const provider = this.providerCircuits.get(run.providerId);
    if (engine) {
      engine.probeInFlight = true;
      probes.push({ scope: "engine" });
    }
    if (provider && now >= provider.blockedUntil && !provider.probeInFlight) {
      provider.probeInFlight = true;
      probes.push({ scope: "provider", providerId: run.providerId });
    }
    const circuit = engine ?? provider;
    if (circuit && probes.length) {
      this.emitEvent("experiment.dispatch.probing", "info",
        engine ? "基础设施冷却结束，正在用 1 个任务探测连接" : "供应商冷却结束，正在用同一供应商的 1 个任务探测连接",
        { scope: circuit.scope, ...(engine ? {} : { providerId: run.providerId }), runId: run.id, previousError: circuit.error });
    }
    return probes;
  }

  recoveryBudgetExpired(run: RunRecord, firstFailedAt: number | null): boolean {
    const initialDeadline = this.initialBuildDeadline(run);
    const end = Number.isFinite(initialDeadline)
      ? initialDeadline
      : (firstFailedAt ?? Date.now()) + MAXIMUM_INFRASTRUCTURE_OUTAGE_MS;
    return Date.now() >= end;
  }

  initialBuildDeadline(run: RunRecord): number {
    if (this.db.getRounds(run.id)[0]?.status === "completed") return Infinity;
    return initialBuildDeadline(run, this.config.runtime.initialBuildSoftTimeoutMs ?? 0);
  }

  recoveryBudgetMs(run: RunRecord): number {
    return Number.isFinite(this.initialBuildDeadline(run))
      ? this.config.runtime.initialBuildSoftTimeoutMs!
      : MAXIMUM_INFRASTRUCTURE_OUTAGE_MS;
  }

  recoveryDelayMs(run: RunRecord, failures: number): number {
    const delayMs = Math.min(MAXIMUM_INFRASTRUCTURE_COOLDOWN_MS,
      Math.max(MINIMUM_INFRASTRUCTURE_COOLDOWN_MS, this.config.runtime.retryBackoffMs)
      * 2 ** Math.min(Math.max(failures - 1, 0), 10));
    return Math.max(1, Math.min(delayMs, this.initialBuildDeadline(run) - Date.now()));
  }

  async checkCircuitTransport(run: RunRecord, scope: InfrastructureScope): Promise<boolean> {
    if (!this.harness.checkInfrastructure) return true;
    try {
      await this.harness.checkInfrastructure(scope, run.providerId);
      return true;
    } catch {
      if (this.isStopping()) return false;
      // A read-only transport failure never submits a game prompt or uses an
      // attempt. Leave the task eligible for automatic recovery after backoff.
      const message = "基础设施只读连通检查失败，已自动延长冷却（未提交模型请求）";
      const failureState = this.db.recordInfrastructureFailure(run.id, Date.now(), scope);
      const delayMs = this.tripInfrastructureCircuit(scope, run.providerId, message, true);
      if (this.recoveryBudgetExpired(run, failureState.firstFailedAt)) {
        this.db.updateRun(run.id, { status: "failed", error: message });
        this.emitRunEvent(run.id, "run.delivery.blocked", "error", "连接故障持续到时间预算结束，现场已保留", { scope });
      } else {
        this.db.updateRun(run.id, {
          status: "retrying", error: message,
          availableAt: Date.now() + Math.max(delayMs, this.recoveryDelayMs(run, failureState.attempts))
        });
      }
      return false;
    }
  }

  tripInfrastructureCircuit(
    scope: InfrastructureScope,
    providerId: string,
    error: string,
    probeFailure: boolean,
  ): number {
    const now = Date.now();
    const previous = scope === "engine"
      ? this.engineCircuit
      : this.providerCircuits.get(providerId) ?? null;
    const reopening = !previous || probeFailure || now >= previous.blockedUntil;
    const failureCount = previous
      ? previous.failureCount + (probeFailure ? 1 : 0)
      : 1;
    const baseDelayMs = Math.max(
      MINIMUM_INFRASTRUCTURE_COOLDOWN_MS,
      this.config.runtime.retryBackoffMs,
    );
    const delayMs = Math.min(
      MAXIMUM_INFRASTRUCTURE_COOLDOWN_MS,
      baseDelayMs * 2 ** Math.min(Math.max(failureCount - 1, 0), 10),
    );
    const blockedUntil = reopening ? now + delayMs : previous.blockedUntil;
    const circuit: InfrastructureCircuit = {
      scope,
      failureCount,
      blockedUntil,
      probeInFlight: false,
      error,
    };
    if (scope === "engine") this.engineCircuit = circuit;
    else this.providerCircuits.set(providerId, circuit);
    if (reopening) {
      this.emitEvent(
        "experiment.dispatch.cooldown",
        "warn",
        "检测到基础设施连接故障，已暂停派发并进入冷却",
        {
          scope,
          providerId: scope === "provider" ? providerId : null,
          error,
          delayMs,
          blockedUntil,
          failureCount,
        },
      );
    }
    return Math.max(1_000, blockedUntil - now);
  }

  closeInfrastructureCircuit(
    scope: InfrastructureScope,
    runId: string,
    providerId: string,
  ): void {
    const circuit = scope === "engine"
      ? this.engineCircuit
      : this.providerCircuits.get(providerId) ?? null;
    if (!circuit) return;
    if (scope === "engine") this.engineCircuit = null;
    else this.providerCircuits.delete(providerId);
    this.emitEvent(
      "experiment.dispatch.recovered",
      "info",
      "基础设施连接已恢复，继续按并发上限派发",
      {
        scope: circuit.scope,
        providerId: scope === "provider" ? providerId : null,
        probeRunId: runId,
        failureCount: circuit.failureCount,
      },
    );
    this.wakeDispatch();
  }

  acknowledgeInfrastructureProbe(
    probes: InfrastructureProbe[],
    scope: InfrastructureScope,
    runId: string,
    providerId: string,
  ): void {
    const probeIndex = probes.findIndex(
      (probe) => probe.scope === scope &&
        (scope !== "provider" || probe.providerId === providerId),
    );
    if (probeIndex === -1) return;
    probes.splice(probeIndex, 1);
    this.closeInfrastructureCircuit(scope, runId, providerId);
  }

  isCircuitProbe(
    probes: InfrastructureProbe[],
    scope: InfrastructureScope,
    providerId?: string,
  ): boolean {
    return probes.some(
      (probe) => probe.scope === scope &&
        (scope !== "provider" || probe.providerId === providerId),
    );
  }

  releaseCircuitProbeReservations(probes: InfrastructureProbe[]): void {
    for (const probe of probes) {
      if (probe.scope === "engine") {
        if (this.engineCircuit) this.engineCircuit.probeInFlight = false;
      } else if (probe.providerId) {
        const circuit = this.providerCircuits.get(probe.providerId);
        if (circuit) circuit.probeInFlight = false;
      }
    }
  }

  restoreInfrastructureCircuits(): void {
    const now = Date.now();
    for (const run of this.db.listRuns(this.experimentId)) {
      if (run.status !== "retrying" || !run.error) continue;
      const failureState = this.db.getInfrastructureRetryState(run.id);
      if (failureState.attempts === 0 || failureState.kind === "incomplete") continue;
      // Legacy rows lack scope; conservatively protect the whole engine until a probe succeeds.
      const scope = failureState.scope ?? "engine";
      const restored: InfrastructureCircuit = {
        scope,
        failureCount: failureState.attempts,
        blockedUntil: Math.max(now, run.availableAt),
        probeInFlight: false,
        error: run.error,
      };
      if (scope === "engine") {
        if (!this.engineCircuit || restored.blockedUntil > this.engineCircuit.blockedUntil) {
          this.engineCircuit = restored;
        }
      } else {
        const previous = this.providerCircuits.get(run.providerId);
        if (!previous || restored.blockedUntil > previous.blockedUntil) {
          this.providerCircuits.set(run.providerId, restored);
        }
      }
    }
  }
}
