import type { ExperimentRecord, ResolvedBenchmarkConfig, TaskDefinition } from "../domain/types.js";
import { NotFoundError } from "./errors.js";
import type { OrchestratorManager } from "./experiment-manager.js";

/** Lifecycle use cases shared by HTTP, CLI and future transports. */
export type ExperimentCommandManager = Pick<OrchestratorManager,
  "activeExperimentId" | "getExperiment" | "getRun" | "listRecoverableExperiments"
  | "createAndStart" | "startExisting" | "pause" | "resume" | "cancel"
  | "retryRun" | "advanceStage" | "finalizeRun" | "shutdown">;

export class ExperimentCommands {
  constructor(
    private readonly manager: ExperimentCommandManager,
    private readonly prepareRuntime: (config: ResolvedBenchmarkConfig) => Promise<ResolvedBenchmarkConfig>,
  ) {}

  get activeExperimentId(): string | null { return this.manager.activeExperimentId; }

  async createFromConfig(config: ResolvedBenchmarkConfig, tasks: TaskDefinition[]) {
    return this.manager.createAndStart(await this.prepareRuntime(config), tasks);
  }

  async recoverExperiment(experimentId: string) {
    const experiment = this.requireExperiment(experimentId);
    return this.manager.startExisting(experiment.id, await this.prepareRuntime(experiment.config));
  }

  async recoverLatestExperiment(): Promise<ExperimentRecord | null> {
    const latest = this.manager.listRecoverableExperiments()[0];
    if (!latest) return null;
    await this.recoverExperiment(latest.id);
    return latest;
  }

  async advanceStage(experimentId: string): Promise<void> {
    const experiment = this.requireExperiment(experimentId);
    await this.manager.advanceStage(experiment.id, await this.prepareRuntime(experiment.config));
  }

  async retryRun(runId: string): Promise<void> {
    const run = this.manager.getRun(runId);
    if (!run) throw new NotFoundError("运行不存在");
    const experiment = this.requireExperiment(run.experimentId);
    await this.manager.retryRun(run.id, await this.prepareRuntime(experiment.config));
  }

  pause(experimentId: string): void { this.manager.pause(experimentId); }
  resume(experimentId: string): void { this.manager.resume(experimentId); }
  async cancel(experimentId: string): Promise<void> { await this.manager.cancel(experimentId); }
  async finalizeRun(runId: string): Promise<void> { await this.manager.finalizeRun(runId); }
  async shutdown(): Promise<void> { await this.manager.shutdown(); }

  private requireExperiment(experimentId: string): ExperimentRecord {
    const experiment = this.manager.getExperiment(experimentId);
    if (!experiment) throw new NotFoundError("生成实验不存在");
    return experiment;
  }
}
