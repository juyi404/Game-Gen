import { loadBenchmarkConfig } from "./config.js";
import type { BenchmarkDatabase } from "./database.js";
import { GenerationOrchestrator } from "./orchestrator.js";
import type { ExperimentRecord, ResolvedBenchmarkConfig, TaskDefinition } from "./types.js";

export class OrchestratorManager {
  private active: GenerationOrchestrator | null = null;

  constructor(private readonly db: BenchmarkDatabase) {}

  get activeExperimentId(): string | null {
    return this.active && !this.active.isSettled ? this.active.experimentId : null;
  }

  async createAndStart(
    config: ResolvedBenchmarkConfig,
    tasks: TaskDefinition[],
  ): Promise<{ experiment: ExperimentRecord; orchestrator: GenerationOrchestrator }> {
    if (this.active && !this.active.isSettled) {
      throw new Error("当前进程已有一个生成实验在运行");
    }
    const experiment = this.db.createExperiment(config, tasks);
    const orchestrator = await this.startExperiment(experiment, tasks);
    return { experiment, orchestrator };
  }

  async startExisting(
    experimentId: string,
    configOverride?: ResolvedBenchmarkConfig,
  ): Promise<GenerationOrchestrator> {
    const existing = this.active;
    if (existing && !existing.isSettled) {
      if (existing.experimentId === experimentId) return existing;
      throw new Error("当前进程已有另一个生成实验在运行");
    }
    const persisted = this.db.getExperiment(experimentId);
    if (!persisted) throw new Error(`生成实验不存在: ${experimentId}`);
    const experiment = configOverride ? { ...persisted, config: configOverride } : persisted;
    const loaded = await loadBenchmarkConfig(experiment.configPath);
    const tasks = this.hydratePersistedRounds(experiment, loaded.tasks);
    return this.startExperiment(experiment, tasks);
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

  async retryRun(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`运行不存在: ${runId}`);
    this.db.resetFailedRun(runId);
    this.db.updateExperimentStatus(run.experimentId, "running");
    this.db.appendEvent(
      run.experimentId,
      runId,
      "run.requeued",
      "info",
      "运行已手动重新入队",
    );
    const active = this.get(run.experimentId);
    if (active) active.resume();
    else await this.startExisting(run.experimentId);
  }

  async advanceStage(
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
    this.db.advanceExperimentStage(experimentId);
    return this.startExisting(experimentId, configOverride);
  }

  async shutdown(): Promise<void> {
    await this.active?.shutdown();
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

export class StageAdvanceError extends Error {}
