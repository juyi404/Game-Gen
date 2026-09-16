import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadBenchmarkConfig, loadTasks } from "./config.js";
import type { OrchestratorManager } from "./manager.js";
import {
  type AggregatorProviderConfiguration,
  type AggregatorProviderSummary,
  type AggregatorModelDiscovery,
  type ModelVerificationRecord,
  type ModelVerificationRequest,
  type ModelVerificationResult,
  OpenCodeService,
  PACKY_PROTOCOL_DEFAULTS,
  PACKY_PROTOCOLS,
  type ModelAccessCheck,
  type PackyCatalog,
  type PackyProviderConfiguration,
  type PackyProviderSummary,
  type ProviderCatalogItem,
  aggregatorProviderIdForBaseUrl,
  packyProviderIdForGroup,
  validateModelAccess,
} from "./opencode-service.js";
import type { ExperimentRecord, OpenCodeConfig, ResolvedBenchmarkConfig } from "./types.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "仅允许字母、数字、点、下划线和短横线");

const datasetImportSchema = z.object({
  name: z.string().trim().min(1).max(160),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        content: z.string().max(10 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(20_000),
});

const experimentModelSchema = z.object({
  id: identifierSchema,
  model: z.string().regex(/^[^/]+\/.+$/, "模型必须使用 provider/model 格式"),
  enabled: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(1_000),
  roundTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  reasoningEffort: identifierSchema.optional(),
});

const experimentInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  datasetId: identifierSchema,
  harness: z.enum(["opencode", "mock"]).default("opencode"),
  stageMode: z.enum(["all", "manual"]).default("all"),
  models: z
    .array(experimentModelSchema)
    .min(1)
    .max(100),
  globalConcurrency: z.number().int().min(1).max(1_000),
  providerConcurrency: z.record(z.string(), z.number().int().min(1).max(1_000)).default({}),
  maxAttempts: z.number().int().min(1).max(10).default(2),
  roundTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).default(0),
  initialBuildSoftTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  initialBuildWrapUpMs: z.number().int().min(1).max(60 * 60 * 1000).optional(),
  roundIdleTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000)
    .default(30 * 60 * 1000),
  retryBackoffMs: z.number().int().min(0).max(60 * 60 * 1000).default(10_000),
  systemPrompt: z.string().max(20_000).optional(),
});

const modelAccessInputSchema = z.object({
  models: z.array(experimentModelSchema).min(1).max(100),
});

const modelVerificationInputSchema = z.object({
  models: z.array(experimentModelSchema).min(1).max(100),
  force: z.boolean().default(false),
});

const datasetDraftModelSchema = z.object({
  id: z.string().max(120),
  model: z.string().max(500),
  enabled: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(1_000),
  reasoningEffort: identifierSchema.optional(),
});

const datasetModelSelectionInputSchema = z.object({
  // Dataset selections are editable drafts. The stricter provider/model and ID
  // checks still run when an experiment is created.
  models: z.array(datasetDraftModelSchema).max(100),
});

const apiKeySchema = z.object({
  providerId: identifierSchema,
  key: z.string().trim().min(1).max(20_000),
});

const oauthSchema = z.object({
  providerId: identifierSchema,
  method: z.number().int().nonnegative(),
  code: z.string().trim().max(20_000).optional(),
});

const packyModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "模型 ID 只能包含字母、数字、点、下划线、冒号和短横线");

const packyProviderSchema = z.object({
  providerId: identifierSchema,
  protocol: z.enum(PACKY_PROTOCOLS),
  baseUrl: z.url().refine((value) => new URL(value).protocol === "https:", {
    message: "PackyAPI 地址必须使用 HTTPS",
  }),
  apiKey: z.string().trim().min(1).max(20_000),
  models: z
    .array(z.object({
      id: packyModelIdSchema,
      name: z.string().trim().min(1).max(200).optional(),
    }))
    .min(1)
    .max(100)
    .refine((models) => new Set(models.map((model) => model.id)).size === models.length, {
      message: "模型 ID 不能重复",
    }),
});

const packyGroupConnectionSchema = z.object({
  group: identifierSchema,
  apiKey: z.string().trim().min(1).max(20_000),
  protocol: z.enum(PACKY_PROTOCOLS).optional(),
  targetModelId: packyModelIdSchema.optional(),
});

const aggregatorConnectionSchema = z.object({
  providerId: identifierSchema
    .refine((value) => value.startsWith("aggregate-"), {
      message: "聚合供应商标识必须以 aggregate- 开头",
    })
    .optional(),
  name: z.string().trim().min(1).max(160).optional(),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  }, {
    message: "API Base URL 必须是无账号、查询参数和片段的 HTTPS 地址",
  }),
  apiKey: z.string().trim().min(1).max(20_000),
});

