import { z } from "zod";
import type { ResolvedBenchmarkConfig } from "../domain/types.js";
import { aggregatorProviderIdForBaseUrl } from "../providers/aggregator.js";
import type { AggregatorProviderSummary, ModelAccessCheck, ModelVerificationRecord, ModelVerificationResult, PackyCatalog, PackyProviderSummary, ProviderCatalogItem } from "../providers/contracts.js";
import { PACKY_PROTOCOL_DEFAULTS } from "../providers/contracts.js";
import { validateModelAccess } from "../providers/model-access.js";
import { packyProviderIdForGroup } from "../providers/packy.js";
import type { AggregatorCatalogReader, ModelVerificationGateway, PackyCatalogReader, ProviderCatalogReader, ProviderConfiguration, ProviderCredentials, ProviderDiscovery } from "./contracts.js";
import { InputError } from "./errors.js";
import { normalizeAggregatorBaseUrl } from "./paths.js";
import { aggregatorConnectionSchema, apiKeySchema, experimentModelSchema, modelAccessInputSchema, modelVerificationInputSchema, oauthSchema, packyGroupConnectionSchema, packyProviderSchema } from "./schemas.js";

export class ProviderConnections {
  constructor(
    private readonly catalog: ProviderCatalogReader & PackyCatalogReader & AggregatorCatalogReader,
    private readonly discovery: ProviderDiscovery,
    private readonly configuration: ProviderConfiguration,
    private readonly verifications: ModelVerificationGateway,
    private readonly credentials: ProviderCredentials,
  ) { }

  async listProviders(): Promise<ProviderCatalogItem[]> {
    return this.catalog.listProviders();
  }

  async listPackyProviders(): Promise<PackyProviderSummary[]> {
    return this.catalog.listPackyProviders();
  }

  async listPackyCatalog(force = false): Promise<PackyCatalog> {
    return this.catalog.listPackyCatalog(force);
  }

  async listAggregatorProviders(): Promise<AggregatorProviderSummary[]> {
    return this.catalog.listAggregatorProviders();
  }

  async listModelVerifications(): Promise<ModelVerificationRecord[]> {
    return this.verifications.listModelVerifications();
  }

  async verifyModelsActually(input: unknown): Promise<ModelVerificationResult[]> {
    const parsed = modelVerificationInputSchema.parse(input);
    return this.verifications.verifyModels(parsed.models
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
      this.catalog.listProviders(),
      this.catalog.listAggregatorProviders(),
      this.discovery.discoverAggregatorModels(baseUrl, parsed.apiKey)
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
    return this.configuration.configureAggregatorProvider({
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
      this.catalog.listProviders(),
      this.catalog.listPackyProviders(),
    ]);
    const existing = providers.find((provider) => provider.id === parsed.providerId);
    const existingPacky = packyProviders.find(
      (provider) => provider.providerId === parsed.providerId,
    );
    if (existing && !existingPacky) {
      throw new InputError(`供应商标识 ${parsed.providerId} 已被其他 OpenCode 供应商使用`);
    }
    return this.configuration.configurePackyProvider({
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
      this.catalog.listPackyCatalog(),
      this.catalog.listProviders(),
      this.catalog.listPackyProviders(),
      this.discovery.listPackyAuthorizedModels(parsed.apiKey).catch((error) => {
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
    return this.configuration.configurePackyProvider({
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
    const providers = await this.catalog.listProviders();
    return validateModelAccess(
      parsed.models.filter((model) => model.enabled),
      providers,
    );
  }

  async setApiKey(input: unknown): Promise<void> {
    const parsed = apiKeySchema.parse(input);
    await this.credentials.setApiKey(parsed.providerId, parsed.key);
  }

  async startOAuth(input: unknown): Promise<{
    url: string;
    method: "auto" | "code";
    instructions: string;
  }> {
    const parsed = oauthSchema.parse(input);
    return this.credentials.startOAuth(parsed.providerId, parsed.method);
  }

  async completeOAuth(input: unknown): Promise<void> {
    const parsed = oauthSchema.parse(input);
    await this.credentials.completeOAuth(parsed.providerId, parsed.method, parsed.code);
  }

  async attachPackyBillingSnapshots(
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
      this.catalog.listPackyCatalog(),
      this.catalog.listPackyProviders(),
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
}
