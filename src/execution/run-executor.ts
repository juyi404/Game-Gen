import { harnessFailure } from "../domain/harness-failure.js";
import type { ExperimentRecord, GenerationHarness, HarnessRunContext, ModelConfig, ResolvedBenchmarkConfig, RunRecord, TaskDefinition } from "../domain/types.js";
import type { BenchmarkDatabase } from "../persistence/database.js";
import { prepareWorkspace, writeAttemptResult } from "../persistence/workspace.js";
import type { ActiveRun } from "./contracts.js";
import { createDeadline } from "./deadline.js";
import { errorMessage } from "./errors.js";
import { classifyInfrastructureFailure, isHardRoundTimeout, isProviderAuthorizationBlock, isRecoverableIncompleteOutput, isRepairableArtifactFailure } from "./failure-policy.js";
import type { InfrastructureRecovery } from "./infrastructure-recovery.js";
import type { RunArchive } from "./run-archive.js";

export interface RunLifecycle {
  experiment(): ExperimentRecord;
  isShuttingDown(): boolean;
  isCancelling(): boolean;
  pauseForAuthorization(providerId: string, message: string): void;
}

/** Owns state transitions of claimed runs and rounds; never dispatches or finalizes an experiment. */
export class RunExecutor {
  constructor(
    private readonly db: BenchmarkDatabase,
    private readonly config: ResolvedBenchmarkConfig,
    private readonly taskById: ReadonlyMap<string, TaskDefinition>,
    private readonly modelById: ReadonlyMap<string, ModelConfig>,
    private readonly harness: GenerationHarness,
    private readonly archive: RunArchive,
    private readonly recovery: InfrastructureRecovery,
    private readonly lifecycle: RunLifecycle,
    private readonly emitRunEvent: (runId: string, ...args: Parameters<HarnessRunContext["emit"]>) => void,
  ) {}
  private get experiment(): ExperimentRecord { return this.lifecycle.experiment(); }

