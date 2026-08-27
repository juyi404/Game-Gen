import { EventEmitter } from "node:events";
import type { BenchmarkDatabase } from "./database.js";
import { createHarness } from "./harness/opencode.js";
import type {
  ExperimentRecord,
  GenerationHarness,
  HarnessRoundResult,
  HarnessRunContext,
  ModelConfig,
  ResolvedBenchmarkConfig,
  RoundDefinition,
  RunRecord,
  TaskDefinition,
} from "./types.js";
import {
  prepareWorkspace,
  writeAttemptResult,
  writeExperimentManifest,
  writeRoundContext,
} from "./workspace.js";

interface ActiveRun {
  controller: AbortController;
  providerId: string;
  modelId: string;
  sessionId: string | null;
  workspacePath: string | null;
  completion: Promise<void> | null;
  circuitProbes: InfrastructureProbe[];
}

type InfrastructureScope = "opencode" | "provider";

interface InfrastructureCircuit {
  scope: InfrastructureScope;
  failureCount: number;
  blockedUntil: number;
  probeInFlight: boolean;
  error: string;
}

interface InfrastructureProbe {
  scope: InfrastructureScope;
  providerId?: string;
}

const MINIMUM_INFRASTRUCTURE_COOLDOWN_MS = 60_000;
const MAXIMUM_INFRASTRUCTURE_COOLDOWN_MS = 5 * 60_000;
const MAXIMUM_INFRASTRUCTURE_FAILURES_PER_RUN = 4;
const MAXIMUM_INFRASTRUCTURE_OUTAGE_MS = 30 * 60_000;

export class GenerationOrchestrator extends EventEmitter {
  private readonly taskById: Map<string, TaskDefinition>;
  private readonly modelById: Map<string, ModelConfig>;
  private readonly active = new Map<string, ActiveRun>();
  private readonly providerActive = new Map<string, number>();
  private readonly modelActive = new Map<string, number>();
  private readonly harness: GenerationHarness;
  private experiment: ExperimentRecord;
  private tick: NodeJS.Timeout | null = null;
  private pumping = false;
  private started = false;
  private paused = false;
  private cancelling = false;
  private shuttingDown = false;
  private settled = false;
  private openCodeCircuit: InfrastructureCircuit | null = null;
  private readonly providerCircuits = new Map<string, InfrastructureCircuit>();
  private completionResolve!: (experiment: ExperimentRecord) => void;
  private readonly completion: Promise<ExperimentRecord>;

  constructor(
    private readonly db: BenchmarkDatabase,
    experiment: ExperimentRecord,
    private readonly config: ResolvedBenchmarkConfig,
    tasks: TaskDefinition[],
    harness?: GenerationHarness,
  ) {
    super();
    this.experiment = experiment;
    this.taskById = new Map(tasks.map((task) => [task.id, task]));
    this.modelById = new Map(config.models.map((model) => [model.id, model]));
    this.harness = harness ?? createHarness(config);
    this.paused = experiment.status === "paused";
    this.completion = new Promise<ExperimentRecord>((resolve) => {
      this.completionResolve = resolve;
    });
  }

