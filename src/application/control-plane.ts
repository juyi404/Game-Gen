import { mkdir } from "node:fs/promises";
import type { ExperimentRecord, ResolvedBenchmarkConfig, TaskDefinition } from "../domain/types.js";
import type { AggregatorProviderSummary, ModelAccessCheck, ModelVerificationRecord, ModelVerificationResult, PackyCatalog, PackyProviderSummary, ProviderCatalogItem } from "../providers/contracts.js";
import { OpenCodeService } from "../providers/opencode-service.js";
import type { ControlPlaneOptions, ProviderGateway } from "./contracts.js";
import { DatasetService } from "./datasets.js";
import { ExperimentCommands } from "./experiment-commands.js";
import type { OrchestratorManager } from "./experiment-manager.js";
import { ExperimentService } from "./experiments.js";
import { ProviderConnections } from "./provider-connections.js";
import type { DatasetModelSelection, DatasetSummary } from "./schemas.js";

/** Application facade retained for HTTP, CLI and existing integrations. */
export class ControlPlane {
  readonly datasetsDir: string;
  readonly configsDir: string;
  private readonly providerGateway: ProviderGateway;
  private readonly datasets: DatasetService;
  private readonly connections: ProviderConnections;
  private readonly experiments: ExperimentService;
  private readonly commands: ExperimentCommands;

  constructor(manager: OrchestratorManager, readonly options: ControlPlaneOptions, providerGateway?: ProviderGateway) {
    this.providerGateway = providerGateway ?? new OpenCodeService(options.opencode, options.dataDir);
    this.datasets = new DatasetService(options);
    this.connections = new ProviderConnections(
      this.providerGateway, this.providerGateway, this.providerGateway,
      this.providerGateway, this.providerGateway,
    );
    this.experiments = new ExperimentService(manager, options, this.providerGateway, this.connections);
    this.commands = new ExperimentCommands(manager, (config) => this.experiments.prepareForRecovery(config));
    this.datasetsDir = this.datasets.datasetsDir;
    this.configsDir = this.experiments.configsDir;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.datasets.initialize(),
      mkdir(this.configsDir, { recursive: true }),
      mkdir(this.options.outputDir, { recursive: true }),
    ]);
  }

  async listDatasets(): Promise<DatasetSummary[]> {
    return this.datasets.listDatasets();
  }

  async listDatasetModelSelections(): Promise<Record<string, DatasetModelSelection>> {
    return this.datasets.listDatasetModelSelections();
  }

  async saveDatasetModelSelection(
    datasetId: string,
    input: unknown,
  ): Promise<DatasetModelSelection> {
    return this.datasets.saveDatasetModelSelection(datasetId, input);
  }

  async importDataset(input: unknown): Promise<DatasetSummary> {
    return this.datasets.importDataset(input);
  }

  async listProviders(): Promise<ProviderCatalogItem[]> {
    return this.connections.listProviders();
  }

  async listPackyProviders(): Promise<PackyProviderSummary[]> {
    return this.connections.listPackyProviders();
  }

  async listPackyCatalog(force = false): Promise<PackyCatalog> {
    return this.connections.listPackyCatalog(force);
  }

  async listAggregatorProviders(): Promise<AggregatorProviderSummary[]> {
    return this.connections.listAggregatorProviders();
  }

  async listModelVerifications(): Promise<ModelVerificationRecord[]> {
    return this.connections.listModelVerifications();
  }

  async verifyModelsActually(input: unknown): Promise<ModelVerificationResult[]> {
    return this.connections.verifyModelsActually(input);
  }

  async connectAggregator(input: unknown): Promise<AggregatorProviderSummary> {
    return this.connections.connectAggregator(input);
  }

  async configurePackyProvider(input: unknown): Promise<PackyProviderSummary> {
    return this.connections.configurePackyProvider(input);
  }

  async connectPackyGroup(input: unknown): Promise<PackyProviderSummary> {
    return this.connections.connectPackyGroup(input);
  }

  async validateModels(input: unknown): Promise<ModelAccessCheck[]> {
    return this.connections.validateModels(input);
  }

  async setApiKey(input: unknown): Promise<void> {
    return this.connections.setApiKey(input);
  }

  async startOAuth(input: unknown): Promise<{
    url: string;
    method: "auto" | "code";
    instructions: string;
  }> {
    return this.connections.startOAuth(input);
  }

  async completeOAuth(input: unknown): Promise<void> {
    return this.connections.completeOAuth(input);
  }

  async createExperiment(input: unknown): Promise<{
    experiment: ExperimentRecord;
    orchestrator: Awaited<ReturnType<OrchestratorManager["createAndStart"]>>["orchestrator"];
  }> {
    return this.experiments.createExperiment(input);
  }

  async prepareForRecovery(config: ResolvedBenchmarkConfig): Promise<ResolvedBenchmarkConfig> {
    return this.experiments.prepareForRecovery(config);
  }

  get activeExperimentId(): string | null { return this.commands.activeExperimentId; }
  async createFromConfig(config: ResolvedBenchmarkConfig, tasks: TaskDefinition[]) {
    return this.commands.createFromConfig(config, tasks);
  }
  async recoverExperiment(id: string) { return this.commands.recoverExperiment(id); }
  async recoverLatestExperiment() { return this.commands.recoverLatestExperiment(); }
  async advanceStage(id: string): Promise<void> { await this.commands.advanceStage(id); }
  async retryRun(id: string): Promise<void> { await this.commands.retryRun(id); }
  pause(id: string): void { this.commands.pause(id); }
  resume(id: string): void { this.commands.resume(id); }
  async cancel(id: string): Promise<void> { await this.commands.cancel(id); }
  async finalizeRun(id: string): Promise<void> { await this.commands.finalizeRun(id); }
  async shutdown(): Promise<void> { await this.commands.shutdown(); }

  close(): void { this.providerGateway.close(); }
}
