import { loadBenchmarkConfig } from "../config.js";
import type { ExperimentRecord, ResolvedBenchmarkConfig, RunRecord, TaskDefinition } from "../domain/types.js";
import { GenerationOrchestrator } from "../execution/orchestrator.js";
import type { BenchmarkDatabase } from "../persistence/database.js";
import { writeExperimentManifest } from "../persistence/workspace.js";

export class OrchestratorManager {
  private active: GenerationOrchestrator | null = null;
  private changingLifecycle = false;

  constructor(private readonly db: BenchmarkDatabase) { }

  get activeExperimentId(): string | null {
    return this.active && !this.active.isSettled ? this.active.experimentId : null;
  }

  getExperiment(id: string): ExperimentRecord | null { return this.db.getExperiment(id); }
  getRun(id: string): RunRecord | null { return this.db.getRun(id); }
  listRecoverableExperiments(): ExperimentRecord[] { return this.db.listRecoverableExperiments(); }

  async createAndStart(
    config: ResolvedBenchmarkConfig,
    tasks: TaskDefinition[],
  ): Promise<{ experiment: ExperimentRecord; orchestrator: GenerationOrchestrator }> {
    return this.withLifecycleChange(() => this.createAndStartUnlocked(config, tasks));
  }

  private async createAndStartUnlocked(
    config: ResolvedBenchmarkConfig,
    tasks: TaskDefinition[],
  ): Promise<{ experiment: ExperimentRecord; orchestrator: GenerationOrchestrator }> {
    if (this.active && !this.active.isSettled) {
      throw new ExperimentConflictError("当前进程已有一个生成实验在运行");
    }
    const experiment = this.db.createExperiment(config, tasks);
    const orchestrator = await this.startExperiment(experiment, tasks);
    return { experiment, orchestrator };
  }

  async startExisting(
    experimentId: string,
    configOverride?: ResolvedBenchmarkConfig,
  ): Promise<GenerationOrchestrator> {
    return this.withLifecycleChange(() => this.startExistingUnlocked(experimentId, configOverride));
  }

  private async startExistingUnlocked(
    experimentId: string,
    configOverride?: ResolvedBenchmarkConfig,
  ): Promise<GenerationOrchestrator> {
    const existing = this.active;
    if (existing && !existing.isSettled) {
      if (existing.experimentId === experimentId) return existing;
      throw new ExperimentConflictError("当前进程已有另一个生成实验在运行");
    }
    const { experiment, tasks } = await this.loadExistingExperiment(experimentId, configOverride);
    return this.startExperiment(experiment, tasks);
  }

  private async loadExistingExperiment(experimentId: string, configOverride?: ResolvedBenchmarkConfig) {
    const persisted = this.db.getExperiment(experimentId);
    if (!persisted) throw new Error(`生成实验不存在: ${experimentId}`);
    const loaded = await loadBenchmarkConfig(persisted.configPath);
    const recoveredConfig = {
      ...loaded.config,
      ...persisted.config,
      ...configOverride,
      runtime: {
        ...loaded.config.runtime,
        ...persisted.config.runtime,
        ...configOverride?.runtime,
      },
    };
    const experiment = { ...persisted, config: recoveredConfig };
    const tasks = this.hydratePersistedRounds(experiment, loaded.tasks);
    return { experiment, tasks };
  }

  get(experimentId: string): GenerationOrchestrator | null {
    return this.active?.experimentId === experimentId ? this.active : null;
  }

  pause(experimentId: string): void {
    this.requireActive(experimentId).pause();
  }

  resume(experimentId: string): void {
    this.requireActive(experimentId).resume();
  }

  async cancel(experimentId: string): Promise<void> {
    await this.requireActive(experimentId).cancel();
  }

  async retryRun(runId: string, configOverride?: ResolvedBenchmarkConfig): Promise<void> {
    return this.withLifecycleChange(() => this.retryRunUnlocked(runId, configOverride));
  }