  get experimentId(): string {
    return this.experiment.id;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.db.recoverInterruptedRuns(this.experiment.id);
      this.restoreInfrastructureCircuits();
      await this.harness.start();
      if (!this.paused) {
        this.db.updateExperimentStatus(this.experiment.id, "running");
        this.experiment = this.db.getExperiment(this.experiment.id)!;
        this.emitEvent("experiment.started", "info", "生成实验开始执行", {
          globalConcurrency: this.config.runtime.globalConcurrency,
          stageMode: this.experiment.stageMode,
          targetRound: this.experiment.targetRound,
          maxRounds: this.experiment.maxRounds,
        });
      }
      await this.writeManifest();
      this.tick = setInterval(() => void this.pump(), 500);
      this.tick.unref();
      void this.pump();
    } catch (error) {
      const message = errorMessage(error);
      this.db.updateExperimentStatus(this.experiment.id, "failed", message);
      this.emitEvent("experiment.failed", "error", "生成实验启动失败", { error: message });
      await this.finishWithError(error instanceof Error ? error : new Error(message));
      throw error;
    }
  }

  waitForCompletion(): Promise<ExperimentRecord> {
    return this.completion;
  }

  pause(): void {
    if (this.settled || this.cancelling) return;
    this.paused = true;
    this.db.updateExperimentStatus(this.experiment.id, "paused");
    this.experiment = this.db.getExperiment(this.experiment.id)!;
    this.emitEvent("experiment.paused", "info", "已暂停派发新任务；正在运行的任务会继续完成");
  }

  resume(): void {
    if (this.settled || this.cancelling) return;
    this.paused = false;
    this.db.updateExperimentStatus(this.experiment.id, "running");
    this.experiment = this.db.getExperiment(this.experiment.id)!;
    this.emitEvent("experiment.resumed", "info", "生成实验已恢复");
    void this.pump();
  }

  async cancel(): Promise<void> {
    if (this.settled || this.cancelling) return;
    this.cancelling = true;
    this.db.updateExperimentStatus(this.experiment.id, "cancelled");
    const queued = this.db.cancelQueuedRuns(this.experiment.id);
    this.emitEvent("experiment.cancelling", "warn", "正在取消生成实验", {
      queuedRunsCancelled: queued,
      activeRuns: this.active.size,
    });
    for (const [runId, active] of this.active) {
      active.controller.abort(new Error("生成实验已取消"));
      if (active.sessionId && active.workspacePath) {
        void this.harness.abortRun(active.sessionId, active.workspacePath);
      }
      this.db.appendEvent(
        this.experiment.id,
        runId,
        "run.cancelling",
        "warn",
        "正在取消运行",
      );
    }
    if (this.active.size === 0) await this.finalize();
  }

  async shutdown(): Promise<void> {
    if (this.settled) return;
    this.shuttingDown = true;
    this.stopTick();
    for (const active of this.active.values()) {
      active.controller.abort(new Error("框架正在关闭"));
      if (active.sessionId && active.workspacePath) {
        void this.harness.abortRun(active.sessionId, active.workspacePath);
      }
    }
    const completions = [...this.active.values()]
      .map((active) => active.completion)
      .filter((completion): completion is Promise<void> => completion !== null);
    await Promise.allSettled(completions);
    await this.harness.stop();
  }

  private async pump(): Promise<void> {
    if (
      this.pumping ||
      this.paused ||
      this.cancelling ||
      this.shuttingDown ||
      this.settled
    ) {
      return;
    }
    this.pumping = true;
    try {
      const now = Date.now();
      if (this.active.size === 0) {
        const summary = this.db.getSummary(this.experiment.id);
        const unfinished = summary.queued + summary.preparing + summary.running + summary.retrying;
        const stagedRunsReady = unfinished === 0 &&
          this.db.listRunnableRuns(this.experiment.id, now, 1).length > 0;
        if (unfinished === 0 && !stagedRunsReady) {
          await this.finalize();
          return;
        }
      }
      if (this.openCodeCircuit) {
        if (now < this.openCodeCircuit.blockedUntil) return;
        if (this.openCodeCircuit.probeInFlight || this.active.size > 0) return;
      }
      const runnable = this.db.listRunnableRuns(
        this.experiment.id,
        now,
        this.runnableScanLimit(),
      );
      if (this.openCodeCircuit) {
        const probe = runnable.find((run) => this.hasCapacity(run, now));
        if (probe) {
          const claimed = this.db.claimRun(probe.id);
          if (claimed) {
            this.openCodeCircuit.probeInFlight = true;
            const probes: InfrastructureProbe[] = [{ scope: "opencode" }];
            const providerCircuit = this.providerCircuits.get(claimed.providerId);
            if (providerCircuit && now >= providerCircuit.blockedUntil && !providerCircuit.probeInFlight) {
              providerCircuit.probeInFlight = true;
              probes.push({ scope: "provider", providerId: claimed.providerId });
            }
            this.emitEvent(
              "experiment.dispatch.probing",
              "info",
              "基础设施冷却结束，正在用 1 个任务探测连接",
              {
                scope: this.openCodeCircuit.scope,
                runId: claimed.id,
                previousError: this.openCodeCircuit.error,
              },
            );
            this.startRun(claimed, probes);
          }
        }
        return;
      }
      for (const run of runnable) {
        if (this.active.size >= this.config.runtime.globalConcurrency) break;
        if (!this.hasCapacity(run, now)) continue;
        const claimed = this.db.claimRun(run.id);
        if (!claimed) continue;
        const probes: InfrastructureProbe[] = [];
        const providerCircuit = this.providerCircuits.get(claimed.providerId);
        if (providerCircuit) {
          providerCircuit.probeInFlight = true;
          probes.push({ scope: "provider", providerId: claimed.providerId });
          this.emitEvent(
            "experiment.dispatch.probing",
            "info",
            "供应商冷却结束，正在用同一供应商的 1 个任务探测连接",
            {
              scope: "provider",
              providerId: claimed.providerId,
              runId: claimed.id,
              previousError: providerCircuit.error,
            },
          );
        }
        this.startRun(claimed, probes);
      }

      if (this.active.size === 0) {
        const summary = this.db.getSummary(this.experiment.id);
        const unfinished = summary.queued + summary.preparing + summary.running + summary.retrying;
        if (unfinished === 0) await this.finalize();
      }
    } finally {
      this.pumping = false;
    }
  }

  private hasCapacity(run: RunRecord, now = Date.now()): boolean {
    const circuit = this.providerCircuits.get(run.providerId);
    if (circuit && (now < circuit.blockedUntil || circuit.probeInFlight)) return false;
    const providerLimit =
      this.config.runtime.providerConcurrency[run.providerId] ??
      this.config.runtime.globalConcurrency;
    const modelLimit = this.modelById.get(run.modelId)?.concurrency ?? 1;
    return (
      (this.providerActive.get(run.providerId) ?? 0) < providerLimit &&
      (this.modelActive.get(run.modelId) ?? 0) < modelLimit
    );
  }

  private runnableScanLimit(): number {
    if (this.providerCircuits.size > 0) return 10_000;
    return Math.min(
      5_000,
      Math.max(
        256,
        this.config.runtime.globalConcurrency * 4,
        this.modelById.size * 2,
      ),
    );
  }

  private startRun(run: RunRecord, circuitProbes: InfrastructureProbe[]): void {
    const active: ActiveRun = {
      controller: new AbortController(),
      providerId: run.providerId,
      modelId: run.modelId,
      sessionId: null,
      workspacePath: null,
      completion: null,
      circuitProbes,
    };
    this.active.set(run.id, active);
    increment(this.providerActive, run.providerId);
    increment(this.modelActive, run.modelId);
    active.completion = this.executeRun(run, active).finally(() => {
      this.releaseCircuitProbeReservations(active);
      this.active.delete(run.id);
      decrement(this.providerActive, run.providerId);
      decrement(this.modelActive, run.modelId);
      if (this.cancelling && this.active.size === 0) {
        void this.finalize();
      } else {
        void this.pump();
      }
    });
  }

  private async executeRun(run: RunRecord, active: ActiveRun): Promise<void> {
    const task = this.taskById.get(run.taskId);
    const model = this.modelById.get(run.modelId);
    if (!task || !model) {
      const message = !task ? `任务定义不存在: ${run.taskId}` : `模型定义不存在: ${run.modelId}`;
      this.db.updateRun(run.id, { status: "failed", error: message });
      this.emitRunEvent(run.id, "run.failed", "error", message);
      return;
    }

    const emit: HarnessRunContext["emit"] = (type, level, message, data = {}) => {
      this.db.appendEvent(this.experiment.id, run.id, type, level, message, data);
    };

    try {
      const workspacePath = await prepareWorkspace(
        this.config,
        this.experiment,
        run,
        task,
        this.taskById.values(),
      );
      active.workspacePath = workspacePath;
      this.db.updateRun(run.id, { status: "running", workspacePath });
      this.emitRunEvent(run.id, "run.started", "info", "模型开始生成游戏", {
        taskId: run.taskId,
        modelId: run.modelId,
        attempt: run.attempt,
        workspacePath,
        startRound: run.currentRound + 1,
        targetRound: Math.min(this.experiment.targetRound, task.rounds.length),
      });

      const baseContext: HarnessRunContext = {
        run,
        model,
        task,
        workspacePath,
        signal: active.controller.signal,
        emit,
      };
      const sessionId = run.sessionId ?? await this.harness.beginRun(baseContext);
      active.sessionId = sessionId;
      this.db.updateRun(run.id, { sessionId });
      if (this.isCircuitProbe(active, "opencode")) {
        this.closeInfrastructureCircuit("opencode", run.id, run.providerId);
      }
      if (run.sessionId) {
        this.emitRunEvent(run.id, "harness.session.resumed", "info", "继续使用上一阶段的 OpenCode 会话", {
          sessionId,
          workspacePath,
          completedRounds: run.currentRound,
        });
      }

      const targetRound = Math.min(this.experiment.targetRound, task.rounds.length);
      const persistedRounds = this.db.getRounds(run.id);
      const firstIncompleteRound = persistedRounds.findIndex((round) => round.status !== "completed");
      const startRound = firstIncompleteRound === -1 ? targetRound : firstIncompleteRound;
      for (let roundIndex = startRound; roundIndex < targetRound; roundIndex += 1) {
        const round = task.rounds[roundIndex]!;
        if (active.controller.signal.aborted) throw active.controller.signal.reason;
        const timeoutMs = round.timeoutMs ?? this.config.runtime.roundTimeoutMs;
        const deadline = createDeadline(active.controller.signal, timeoutMs);
        this.db.updateRound(run.id, roundIndex, "running");
        this.db.updateRun(run.id, { currentRound: roundIndex + 1 });
        const roundContext: HarnessRunContext = { ...baseContext, signal: deadline.signal };
        try {
          const initializedContextPath = await this.archiveRoundContext(
            run.id,
            workspacePath,
            task,
            model,
            round,
            roundIndex,
            sessionId,
          );
          this.emitRunEvent(run.id, "round.context.initialized", "info", "已创建本轮上下文文件", {
            roundId: round.id,
            roundIndex,
            contextPath: initializedContextPath,
          });
          this.emitRunEvent(run.id, "round.started", "info", `开始第 ${roundIndex + 1} 轮 Prompt`, {
            roundId: round.id,
            roundIndex,
            timeoutMs: timeoutMs > 0 ? timeoutMs : null,
            unlimited: timeoutMs <= 0,
            contextPath: initializedContextPath,
          });
          const result = await this.harness.executeRound(
            roundContext,
            sessionId,
            round,
            roundIndex,
          );
          if (this.isCircuitProbe(active, "provider", run.providerId)) {
            this.closeInfrastructureCircuit("provider", run.id, run.providerId);
          }
          this.db.clearInfrastructureFailures(run.id);
          this.db.updateRound(run.id, roundIndex, "completed", {
            response: result.response,
            ...(result.usage ? { usage: result.usage } : {}),
          });
          const harnessContext = await this.captureHarnessRoundContext(
            roundContext,
            sessionId,
            round,
            roundIndex,
          );
          const contextPath = await this.archiveRoundContext(
            run.id,
            workspacePath,
            task,
            model,
            round,
            roundIndex,
            sessionId,
            result.usage,
            harnessContext,
          );
          this.emitRunEvent(run.id, "round.context.saved", "info", "本轮上下文已完整保存", {
            roundId: round.id,
            roundIndex,
            contextPath,
          });
          this.emitRunEvent(run.id, "round.completed", "info", `第 ${roundIndex + 1} 轮完成`, {
            roundId: round.id,
            roundIndex,
            usage: result.usage,
            contextPath,
          });
        } catch (error) {
          const message = errorMessage(error);
          this.db.updateRound(run.id, roundIndex, "failed", { error: message });
          const harnessContext = await this.captureHarnessRoundContext(
            roundContext,
            sessionId,
            round,
            roundIndex,
          );
          try {
            const contextPath = await this.archiveRoundContext(
              run.id,
              workspacePath,
              task,
              model,
              round,
              roundIndex,
              sessionId,
              undefined,
              harnessContext,
            );
            this.emitRunEvent(run.id, "round.context.saved", "warn", "失败轮次上下文已保存", {
              roundId: round.id,
              roundIndex,
              contextPath,
            });
          } catch (contextError) {
            throw new Error(`${message}; 轮次上下文写入失败: ${errorMessage(contextError)}`);
          }
          throw error;
        } finally {
          deadline.dispose();
        }
      }

      const runStatus = targetRound < task.rounds.length ? "awaiting_stage" : "completed";
      this.db.clearInfrastructureFailures(run.id);
      await writeAttemptResult(
        workspacePath,
        { ...this.db.getRun(run.id)!, sessionId },
        model,
        this.db.getRounds(run.id),
        runStatus,
        null,
      );
      this.db.updateRun(run.id, { status: runStatus, currentRound: targetRound, error: null });
      if (runStatus === "awaiting_stage") {
        this.emitRunEvent(run.id, "run.stage.completed", "info", `第 ${targetRound} 阶段生成完成，等待下一阶段`, {
          workspacePath,
          completedRounds: targetRound,
          totalRounds: task.rounds.length,
          sessionId,
        });
      } else {
        this.emitRunEvent(run.id, "run.completed", "info", "游戏全部阶段生成完成", {
          workspacePath,
          rounds: task.rounds.length,
          sessionId,
        });
      }
      await this.releaseHarnessRun(run.id, active, runStatus === "awaiting_stage");
    } catch (error) {
      const message = errorMessage(error);
      if (active.sessionId && active.workspacePath) {
        await this.harness.abortRun(active.sessionId, active.workspacePath);
      }
      if (this.shuttingDown) {
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "interrupted", message);
        this.emitRunEvent(run.id, "run.interrupted", "warn", "运行因框架关闭而中断，将在下次启动恢复");
        return;
      }
      if (this.cancelling || active.controller.signal.aborted) {
        this.db.updateRun(run.id, { status: "cancelled", error: message });
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "cancelled", message);
        this.emitRunEvent(run.id, "run.cancelled", "warn", "运行已取消", { error: message });
        await this.releaseHarnessRun(run.id, active, false);
        return;
      }
      if (isProviderAuthorizationBlock(message)) {
        const firstBlock = !this.paused;
        this.paused = true;
        this.db.retryRun(run.id, 0, message, { preserveProgress: true });
        if (firstBlock) {
          this.db.updateExperimentStatus(this.experiment.id, "paused", message);
          this.emitEvent(
            "experiment.provider.blocked",
            "error",
            "供应商额度或授权不可用，已暂停实验并保留所有现场等待人工处理",
            { providerId: run.providerId, error: message },
          );
        }
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        this.emitRunEvent(
          run.id,
          "run.provider.blocked",
          "error",
          "供应商额度或授权不可用，已保留工作区与 Session",
          { providerId: run.providerId, error: message },
        );
        await this.releaseHarnessRun(run.id, active, true);
        return;
      }
      if (isRecoverableUnknownFinish(message)) {
        const failureState = this.db.recordInfrastructureFailure(run.id);
        const retryExhausted =
          failureState.attempts >= MAXIMUM_INFRASTRUCTURE_FAILURES_PER_RUN ||
          (failureState.firstFailedAt !== null &&
            Date.now() - failureState.firstFailedAt >= MAXIMUM_INFRASTRUCTURE_OUTAGE_MS);
        if (retryExhausted) {
          this.db.updateRun(run.id, { status: "failed", error: message });
          await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message);
          this.emitRunEvent(
            run.id,
            "run.continuation.blocked",
            "error",
            "该任务连续断尾，已停止单任务自动续作并保留现场等待人工处理",
            {
              error: message,
              continuationAttempts: failureState.attempts,
              firstFailedAt: failureState.firstFailedAt,
              maximumAttempts: MAXIMUM_INFRASTRUCTURE_FAILURES_PER_RUN,
              maximumDurationMs: MAXIMUM_INFRASTRUCTURE_OUTAGE_MS,
            },
          );
          await this.releaseHarnessRun(run.id, active, false);
          return;
        }
        const delayMs = Math.min(
          MAXIMUM_INFRASTRUCTURE_COOLDOWN_MS,
          this.config.runtime.retryBackoffMs * 2 ** Math.max(failureState.attempts - 1, 0),
        );
        this.db.retryRun(run.id, delayMs, message, { preserveProgress: true });
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        this.emitRunEvent(
          run.id,
          "run.continuation.retrying",
          "warn",
          "该任务连续断尾，已保留 Session 与产物等待单任务续作；其他任务继续补满并发",
          {
            error: message,
            continuationAttempts: failureState.attempts,
            remainingRetries: MAXIMUM_INFRASTRUCTURE_FAILURES_PER_RUN - failureState.attempts,
            delayMs,
          },
        );
        await this.releaseHarnessRun(run.id, active, true);
        return;
      }
      const infrastructureScope = classifyInfrastructureFailure(message);
      if (infrastructureScope) {
        const failureState = this.db.recordInfrastructureFailure(run.id);
        const infrastructureExhausted =
          failureState.attempts >= MAXIMUM_INFRASTRUCTURE_FAILURES_PER_RUN ||
          (failureState.firstFailedAt !== null &&
            Date.now() - failureState.firstFailedAt >= MAXIMUM_INFRASTRUCTURE_OUTAGE_MS);
        const delayMs = this.tripInfrastructureCircuit(
          infrastructureScope,
          run.providerId,
          message,
          this.isCircuitProbe(active, infrastructureScope, run.providerId),
        );
        if (infrastructureExhausted) {
          this.db.updateRun(run.id, { status: "failed", error: message });
          await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message);
          this.emitRunEvent(
            run.id,
            "run.infrastructure.blocked",
            "error",
            "基础设施持续不可用，已停止自动重试并等待人工处理",
            {
              error: message,
              scope: infrastructureScope,
              providerId: infrastructureScope === "provider" ? run.providerId : null,
              infrastructureAttempts: failureState.attempts,
              firstFailedAt: failureState.firstFailedAt,
              maximumAttempts: MAXIMUM_INFRASTRUCTURE_FAILURES_PER_RUN,
              maximumOutageMs: MAXIMUM_INFRASTRUCTURE_OUTAGE_MS,
            },
          );
          await this.releaseHarnessRun(run.id, active, false);
          return;
        }
        this.db.retryRun(run.id, delayMs, message, { preserveProgress: true });
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        this.emitRunEvent(run.id, "run.infrastructure.retrying", "warn", "基础设施连接失败，已熔断对应线路并保留已完成进度", {
          error: message,
          attempt: run.attempt,
          maxAttempts: run.maxAttempts,
          infrastructureAttempts: failureState.attempts,
          remainingInfrastructureRetries:
            MAXIMUM_INFRASTRUCTURE_FAILURES_PER_RUN - failureState.attempts,
          delayMs,
          scope: infrastructureScope,
          providerId: infrastructureScope === "provider" ? run.providerId : null,
        });
        await this.releaseHarnessRun(run.id, active, true);
        return;
      }
      if (this.isCircuitProbe(active, "provider", run.providerId)) {
        this.closeInfrastructureCircuit("provider", run.id, run.providerId);
      }
      this.db.clearInfrastructureFailures(run.id);
      if (run.attempt < run.maxAttempts) {
        const delayMs = this.config.runtime.retryBackoffMs * 2 ** Math.max(run.attempt - 1, 0);
        const repairInPlace = isRepairableArtifactFailure(message);
        this.db.retryRun(run.id, delayMs, message, { preserveSession: repairInPlace });
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        this.emitRunEvent(
          run.id,
          "run.retrying",
          "warn",
          repairInPlace
            ? "产物验收失败，已保留工作区与 Session 等待原地修复"
            : "运行失败，等待自动重试",
          {
            error: message,
            attempt: run.attempt,
            nextAttempt: run.attempt + 1,
            delayMs,
            repairInPlace,
          },
        );
        await this.releaseHarnessRun(run.id, active, repairInPlace);
      } else {
        this.db.updateRun(run.id, { status: "failed", error: message });
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message);
        this.emitRunEvent(run.id, "run.failed", "error", "运行达到最大重试次数", {
          error: message,
          attempts: run.attempt,
        });
        await this.releaseHarnessRun(run.id, active, false);
      }
    }
  }

  private tripInfrastructureCircuit(
    scope: InfrastructureScope,
    providerId: string,
    error: string,
    probeFailure: boolean,
  ): number {
    const now = Date.now();
    const previous = scope === "opencode"
      ? this.openCodeCircuit
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
      baseDelayMs * 2 ** Math.max(failureCount - 1, 0),
    );
    const blockedUntil = reopening ? now + delayMs : previous.blockedUntil;
    const circuit: InfrastructureCircuit = {
      scope,
      failureCount,
      blockedUntil,
      probeInFlight: false,
      error,
    };
    if (scope === "opencode") this.openCodeCircuit = circuit;
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

  private closeInfrastructureCircuit(
    scope: InfrastructureScope,
    runId: string,
    providerId: string,
  ): void {
    const circuit = scope === "opencode"
      ? this.openCodeCircuit
      : this.providerCircuits.get(providerId) ?? null;
    if (!circuit) return;
    if (scope === "opencode") this.openCodeCircuit = null;
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
    void this.pump();
  }

  private isCircuitProbe(
    active: ActiveRun,
    scope: InfrastructureScope,
    providerId?: string,
  ): boolean {
    return active.circuitProbes.some(
      (probe) => probe.scope === scope &&
        (scope !== "provider" || probe.providerId === providerId),
    );
  }

  private releaseCircuitProbeReservations(active: ActiveRun): void {
    for (const probe of active.circuitProbes) {
      if (probe.scope === "opencode") {
        if (this.openCodeCircuit) this.openCodeCircuit.probeInFlight = false;
      } else if (probe.providerId) {
        const circuit = this.providerCircuits.get(probe.providerId);
        if (circuit) circuit.probeInFlight = false;
      }
    }
  }

  private restoreInfrastructureCircuits(): void {
    const now = Date.now();
    for (const run of this.db.listRuns(this.experiment.id)) {
      if (run.status !== "retrying" || !run.error) continue;
      const failureState = this.db.getInfrastructureRetryState(run.id);
      if (failureState.attempts === 0) continue;
      const scope = classifyInfrastructureFailure(run.error);
      if (!scope) continue;
      const restored: InfrastructureCircuit = {
        scope,
        failureCount: failureState.attempts,
        blockedUntil: Math.max(now, run.availableAt),
        probeInFlight: false,
        error: run.error,
      };
      if (scope === "opencode") {
        if (!this.openCodeCircuit || restored.blockedUntil > this.openCodeCircuit.blockedUntil) {
          this.openCodeCircuit = restored;
        }
      } else {
        const previous = this.providerCircuits.get(run.providerId);
        if (!previous || restored.blockedUntil > previous.blockedUntil) {
          this.providerCircuits.set(run.providerId, restored);
        }
      }
    }
  }

  private async releaseHarnessRun(
    runId: string,
    active: ActiveRun,
    preserveSession: boolean,
  ): Promise<void> {
    if (!active.workspacePath || !this.harness.releaseRun) return;
    try {
      await this.harness.releaseRun(active.sessionId, active.workspacePath, { preserveSession });
      this.emitRunEvent(
        runId,
        "harness.workspace.released",
        "debug",
        preserveSession ? "已释放 OpenCode 工作区实例并保留阶段会话" : "已释放 OpenCode 会话与工作区实例",
        { preserveSession },
      );
    } catch (error) {
      this.emitRunEvent(runId, "harness.workspace.release.failed", "warn", "OpenCode 资源释放失败", {
        error: errorMessage(error),
        preserveSession,
      });
    }
  }

  private async finalize(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.stopTick();
    const summary = this.db.getSummary(this.experiment.id);
    let finalStatus: ExperimentRecord["status"] = this.cancelling
      ? "cancelled"
      : summary.failed > 0
        ? "failed"
        : summary.cancelled > 0
          ? "cancelled"
          : summary.awaitingStage > 0
            ? "awaiting_stage"
            : "completed";
    let finalError: string | null = null;
    try {
      await this.harness.stop();
    } catch (error) {
      finalStatus = "failed";
      finalError = `OpenCode 服务关闭失败: ${errorMessage(error)}`;
      this.emitEvent("experiment.harness.stop.failed", "error", finalError);
    }
    try {
      await writeExperimentManifest(
        this.config,
        {
          ...this.experiment,
          status: finalStatus,
          completedAt: finalStatus === "awaiting_stage" ? null : Date.now(),
          error: finalError,
        },
        this.db.listRuns(this.experiment.id),
        summary,
      );
    } catch (error) {
      finalStatus = "failed";
      finalError = `结果清单写入失败: ${errorMessage(error)}`;
      this.emitEvent("experiment.manifest.failed", "error", finalError);
    }
    this.emitEvent(
      `experiment.${finalStatus}`,
      finalStatus === "completed" || finalStatus === "awaiting_stage"
        ? "info"
        : finalStatus === "failed"
          ? "error"
          : "warn",
      finalStatus === "completed"
        ? "全部游戏的所有阶段生成完成"
        : finalStatus === "awaiting_stage"
          ? `第 ${this.experiment.targetRound} 阶段全部完成，等待手动启动下一阶段`
          : finalStatus === "failed"
            ? "生成任务结束，但存在失败运行"
            : "生成任务已取消",
      {
        ...summary,
        targetRound: this.experiment.targetRound,
        maxRounds: this.experiment.maxRounds,
      },
    );
    this.db.updateExperimentStatus(this.experiment.id, finalStatus, finalError);
    this.experiment = this.db.getExperiment(this.experiment.id)!;
    this.completionResolve(this.experiment);
    this.emit("settled", this.experiment);
  }

  private async finishWithError(error: Error): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.stopTick();
    await this.harness.stop().catch(() => undefined);
    this.experiment = this.db.getExperiment(this.experiment.id)!;
    await this.writeManifest().catch(() => undefined);
    this.completionResolve(this.experiment);
    this.emit("settled", this.experiment);
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  private async writeManifest(): Promise<void> {
    await writeExperimentManifest(
      this.config,
      this.experiment,
      this.db.listRuns(this.experiment.id),
      this.db.getSummary(this.experiment.id),
    );
  }

  private async writeAttemptResultSafely(
    runId: string,
    workspacePath: string | null,
    status: string,
    error: string | null,
    willRetry = false,
  ): Promise<void> {
    if (!workspacePath) return;
    const run = this.db.getRun(runId);
    if (!run) return;
    try {
      await writeAttemptResult(
        workspacePath,
        run,
        this.modelById.get(run.modelId),
        this.db.getRounds(runId),
        status,
        error,
        willRetry,
      );
    } catch (writeError) {
      this.emitRunEvent(runId, "run.result.failed", "error", "本次运行结果清单写入失败", {
        error: errorMessage(writeError),
        workspacePath,
      });
    }
  }

  private async archiveRoundContext(
    runId: string,
    workspacePath: string,
    task: TaskDefinition,
    model: ModelConfig,
    round: RoundDefinition,
    roundIndex: number,
    sessionId: string,
    usage?: HarnessRoundResult["usage"],
    harnessContext?: unknown,
  ): Promise<string> {
    const run = this.db.getRun(runId);
    const allRounds = this.db.getRounds(runId);
    const roundRecord = allRounds[roundIndex];
    if (!run || !roundRecord) throw new Error(`轮次上下文来源不存在: ${runId}#${roundIndex + 1}`);
    return writeRoundContext({
      config: this.config,
      workspacePath,
      run,
      task,
      model,
      round,
      roundRecord,
      allRounds,
      sessionId,
      usage,
      harnessContext,
    });
  }

  private async captureHarnessRoundContext(
    context: HarnessRunContext,
    sessionId: string,
    round: RoundDefinition,
    roundIndex: number,
  ): Promise<unknown> {
    if (!this.harness.captureRoundContext) return null;
    try {
      return await this.harness.captureRoundContext(context, sessionId, round, roundIndex);
    } catch (error) {
      return {
        type: "harness.context.capture-error",
        capturedAt: new Date().toISOString(),
        error: errorMessage(error),
      };
    }
  }

  private emitEvent(
    type: string,
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data: Record<string, unknown> = {},
  ): void {
    this.db.appendEvent(this.experiment.id, null, type, level, message, data);
  }

  private emitRunEvent(
    runId: string,
    type: string,
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data: Record<string, unknown> = {},
  ): void {
    this.db.appendEvent(this.experiment.id, runId, type, level, message, data);
  }
}