const manifestSchema = z.object({
  id: identifierSchema,
  name: z.string(),
  createdAt: z.number(),
  fileCount: z.number(),
  taskCount: z.number(),
  roundCount: z.number(),
  totalBytes: z.number(),
  preview: z.array(z.object({ id: z.string(), title: z.string(), rounds: z.number() })),
});

export type DatasetSummary = z.infer<typeof manifestSchema>;
export type ExperimentInput = z.infer<typeof experimentInputSchema>;
export type DatasetModelSelection = z.infer<typeof datasetModelSelectionInputSchema> & {
  datasetId: string;
  updatedAt: number;
};

export interface ControlPlaneOptions {
  projectRoot: string;
  dataDir: string;
  outputDir: string;
  workspaceTemplate?: string;
  opencode: OpenCodeConfig;
  dashboard: { hostname: string; port: number };
}

interface ProviderGateway {
  readonly expectedUrl: string;
  readonly url: string;
  start(): Promise<void>;
  listProviders(): Promise<ProviderCatalogItem[]>;
  listPackyProviders(): Promise<PackyProviderSummary[]>;
  listPackyCatalog(force?: boolean): Promise<PackyCatalog>;
  listPackyAuthorizedModels(apiKey: string): Promise<string[]>;
  configurePackyProvider(input: PackyProviderConfiguration): Promise<PackyProviderSummary>;
  listAggregatorProviders(): Promise<AggregatorProviderSummary[]>;
  discoverAggregatorModels(
    baseUrl: string,
    apiKey: string,
  ): Promise<AggregatorModelDiscovery>;
  configureAggregatorProvider(
    input: AggregatorProviderConfiguration,
  ): Promise<AggregatorProviderSummary>;
  listModelVerifications(): Promise<ModelVerificationRecord[]>;
  verifyModels(
    requests: ModelVerificationRequest[],
    force?: boolean,
  ): Promise<ModelVerificationResult[]>;
  setApiKey(providerId: string, key: string): Promise<void>;
  startOAuth(providerId: string, method: number): Promise<{
    url: string;
    method: "auto" | "code";
    instructions: string;
  }>;
  completeOAuth(providerId: string, method: number, code?: string): Promise<void>;
  close(): void;
}

export class ControlPlane {
  readonly datasetsDir: string;
  readonly configsDir: string;
  private readonly providerGateway: ProviderGateway;
  private datasetModelSelections: Record<string, DatasetModelSelection> = {};
  private datasetModelSelectionsLoaded = false;

