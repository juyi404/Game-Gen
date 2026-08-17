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
  circuitProbe: boolean;
}

type InfrastructureScope = "opencode" | "provider";

interface InfrastructureCircuit {
  scope: InfrastructureScope;
  failureCount: number;
  blockedUntil: number;
  probeInFlight: boolean;
  error: string;
}

const MINIMUM_INFRASTRUCTURE_COOLDOWN_MS = 60_000;
const MAXIMUM_INFRASTRUCTURE_COOLDOWN_MS = 5 * 60_000;

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
  private infrastructureCircuit: InfrastructureCircuit | null = null;
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
      if (this.infrastructureCircuit) {
        if (now < this.infrastructureCircuit.blockedUntil) return;
        if (this.infrastructureCircuit.probeInFlight || this.active.size > 0) return;
      }
      const runnable = this.db.listRunnableRuns(
        this.experiment.id,
        now,
        this.runnableScanLimit(),
      );
      if (this.infrastructureCircuit) {
        const probe = runnable.find((run) => this.hasCapacity(run));
        if (probe) {
          const claimed = this.db.claimRun(probe.id);
          if (claimed) {
            this.infrastructureCircuit.probeInFlight = true;
            this.emitEvent(
              "experiment.dispatch.probing",
              "info",
              "基础设施冷却结束，正在用 1 个任务探测连接",
              {
                scope: this.infrastructureCircuit.scope,
                runId: claimed.id,
                previousError: this.infrastructureCircuit.error,
              },
            );
            this.startRun(claimed, true);
          }
        }
        return;
      }
      for (const run of runnable) {
        if (this.active.size >= this.config.runtime.globalConcurrency) break;
        if (!this.hasCapacity(run)) continue;
        const claimed = this.db.claimRun(run.id);
        if (!claimed) continue;
        this.startRun(claimed, false);
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

  private hasCapacity(run: RunRecord): boolean {
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
    return Math.min(
      5_000,
      Math.max(
        256,
        this.config.runtime.globalConcurrency * 4,
        this.modelById.size * 2,
      ),
    );
  }

  private startRun(run: RunRecord, circuitProbe: boolean): void {
    const active: ActiveRun = {
      controller: new AbortController(),
      providerId: run.providerId,
      modelId: run.modelId,
      sessionId: null,
      workspacePath: null,
      completion: null,
      circuitProbe,
    };
    this.active.set(run.id, active);
    increment(this.providerActive, run.providerId);
    increment(this.modelActive, run.modelId);
    active.completion = this.executeRun(run, active).finally(() => {
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
      if (active.circuitProbe) this.closeInfrastructureCircuit("opencode", run.id);
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
        const deadline = createDeadline(active.controller.signal);
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
            timeoutMs: null,
            unlimited: true,
            contextPath: initializedContextPath,
          });
          const result = await this.harness.executeRound(
            roundContext,
            sessionId,
            round,
            roundIndex,
          );
          if (active.circuitProbe) this.closeInfrastructureCircuit("provider", run.id);
          this.db.updateRound(run.id, roundIndex, "completed", { response: result.response });
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
      const infrastructureScope = classifyInfrastructureFailure(message);
      if (infrastructureScope) {
        const delayMs = this.tripInfrastructureCircuit(
          infrastructureScope,
          message,
          active.circuitProbe,
        );
        this.db.retryRun(run.id, delayMs, message, { preserveAttemptBudget: true });
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        const updated = this.db.getRun(run.id);
        this.emitRunEvent(run.id, "run.infrastructure.retrying", "warn", "基础设施连接失败，已熔断派发并保留生成尝试额度", {
          error: message,
          attempt: run.attempt,
          nextAttempt: run.attempt + 1,
          maxAttempts: updated?.maxAttempts ?? run.maxAttempts + 1,
          delayMs,
          scope: infrastructureScope,
        });
        await this.releaseHarnessRun(run.id, active, false);
        return;
      }
      if (active.circuitProbe) this.closeInfrastructureCircuit("provider", run.id);
      if (run.attempt < run.maxAttempts) {
        const delayMs = this.config.runtime.retryBackoffMs * 2 ** Math.max(run.attempt - 1, 0);
        this.db.retryRun(run.id, delayMs, message);
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        this.emitRunEvent(run.id, "run.retrying", "warn", "运行失败，等待自动重试", {
          error: message,
          attempt: run.attempt,
          nextAttempt: run.attempt + 1,
          delayMs,
        });
      } else {
        this.db.updateRun(run.id, { status: "failed", error: message });
        await this.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message);
        this.emitRunEvent(run.id, "run.failed", "error", "运行达到最大重试次数", {
          error: message,
          attempts: run.attempt,
        });
      }
      await this.releaseHarnessRun(run.id, active, false);
    }
  }

  private tripInfrastructureCircuit(
    scope: InfrastructureScope,
    error: string,
    probeFailure: boolean,
  ): number {
    const now = Date.now();
    const previous = this.infrastructureCircuit;
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
    this.infrastructureCircuit = {
      scope,
      failureCount,
      blockedUntil,
      probeInFlight: false,
      error,
    };
    if (reopening) {
      this.emitEvent(
        "experiment.dispatch.cooldown",
        "warn",
        "检测到基础设施连接故障，已暂停派发并进入冷却",
        { scope, error, delayMs, blockedUntil, failureCount },
      );
    }
    return Math.max(1_000, blockedUntil - now);
  }

  private closeInfrastructureCircuit(scope: InfrastructureScope, runId: string): void {
    const circuit = this.infrastructureCircuit;
    if (!circuit) return;
    if (circuit.scope === "provider" && scope !== "provider") return;
    this.infrastructureCircuit = null;
    this.emitEvent(
      "experiment.dispatch.recovered",
      "info",
      "基础设施连接已恢复，继续按并发上限派发",
      { scope: circuit.scope, probeRunId: runId, failureCount: circuit.failureCount },
    );
    void this.pump();
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

function createDeadline(parent: AbortSignal): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason ?? new Error("运行已取消"));
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
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