function isRepairableArtifactFailure(message: string): boolean {
  return message.trimStart().startsWith("生成结果无效：");
}

function createDeadline(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason ?? new Error("运行已取消"));
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        controller.abort(new Error(`轮次执行超过硬超时 ${timeoutMs}ms`));
      }, timeoutMs)
    : null;
  timer?.unref();
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "未知错误");
}

function classifyInfrastructureFailure(message: string): InfrastructureScope | null {
  if (/unknown certificate verification|certificate verify failed|\b429\b|rate.?limit|too many requests|\b50[234]\b|service unavailable|temporarily unavailable|stream_read_error|upstream_error|server_error|upstream.*(?:error|timeout)|overloaded/i.test(message)) {
    return "provider";
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR|socket hang up|before secure TLS connection|operation was aborted due to timeout|OpenCode 状态连接连续失败/i.test(message)) {
    return "opencode";
  }
  return null;
}

function isRecoverableUnknownFinish(message: string): boolean {
  return /OpenCode 上游响应连续异常结束：finish=unknown/i.test(message);
}

function isProviderAuthorizationBlock(message: string): boolean {
  return /insufficient_user_quota|insufficient[_ -]?quota|quota[_ -]?exceeded|(?:用户|账户|账号)?额度不足|余额不足|billing.*(?:disabled|limit|quota)|invalid[_ -]?api[_ -]?key|authentication.*(?:failed|required)|unauthorized.*(?:api|key|account)/i.test(
    message,
  );
}