  async executeRun(run: RunRecord, active: ActiveRun): Promise<void> {
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
        reportHealthy: (scope) => this.recovery.acknowledgeInfrastructureProbe(active.circuitProbes, scope, run.id, run.providerId),
      };
      const sessionId = run.sessionId ?? await this.harness.beginRun(baseContext);
      active.sessionId = sessionId;
      this.db.updateRun(run.id, { sessionId });
      this.recovery.acknowledgeInfrastructureProbe(active.circuitProbes, "engine", run.id, run.providerId);
      if (run.sessionId) {
        this.emitRunEvent(run.id, "harness.session.resumed", "info", "继续使用上一阶段的 执行器会话", {
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
        const timeoutMs = model.roundTimeoutMs
          ?? round.timeoutMs
          ?? this.config.runtime.roundTimeoutMs;
        const deadline = createDeadline(active.controller.signal, timeoutMs);
        this.db.updateRound(run.id, roundIndex, "running");
        this.db.updateRun(run.id, { currentRound: roundIndex + 1 });
        const roundContext: HarnessRunContext = {
          ...baseContext, signal: deadline.signal,
          run: { ...run, resumePending: run.resumePending && roundIndex === startRound },
        };
        try {
          const initializedContextPath = await this.archive.archiveRoundContext(
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
          this.recovery.acknowledgeInfrastructureProbe(active.circuitProbes, "provider", run.id, run.providerId);
          this.db.clearInfrastructureFailures(run.id);
          this.db.updateRound(run.id, roundIndex, "completed", {
            response: result.response,
            ...(result.usage ? { usage: result.usage } : {}),
          });
          const harnessContext = await this.archive.captureHarnessRoundContext(
            roundContext,
            sessionId,
            round,
            roundIndex,
          );
          const contextPath = await this.archive.archiveRoundContext(
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
          const harnessContext = await this.archive.captureHarnessRoundContext(
            roundContext,
            sessionId,
            round,
            roundIndex,
          );
          try {
            const contextPath = await this.archive.archiveRoundContext(
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
            this.emitRunEvent(run.id, "round.context.failed", "error", "轮次上下文写入失败", { error: errorMessage(contextError) });
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
      if (this.lifecycle.isShuttingDown()) {
        await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "interrupted", message);
        this.emitRunEvent(run.id, "run.interrupted", "warn", "运行因框架关闭而中断，将在下次启动恢复");
        return;
      }
      if (this.lifecycle.isCancelling() || active.controller.signal.aborted) {
        this.db.updateRun(run.id, { status: "cancelled", error: message });
        await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "cancelled", message);
        this.emitRunEvent(run.id, "run.cancelled", "warn", "运行已取消", { error: message });
        await this.releaseHarnessRun(run.id, active, false);
        return;
      }
      if (Date.now() >= this.recovery.initialBuildDeadline(run)) {
        this.db.updateRun(run.id, { status: "failed", error: message });
        await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        this.emitRunEvent(run.id, "run.delivery.blocked", "error", "生成时间预算已到，本轮未完成；已保留产物和 Session，停止自动重试等待人工决定", { error: message });
        await this.releaseHarnessRun(run.id, active, true);
        return;
      }
      if (isProviderAuthorizationBlock(error)) {
        this.lifecycle.pauseForAuthorization(run.providerId, message);
        this.db.retryRun(run.id, 0, message, { preserveProgress: true });
        await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
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
      if (isRecoverableIncompleteOutput(error)) {
        const failureState = this.db.recordInfrastructureFailure(run.id, Date.now(), undefined, "incomplete");
        const retryExhausted = this.recovery.recoveryBudgetExpired(run, failureState.firstFailedAt);
        if (retryExhausted) {
          this.db.updateRun(run.id, { status: "failed", error: message });
          await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message);
          this.emitRunEvent(
            run.id,
            "run.continuation.blocked",
            "error",
            "该任务已到生成时间预算，已停止自动续写并保留产物和 Session",
            {
              error: message,
              continuationAttempts: failureState.attempts,
              firstFailedAt: failureState.firstFailedAt,
              timeBudgetMs: this.recovery.recoveryBudgetMs(run),
            },
          );
          await this.releaseHarnessRun(run.id, active, true);
          return;
        }
        const delayMs = this.recovery.recoveryDelayMs(run, failureState.attempts);
        this.db.retryRun(run.id, delayMs, message, { preserveProgress: true });
        await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        this.emitRunEvent(
          run.id,
          "run.continuation.retrying",
          "warn",
          "该任务断尾，已保留 Session 与产物自动续跑；恢复后不再嵌套续写",
          {
            error: message,
            continuationAttempts: failureState.attempts,
            automaticRecovery: true,
            delayMs,
          },
        );
        await this.releaseHarnessRun(run.id, active, true);
        return;
      }
      const infrastructureScope = classifyInfrastructureFailure(error);
      if (infrastructureScope) {
        const failureState = this.db.recordInfrastructureFailure(run.id, Date.now(), infrastructureScope);
        const infrastructureExhausted = this.recovery.recoveryBudgetExpired(run, failureState.firstFailedAt);
        const delayMs = this.recovery.tripInfrastructureCircuit(
          infrastructureScope,
          run.providerId,
          message,
          this.recovery.isCircuitProbe(active.circuitProbes, infrastructureScope, run.providerId),
        );
        if (infrastructureExhausted) {
          this.db.updateRun(run.id, { status: "failed", error: message });
          await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message);
          this.emitRunEvent(
            run.id,
            "run.infrastructure.blocked",
            "error",
            "基础设施故障持续到生成时间预算结束，已保留产物和 Session",
            {
              error: message,
              scope: infrastructureScope,
              providerId: infrastructureScope === "provider" ? run.providerId : null,
              infrastructureAttempts: failureState.attempts,
              firstFailedAt: failureState.firstFailedAt,
              timeBudgetMs: this.recovery.recoveryBudgetMs(run),
            },
          );
          await this.releaseHarnessRun(run.id, active, true);
          return;
        }
        const runDelayMs = Math.max(delayMs, this.recovery.recoveryDelayMs(run, failureState.attempts));
        this.db.retryRun(run.id, runDelayMs, message, { preserveProgress: true });
        await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        this.emitRunEvent(run.id, "run.infrastructure.retrying", "warn", "基础设施连接失败，已熔断对应线路并保留已完成进度", {
          error: message,
          attempt: run.attempt,
          maxAttempts: run.maxAttempts,
          infrastructureAttempts: failureState.attempts,
          automaticRecovery: true,
          delayMs: runDelayMs,
          scope: infrastructureScope,
          providerId: infrastructureScope === "provider" ? run.providerId : null,
        });
        await this.releaseHarnessRun(run.id, active, true);
        return;
      }
      this.recovery.acknowledgeInfrastructureProbe(active.circuitProbes, "provider", run.id, run.providerId);
      this.db.clearInfrastructureFailures(run.id);
      if (harnessFailure(error).retryable && run.attempt < run.maxAttempts) {
        const delayMs = this.config.runtime.retryBackoffMs * 2 ** Math.max(run.attempt - 1, 0);
        const repairInPlace = isRepairableArtifactFailure(error) || isHardRoundTimeout(error);
        this.db.retryRun(run.id, delayMs, message, {
          preserveProgress: true,
          preserveSession: true,
          incrementAttempt: true,
        });
        await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message, true);
        this.emitRunEvent(
          run.id,
          "run.retrying",
          "warn",
          isHardRoundTimeout(error)
            ? "轮次达到硬超时，已保留工作区与 Session 等待原会话续跑"
            : repairInPlace
              ? "产物验收失败，已保留工作区与 Session 等待原地修复"
              : "运行失败，已保留原工作区与 Session 等待续跑",
          {
            error: message,
            attempt: run.attempt,
            nextAttempt: run.attempt + 1,
            delayMs,
            repairInPlace,
            resumedInPlace: true,
          },
        );
        await this.releaseHarnessRun(run.id, active, true);
      } else {
        this.db.updateRun(run.id, { status: "failed", error: message });
        await this.archive.writeAttemptResultSafely(run.id, active.workspacePath, "failed", message);
        this.emitRunEvent(run.id, "run.failed", "error", harnessFailure(error).retryable
          ? "运行达到最大重试次数" : "执行器报告不可自动重试的失败，已保留现场", {
          error: message,
          attempts: run.attempt,
          retryable: harnessFailure(error).retryable,
        });
        await this.releaseHarnessRun(run.id, active, true);
      }
    }
  }

  async releaseHarnessRun(
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
        preserveSession ? "已释放执行器工作区实例并保留阶段会话" : "已释放执行器会话与工作区实例",
        { preserveSession },
      );
    } catch (error) {
      this.emitRunEvent(runId, "harness.workspace.release.failed", "warn", "执行器资源释放失败", {
        error: errorMessage(error),
        preserveSession,
      });
    }
  }
}
