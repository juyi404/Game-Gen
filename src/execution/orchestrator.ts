import { EventEmitter } from "node:events";
import type { ExperimentRecord, GenerationHarness, ModelConfig, ResolvedBenchmarkConfig, RunRecord, TaskDefinition } from "../domain/types.js";
import { createHarness } from "../harness/index.js";
import type { BenchmarkDatabase } from "../persistence/database.js";
import { writeExperimentManifest } from "../persistence/workspace.js";
import { decrement, increment } from "./concurrency.js";
import type { ActiveRun, InfrastructureProbe } from "./contracts.js";
import { errorMessage } from "./errors.js";
import { InfrastructureRecovery } from "./infrastructure-recovery.js";
import { RunArchive } from "./run-archive.js";
import { RunExecutor } from "./run-executor.js";

export { MAXIMUM_INFRASTRUCTURE_COOLDOWN_MS, MAXIMUM_INFRASTRUCTURE_OUTAGE_MS, MINIMUM_INFRASTRUCTURE_COOLDOWN_MS } from "./infrastructure-recovery.js";

export class GenerationOrchestrator extends EventEmitter {
  private readonly taskById: Map<string, TaskDefinition>;
  private readonly modelById: Map<string, ModelConfig>;
  private readonly active = new Map<string, ActiveRun>();
  private readonly providerActive = new Map<string, number>();
  private readonly modelActive = new Map<string, number>();
  private readonly harness: GenerationHarness;
  private readonly archive: RunArchive;
  private experiment: ExperimentRecord;
  private tick: NodeJS.Timeout | null = null;
  private pumping = false;
  private started = false;
  private paused = false;
  private cancelling = false;
  private shuttingDown = false;
  private settled = false;
  private finalizing = false;
  private shutdownCompletion: Promise<void> | null = null;
  private readonly recovery: InfrastructureRecovery;
  private readonly executor: RunExecutor;

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
    this.archive = new RunArchive(db, config, this.modelById, this.harness,
      (...args) => this.emitRunEvent(...args));
    this.recovery = new InfrastructureRecovery(db, experiment.id, config, this.harness,
      (...args) => this.emitEvent(...args), (...args) => this.emitRunEvent(...args),
      () => this.shuttingDown || this.cancelling, () => { void this.pump(); });
    this.executor = new RunExecutor(db, config, this.taskById, this.modelById, this.harness,
      this.archive, this.recovery, {
        experiment: () => this.experiment,
        isShuttingDown: () => this.shuttingDown,
        isCancelling: () => this.cancelling,
        pauseForAuthorization: (providerId, message) => this.pauseForAuthorization(providerId, message),
      }, (...args) => this.emitRunEvent(...args));
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
      this.recovery.restoreInfrastructureCircuits();
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
    if (this.settled || this.finalizing || this.cancelling) return;
    this.paused = true;
    this.db.updateExperimentStatus(this.experiment.id, "paused");
    this.experiment = this.db.getExperiment(this.experiment.id)!;
    this.emitEvent("experiment.paused", "info", "已暂停派发新任务；正在运行的任务会继续完成");
  }

  resume(): void {
    if (this.settled || this.finalizing || this.cancelling) return;
    this.paused = false;
    this.db.updateExperimentStatus(this.experiment.id, "running");
    this.experiment = this.db.getExperiment(this.experiment.id)!;
    this.emitEvent("experiment.resumed", "info", "生成实验已恢复");
    void this.pump();
  }

  async requestRunFinalization(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active?.sessionId || !active.workspacePath) {
      throw new Error("该运行当前没有可收尾的活动 执行器会话");
    }
    if (!this.harness.requestFinalize) {
      throw new Error("当前生成 Harness 不支持显式收尾");
    }
    this.emitRunEvent(
      runId,
      "run.finalization.requested",
      "info",
      "用户要求停止继续修改并按现有产物收尾",
      { sessionId: active.sessionId, workspacePath: active.workspacePath },
    );
    await this.harness.requestFinalize(active.sessionId, active.workspacePath);
  }

  async cancel(): Promise<void> {
    if (this.settled || this.finalizing || this.cancelling) return;
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

  shutdown(): Promise<void> {
    this.shutdownCompletion ??= this.shutdownOnce();
    return this.shutdownCompletion;
  }

  private async shutdownOnce(): Promise<void> {
    if (this.settled || this.finalizing) {
      await this.completion;
      return;
    }
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
    // Cancelling runs can enter finalization while shutdown waits for them.
    if (this.finalizing || this.settled) await this.completion;
    else await this.harness.stop();
  }

  private pauseForAuthorization(providerId: string, message: string): void {
    if (this.paused) return;
    this.paused = true;
    this.db.updateExperimentStatus(this.experiment.id, "paused", message);
    this.experiment = this.db.getExperiment(this.experiment.id)!;
    this.emitEvent("experiment.provider.blocked", "error",
      "供应商额度或授权不可用，已暂停实验并保留所有现场等待人工处理",
      { providerId, error: message });
  }

  private async pump(): Promise<void> {
    if (
      this.pumping ||
      this.paused ||
      this.cancelling ||
      this.shuttingDown ||
      this.finalizing ||
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
      if (this.recovery.engine) {
        if (now < this.recovery.engine.blockedUntil) return;
        if (this.recovery.engine.probeInFlight || this.active.size > 0) return;
      }
      const runnable = this.db.listRunnableRuns(
        this.experiment.id,
        now,
        this.runnableScanLimit(),
      );
      if (this.recovery.engine) {
        const probe = runnable.find((run) => this.hasCapacity(run, now));
        if (probe && await this.recovery.checkCircuitTransport(probe, "engine")) {
          if (this.paused || this.shuttingDown || this.cancelling) return;
          const claimed = this.db.claimRun(probe.id);
          if (claimed) {
            const probes = this.recovery.reserveProbes(claimed, true, now);
            this.startRun(claimed, probes);
          }
        }
        return;
      }
      for (const run of runnable) {
        if (this.active.size >= this.config.runtime.globalConcurrency) break;
        if (!this.hasCapacity(run, now)) continue;
        if (this.recovery.hasProviderCircuit(run.providerId)
          && !await this.recovery.checkCircuitTransport(run, "provider")) continue;
        if (this.paused || this.shuttingDown || this.cancelling) return;
        const claimed = this.db.claimRun(run.id);
        if (!claimed) continue;
        const probes = this.recovery.reserveProbes(claimed, false, now);
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
    if (!this.recovery.canDispatchProvider(run.providerId, now)) return false;
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
    if (this.recovery.hasProviderCircuits) return 10_000;
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
    active.completion = this.executor.executeRun(run, active).finally(() => {
      this.recovery.releaseCircuitProbeReservations(active.circuitProbes);
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

  private async finalize(): Promise<void> {
    if (this.settled || this.finalizing) {
      await this.completion;
      return;
    }
    this.finalizing = true;
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
      finalError = `执行器服务关闭失败: ${errorMessage(error)}`;
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
    this.settled = true;
    this.completionResolve(this.experiment);
    this.emit("settled", this.experiment);
  }

  private async finishWithError(error: Error): Promise<void> {
    if (this.settled || this.finalizing) {
      await this.completion;
      return;
    }
    this.finalizing = true;
    this.stopTick();
    await this.harness.stop().catch(() => undefined);
    this.experiment = this.db.getExperiment(this.experiment.id)!;
    await this.writeManifest().catch(() => undefined);
    this.settled = true;
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