  constructor(
    private readonly manager: OrchestratorManager,
    readonly options: ControlPlaneOptions,
    providerGateway?: ProviderGateway,
  ) {
    this.datasetsDir = path.join(options.dataDir, "datasets");
    this.configsDir = path.join(options.dataDir, "configs");
    this.providerGateway = providerGateway ?? new OpenCodeService(options.opencode, options.dataDir);
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.datasetsDir, { recursive: true }),
      mkdir(this.configsDir, { recursive: true }),
      mkdir(this.options.outputDir, { recursive: true }),
    ]);
  }

  async listDatasets(): Promise<DatasetSummary[]> {
    await this.initialize();
    const entries = await readdir(this.datasetsDir, { withFileTypes: true });
    const datasets: DatasetSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.endsWith(".uploading")) continue;
      const manifestPath = path.join(this.datasetsDir, entry.name, ".dataset.json");
      if (!existsSync(manifestPath)) continue;
      const raw = JSON.parse(await readFile(manifestPath, "utf8"));
      datasets.push(manifestSchema.parse(raw));
    }
    return datasets.sort((left, right) => right.createdAt - left.createdAt);
  }

  async listDatasetModelSelections(): Promise<Record<string, DatasetModelSelection>> {
    await this.loadDatasetModelSelections();
    return structuredClone(this.datasetModelSelections);
  }

  async saveDatasetModelSelection(
    datasetId: string,
    input: unknown,
  ): Promise<DatasetModelSelection> {
    if (!identifierSchema.safeParse(datasetId).success
      || !existsSync(path.join(this.datasetsDir, datasetId, ".dataset.json"))) {
      throw new InputError("所选题库不存在");
    }
    const parsed = datasetModelSelectionInputSchema.parse(input);
    const enabledIds = parsed.models
      .filter((model) => model.enabled && model.id.length > 0)
      .map((model) => model.id);
    if (new Set(enabledIds).size !== enabledIds.length) throw new InputError("模型显示名称不能重复");
    await this.loadDatasetModelSelections();
    const selection = { datasetId, models: parsed.models, updatedAt: Date.now() };
    this.datasetModelSelections[datasetId] = selection;
    await this.persistDatasetModelSelections();
    return structuredClone(selection);
  }

  async importDataset(input: unknown): Promise<DatasetSummary> {
    const parsed = datasetImportSchema.parse(input);
    await this.initialize();
    const id = randomUUID();
    const temporaryDir = path.join(this.datasetsDir, `${id}.uploading`);
    const finalDir = path.join(this.datasetsDir, id);
    const seenPaths = new Set<string>();
    let totalBytes = 0;

    await mkdir(temporaryDir, { recursive: false });
    try {
      for (const file of parsed.files) {
        const relativePath = safeUploadPath(file.path);
        if (seenPaths.has(relativePath)) throw new InputError(`上传文件路径重复: ${relativePath}`);
        seenPaths.add(relativePath);
        const content = file.content.replace(/^\uFEFF/, "");
        totalBytes += Buffer.byteLength(content);
        const target = path.join(temporaryDir, ...relativePath.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }

      const tasks = await loadTasks(temporaryDir, [], { references: "forbid" });
      const summary: DatasetSummary = {
        id,
        name: parsed.name,
        createdAt: Date.now(),
        fileCount: parsed.files.length,
        taskCount: tasks.length,
        roundCount: tasks.reduce((total, task) => total + task.rounds.length, 0),
        totalBytes,
        preview: tasks.slice(0, 8).map((task) => ({
          id: task.id,
          title: task.title,
          rounds: task.rounds.length,
        })),
      };
      await writeFile(
        path.join(temporaryDir, ".dataset.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryDir, finalDir);
      return summary;
    } catch (error) {
      await rm(temporaryDir, { recursive: true, force: true });
      throw error;
    }
  }

  async listProviders(): Promise<ProviderCatalogItem[]> {
    return this.providerGateway.listProviders();
  }

  async listPackyProviders(): Promise<PackyProviderSummary[]> {
    return this.providerGateway.listPackyProviders();
  }

  async listPackyCatalog(force = false): Promise<PackyCatalog> {
    return this.providerGateway.listPackyCatalog(force);
  }

  async listAggregatorProviders(): Promise<AggregatorProviderSummary[]> {
    return this.providerGateway.listAggregatorProviders();
  }

  async listModelVerifications(): Promise<ModelVerificationRecord[]> {
    return this.providerGateway.listModelVerifications();
  }

  async verifyModelsActually(input: unknown): Promise<ModelVerificationResult[]> {
    const parsed = modelVerificationInputSchema.parse(input);
    return this.providerGateway.verifyModels(parsed.models
      .filter((model) => model.enabled)
      .map((model) => {
        const slash = model.model.indexOf("/");
        return {
          providerId: model.model.slice(0, slash),
          modelId: model.model.slice(slash + 1),
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        };
      }), parsed.force);
  }

  async connectAggregator(input: unknown): Promise<AggregatorProviderSummary> {
    const parsed = aggregatorConnectionSchema.parse(input);
    const baseUrl = normalizeAggregatorBaseUrl(parsed.baseUrl);
    const providerId = parsed.providerId ?? aggregatorProviderIdForBaseUrl(baseUrl);
    const [providers, aggregators, discovery] = await Promise.all([
      this.providerGateway.listProviders(),
      this.providerGateway.listAggregatorProviders(),
      this.providerGateway.discoverAggregatorModels(baseUrl, parsed.apiKey)
        .catch((error) => {
          throw new InputError(error instanceof Error ? error.message : String(error));
        }),
    ]);
    const existing = providers.find((provider) => provider.id === providerId);
    const existingAggregator = aggregators.find(
      (provider) => provider.providerId === providerId,
    );
    if (existing && !existingAggregator) {
      throw new InputError(`供应商标识 ${providerId} 已被其他 OpenCode 供应商使用`);
    }
    const hostname = new URL(baseUrl).hostname;
    return this.providerGateway.configureAggregatorProvider({
      providerId,
      name: parsed.name ?? `聚合供应商 · ${hostname}`,
      baseUrl,
      apiKey: parsed.apiKey,
      models: discovery.models,
      discoveredModelCount: discovery.discoveredModelCount,
    });
  }

  async configurePackyProvider(input: unknown): Promise<PackyProviderSummary> {
    const parsed = packyProviderSchema.parse(input);
    const [providers, packyProviders] = await Promise.all([
      this.providerGateway.listProviders(),
      this.providerGateway.listPackyProviders(),
    ]);
    const existing = providers.find((provider) => provider.id === parsed.providerId);
    const existingPacky = packyProviders.find(
      (provider) => provider.providerId === parsed.providerId,
    );
    if (existing && !existingPacky) {
      throw new InputError(`供应商标识 ${parsed.providerId} 已被其他 OpenCode 供应商使用`);
    }
    return this.providerGateway.configurePackyProvider({
      providerId: parsed.providerId,
      name: `PackyAPI · ${PACKY_PROTOCOL_DEFAULTS[parsed.protocol].label}`,
      protocol: parsed.protocol,
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      models: parsed.models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
    });
  }

  async connectPackyGroup(input: unknown): Promise<PackyProviderSummary> {
    const parsed = packyGroupConnectionSchema.parse(input);
    const [catalog, providers, packyProviders, authorizedModelIds] = await Promise.all([
      this.providerGateway.listPackyCatalog(),
      this.providerGateway.listProviders(),
      this.providerGateway.listPackyProviders(),
      this.providerGateway.listPackyAuthorizedModels(parsed.apiKey).catch((error) => {
        throw new InputError(error instanceof Error ? error.message : String(error));
      }),
    ]);
    const requestedGroup = catalog.groups.find((item) => item.id === parsed.group);
    if (!requestedGroup) throw new InputError(`PackyAPI 当前目录中不存在分组 ${parsed.group}`);
    const authorizedModels = new Set(authorizedModelIds);
    const targetModel = parsed.targetModelId
      ? catalog.models.find((model) => model.id === parsed.targetModelId)
      : undefined;
    if (parsed.targetModelId && !targetModel) {
      throw new InputError(`PackyAPI 当前目录中不存在模型 ${parsed.targetModelId}`);
    }
    if (targetModel && !targetModel.sourceGeneration) {
      throw new InputError(`PackyAPI 模型 ${targetModel.id} 不能用于生成游戏源码`);
    }
    if (targetModel && !authorizedModels.has(targetModel.id)) {
      throw new InputError(
        `这把 PackyAPI Key 的 /v1/models 未返回 ${targetModel.id}，因此无法接入该模型。`
        + `请确认 Key 属于包含该模型的分组；该 Key 当前返回 ${authorizedModels.size} 个模型。`,
      );
    }

    const group = requestedGroup;
    if (targetModel) {
      if (!targetModel.groups.includes(group.id)) {
        throw new InputError(
          `PackyAPI 模型 ${targetModel.id} 不属于所选计费分组 ${group.name}；`
          + "模型目录只能证明 Key 可访问该模型，不能证明或自动更改 Key 的计费分组。",
        );
      }
    }
    const protocol = parsed.protocol ?? group.defaultProtocol;
    if (!protocol || !group.protocols.includes(protocol)) {
      throw new InputError(`PackyAPI 分组 ${group.name} 没有可供 OpenCode 使用的统一协议`);
    }
    const models = catalog.models
      .filter((model) => model.sourceGeneration
        && model.groups.includes(group.id)
        && model.protocols.includes(protocol)
        && authorizedModels.has(model.id))
      .map((model) => ({ id: model.id, name: model.name }));
    if (models.length === 0) {
      throw new InputError(`该 PackyAPI Key 无法访问 ${group.name} 分组中的游戏生成模型，请检查 Key 所属分组`);
    }
    if (targetModel && !models.some((model) => model.id === targetModel.id)) {
      throw new InputError(`该 PackyAPI Key 无法通过 ${group.name} 分组接入 ${targetModel.id}`);
    }

    const providerId = packyProviderIdForGroup(group.id);
    const existing = providers.find((provider) => provider.id === providerId);
    const existingPacky = packyProviders.find((provider) => provider.providerId === providerId);
    if (existing && !existingPacky) {
      throw new InputError(`供应商标识 ${providerId} 已被其他 OpenCode 供应商使用`);
    }
    return this.providerGateway.configurePackyProvider({
      providerId,
      name: `PackyAPI · ${group.name}`,
      protocol,
      baseUrl: PACKY_PROTOCOL_DEFAULTS[protocol].baseUrl,
      apiKey: parsed.apiKey,
      models,
      group: group.id,
    });
  }

  async validateModels(input: unknown): Promise<ModelAccessCheck[]> {
    const parsed = modelAccessInputSchema.parse(input);
    const providers = await this.providerGateway.listProviders();
    return validateModelAccess(
      parsed.models.filter((model) => model.enabled),
      providers,
    );
  }

  async setApiKey(input: unknown): Promise<void> {
    const parsed = apiKeySchema.parse(input);
    await this.providerGateway.setApiKey(parsed.providerId, parsed.key);
  }

  async startOAuth(input: unknown): Promise<{
    url: string;
    method: "auto" | "code";
    instructions: string;
  }> {
    const parsed = oauthSchema.parse(input);
    return this.providerGateway.startOAuth(parsed.providerId, parsed.method);
  }

  async completeOAuth(input: unknown): Promise<void> {
    const parsed = oauthSchema.parse(input);
    await this.providerGateway.completeOAuth(parsed.providerId, parsed.method, parsed.code);
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
    const modelsWithBillingSnapshots = await this.attachPackyBillingSnapshots(parsed.models);
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

  private async attachPackyBillingSnapshots(
    models: Array<z.infer<typeof experimentModelSchema>>,
  ): Promise<Array<z.infer<typeof experimentModelSchema> & {
    billingSnapshot?: ResolvedBenchmarkConfig["models"][number]["billingSnapshot"];
  }>> {
    const packyProviderIds = new Set(models
      .filter((model) => model.enabled)
      .map((model) => model.model.slice(0, model.model.indexOf("/")))
      .filter((providerId) => providerId.startsWith("packy-")));
    if (packyProviderIds.size === 0) return models;

    const [catalog, providers] = await Promise.all([
      this.providerGateway.listPackyCatalog(),
      this.providerGateway.listPackyProviders(),
    ]);
    const providerById = new Map(providers.map((provider) => [provider.providerId, provider]));
    const catalogModelById = new Map(catalog.models.map((model) => [model.id, model]));
    return models.map((model) => {
      const slash = model.model.indexOf("/");
      const providerId = model.model.slice(0, slash);
      if (!model.enabled || !packyProviderIds.has(providerId)) return model;
      const provider = providerById.get(providerId);
      if (!provider?.group) {
        throw new InputError(`PackyAPI 供应商 ${providerId} 缺少明确的计费分组，无法保存费用快照`);
      }
      const modelId = model.model.slice(slash + 1);
      const catalogModel = catalogModelById.get(modelId);
      if (!catalogModel || !catalogModel.groups.includes(provider.group)) {
        throw new InputError(
          `PackyAPI 目录中找不到 ${provider.group} 分组下的模型 ${modelId}，无法保存费用快照`,
        );
      }
      return {
        ...model,
        billingSnapshot: {
          provider: "packy" as const,
          group: provider.group,
          catalogSource: catalog.source,
          catalogFetchedAt: catalog.fetchedAt,
          pricing: structuredClone(catalogModel.pricing ?? {}),
        },
      };
    });
  }

  private async loadDatasetModelSelections(): Promise<void> {
    if (this.datasetModelSelectionsLoaded) return;
    this.datasetModelSelectionsLoaded = true;
    const statePath = path.join(this.options.dataDir, "dataset-model-selections.json");
    try {
      const raw = JSON.parse(await readFile(statePath, "utf8")) as { selections?: unknown };
      const selections = raw && typeof raw === "object" && raw.selections
        && typeof raw.selections === "object" && !Array.isArray(raw.selections)
        ? raw.selections as Record<string, unknown>
        : {};
      this.datasetModelSelections = Object.fromEntries(Object.entries(selections).flatMap(([datasetId, value]) => {
        const parsed = z.object({
          datasetId: identifierSchema,
          updatedAt: z.number(),
          models: z.array(datasetDraftModelSchema).max(100),
        }).safeParse(value);
        return parsed.success && parsed.data.datasetId === datasetId ? [[datasetId, parsed.data]] : [];
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistDatasetModelSelections(): Promise<void> {
    const statePath = path.join(this.options.dataDir, "dataset-model-selections.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({
      version: 1,
      selections: this.datasetModelSelections,
    }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, statePath);
  }

  close(): void {
    this.providerGateway.close();
  }
}

export class InputError extends Error {}

function normalizeAggregatorBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/models$/i, "") || "/";
  return url.toString().replace(/\/+$/, "");
}

function safeUploadPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized.toLowerCase().endsWith(".json") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new InputError(`仅支持相对路径 JSON 文件: ${value}`);
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*\0]/.test(segment),
    )
  ) {
    throw new InputError(`文件路径无效: ${value}`);
  }
  return segments.join("/");
}
