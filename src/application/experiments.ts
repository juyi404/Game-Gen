import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBenchmarkConfig } from "../config.js";
import type { ExperimentRecord, ResolvedBenchmarkConfig } from "../domain/types.js";
import { validateModelAccess } from "../providers/model-access.js";
import type { ControlPlaneOptions, ModelVerificationGateway, ProviderCatalogReader, ProviderRuntime } from "./contracts.js";
import { InputError } from "./errors.js";
import type { OrchestratorManager } from "./experiment-manager.js";
import type { ProviderConnections } from "./provider-connections.js";
import { experimentInputSchema } from "./schemas.js";

type ExperimentProviderAccess = Pick<ProviderRuntime, "start" | "url">
  & ProviderCatalogReader & Pick<ModelVerificationGateway, "verifyModels">;

export class ExperimentService {
  readonly datasetsDir: string;
  readonly configsDir: string;

  constructor(
    private readonly manager: Pick<OrchestratorManager, "createAndStart">,
    readonly options: ControlPlaneOptions,
    private readonly providerGateway: ExperimentProviderAccess,
    private readonly connections: Pick<ProviderConnections, "attachPackyBillingSnapshots">,
  ) {
    this.datasetsDir = path.join(options.dataDir, "datasets");
    this.configsDir = path.join(options.dataDir, "configs");
  }

  async createExperiment(input: unknown): Promise<{
    experiment: ExperimentRecord;
    orchestrator: Awaited<ReturnType<OrchestratorManager["createAndStart"]>>["orchestrator"];
  }> {
    const parsed = experimentInputSchema.parse(input);
    const enabledModels = parsed.models.filter((model) => model.enabled);
    if (enabledModels.length === 0) throw new InputError("至少启用一个模型");
    const modelIds = new Set<string>();
    for (const model of enabledModels) {
      if (modelIds.has(model.id)) throw new InputError(`模型 ID 重复: ${model.id}`);
      modelIds.add(model.id);
    }

    const datasetDir = path.join(this.datasetsDir, parsed.datasetId);
    const manifestPath = path.join(datasetDir, ".dataset.json");
    if (!existsSync(manifestPath)) throw new InputError("所选题库不存在，请重新上传或选择");

    let serverUrl: string | undefined;
    if (parsed.harness === "opencode") {
      const actual = await this.providerGateway.verifyModels(enabledModels.map((model) => {
        const slash = model.model.indexOf("/");
        return {
          providerId: model.model.slice(0, slash),
          modelId: model.model.slice(slash + 1),
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        };
      }));
      const failedActual = actual.filter((result) => !result.ready);
      if (failedActual.length > 0) {
        const details = failedActual.slice(0, 8)
          .map((result) => `${result.providerId}/${result.modelId}：${result.error}`)
          .join("；");
        throw new InputError(`模型真实调用验证未通过：${details}`);
      }
      const providers = await this.providerGateway.listProviders();
      const invalid = validateModelAccess(enabledModels, providers).filter((check) => !check.ready);
      if (invalid.length > 0) {
        const details = invalid
          .slice(0, 8)
          .map((check) => `${check.id} (${check.model})：${check.message}`)
          .join("；");
        throw new InputError(`模型接入检查未通过：${details}`);
      }
      serverUrl = this.providerGateway.url;
    }

    const providerConcurrency = { ...parsed.providerConcurrency };
    const capacityByProvider = new Map<string, number>();
    for (const model of enabledModels) {
      const provider = model.model.slice(0, model.model.indexOf("/"));
      capacityByProvider.set(provider, (capacityByProvider.get(provider) ?? 0) + model.concurrency);
    }
    for (const [provider, capacity] of capacityByProvider) {
      providerConcurrency[provider] ??= Math.min(parsed.globalConcurrency, capacity);
    }

    const configPath = path.join(
      this.configsDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`,
    );
    const modelsWithBillingSnapshots = await this.connections.attachPackyBillingSnapshots(parsed.models);
    const rawConfig = {
      version: 1,
      name: parsed.name,
      dataset: { dir: datasetDir, include: [] },
      models: modelsWithBillingSnapshots,
      runtime: {
        harness: parsed.harness,
        stageMode: parsed.stageMode,
        globalConcurrency: parsed.globalConcurrency,
        providerConcurrency,
        outputDir: this.options.outputDir,
        dataDir: this.options.dataDir,
        roundTimeoutMs: parsed.roundTimeoutMs,
        ...(parsed.initialBuildSoftTimeoutMs !== undefined
          ? { initialBuildSoftTimeoutMs: parsed.initialBuildSoftTimeoutMs } : {}),
        ...(parsed.initialBuildWrapUpMs !== undefined
          ? { initialBuildWrapUpMs: parsed.initialBuildWrapUpMs } : {}),
        roundIdleTimeoutMs: parsed.roundIdleTimeoutMs,
        maxAttempts: parsed.maxAttempts,
        retryBackoffMs: parsed.retryBackoffMs,
        ...(this.options.workspaceTemplate
          ? { workspaceTemplate: this.options.workspaceTemplate }
          : {}),
      },
      dashboard: this.options.dashboard,
      opencode: {
        ...(serverUrl ? { serverUrl } : {}),
        hostname: this.options.opencode.hostname,
        port: this.options.opencode.port,
        startupTimeoutMs: this.options.opencode.startupTimeoutMs,
        agent: this.options.opencode.agent,
        config: this.options.opencode.config,
      },
      mock: { delayMs: 150, failTaskIds: [] },
      ...(parsed.systemPrompt ? { systemPrompt: parsed.systemPrompt } : {}),
    };
    await writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");
    const loaded = await loadBenchmarkConfig(configPath);
    return this.manager.createAndStart(loaded.config, loaded.tasks);
  }

  async prepareForRecovery(config: ResolvedBenchmarkConfig): Promise<ResolvedBenchmarkConfig> {
    if (config.runtime.harness !== "opencode") return config;
    await this.providerGateway.start();
    return {
      ...config,
      opencode: { ...config.opencode, serverUrl: this.providerGateway.url },
    };
  }
}