  private async retryRunUnlocked(runId: string, configOverride?: ResolvedBenchmarkConfig): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`运行不存在: ${runId}`);
    if (this.active && !this.active.isSettled && this.active.experimentId !== run.experimentId) {
      throw new ExperimentConflictError("当前进程已有另一个生成实验在运行");
    }
    const rollback = this.db.resetFailedRun(runId);
    try {
      this.db.updateExperimentStatus(run.experimentId, "running");
      const active = this.get(run.experimentId);
      if (active && !active.isSettled) active.resume();
      else await this.startExistingUnlocked(run.experimentId, configOverride);
    } catch (error) {
      rollback();
      throw error;
    }
    this.db.appendEvent(
      run.experimentId,
      runId,
      "run.requeued",
      "info",
      "运行已手动重新入队",
    );
  }

  async finalizeRun(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`运行不存在: ${runId}`);
    await this.requireActive(run.experimentId).requestRunFinalization(runId);
  }

  async advanceStage(
    experimentId: string,
    configOverride?: ResolvedBenchmarkConfig,
  ): Promise<GenerationOrchestrator> {
    return this.withLifecycleChange(() => this.advanceStageUnlocked(experimentId, configOverride));
  }

  private async advanceStageUnlocked(
    experimentId: string,
    configOverride?: ResolvedBenchmarkConfig,
  ): Promise<GenerationOrchestrator> {
    const active = this.active;
    if (active && !active.isSettled) {
      throw new StageAdvanceError("当前有生成阶段正在运行，请等待它完成后再启动下一阶段");
    }
    const experiment = this.db.getExperiment(experimentId);
    if (!experiment) throw new StageAdvanceError(`生成实验不存在: ${experimentId}`);
    if (experiment.stageMode !== "manual") {
      throw new StageAdvanceError("该任务使用一次性生成模式，不能手动推进阶段");
    }
    if (experiment.status !== "awaiting_stage") {
      throw new StageAdvanceError("只有当前阶段全部完成后才能启动下一阶段");
    }
    if (experiment.targetRound >= experiment.maxRounds) {
      throw new StageAdvanceError("所有生成阶段均已完成");
    }
    // Read and validate configuration before changing the persisted stage.
    const loaded = await this.loadExistingExperiment(experimentId, configOverride);
    const advanced = this.db.advanceExperimentStage(experimentId);
    try {
      return await this.startExperiment({ ...advanced, config: loaded.experiment.config }, loaded.tasks);
    } catch (error) {
      this.db.rollbackExperimentStage(experiment);
      this.db.appendEvent(experimentId, null, "experiment.stage.advance.failed", "error",
        "下一阶段启动失败，已恢复为等待启动", { error: error instanceof Error ? error.message : String(error) });
      await writeExperimentManifest(loaded.experiment.config, experiment,
        this.db.listRuns(experimentId), this.db.getSummary(experimentId)).catch(() => undefined);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    await this.active?.shutdown();
  }

  private async withLifecycleChange<T>(action: () => Promise<T>): Promise<T> {
    if (this.changingLifecycle) throw new ExperimentConflictError("实验正在启动或恢复，请稍后重试");
    this.changingLifecycle = true;
    try {
      return await action();
    } finally {
      this.changingLifecycle = false;
    }
  }

  private async startExperiment(
    experiment: ExperimentRecord,
    tasks: TaskDefinition[],
  ): Promise<GenerationOrchestrator> {
    const orchestrator = new GenerationOrchestrator(
      this.db,
      experiment,
      experiment.config,
      tasks,
    );
    this.active = orchestrator;
    orchestrator.once("settled", () => {
      if (this.active === orchestrator) this.active = null;
    });
    await orchestrator.start();
    return orchestrator;
  }

  private requireActive(experimentId: string): GenerationOrchestrator {
    const orchestrator = this.get(experimentId);
    if (!orchestrator) throw new Error("该实验当前没有活动调度器");
    return orchestrator;
  }

  private hydratePersistedRounds(
    experiment: ExperimentRecord,
    loadedTasks: TaskDefinition[],
  ): TaskDefinition[] {
    const firstRunByTask = new Map<string, string>();
    for (const run of this.db.listRuns(experiment.id)) {
      if (!firstRunByTask.has(run.taskId)) firstRunByTask.set(run.taskId, run.id);
    }
    return loadedTasks
      .filter((task) => firstRunByTask.has(task.id))
      .map((task) => {
        const rounds = this.db.getRounds(firstRunByTask.get(task.id)!).map((round) => {
          const loadedRound = task.rounds[round.roundIndex];
          return {
            id: round.roundId,
            prompt: round.prompt,
            ...(loadedRound?.timeoutMs ? { timeoutMs: loadedRound.timeoutMs } : {}),
          };
        });
        return { ...task, rounds };
      });
  }
}

export class StageAdvanceError extends Error { }
export class ExperimentConflictError extends Error { }
