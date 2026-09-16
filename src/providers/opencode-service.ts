import type { OpencodeClient, ProviderAuthAuthorization } from "@opencode-ai/sdk";
import type { OpenCodeConfig } from "../domain/types.js";
import { configuredOpenCodeUrl, connectOrStartOpenCode } from "../runtime/opencode.js";
import { parseAggregatorModelList, probeAggregatorModel } from "./aggregator.js";
import type { AggregatorAddressResolver, AggregatorModelDiscovery, AggregatorProviderConfiguration, AggregatorProviderSummary, ModelVerificationRecord, ModelVerificationRequest, ModelVerificationResult, OpenCodeServiceSecurityOptions, PackyCatalog, PackyProviderConfiguration, PackyProviderSummary, ProviderCatalogItem, ProviderModelConfig, RuntimeProvider, RuntimeProviderModel } from "./contracts.js";
import { AGGREGATOR_MAX_RESPONSE_BYTES } from "./contracts.js";
import { assertSafeAggregatorEndpoint, defaultAggregatorAddressResolver, readableFetchError, readBoundedResponseText } from "./network.js";
import { createPackyProviderConfig, enrichPackyModels, inferPackyGroup, inferPackyProtocol, isPackyBaseUrl, normalizeModelVariants, normalizePackyProviderBaseUrl } from "./packy.js";
import { delay, mapWithConcurrency, portFromUrl, recordValue } from "./values.js";

import { ManagedProviderStore } from "./managed-provider-store.js";
import { ModelVerifier } from "./model-verifier.js";
import { PackyCatalogService } from "./packy-catalog.js";

export class OpenCodeService {
  private readonly managedProviders: ManagedProviderStore;
  private readonly verifier: ModelVerifier;
  private readonly packyCatalog = new PackyCatalogService();
  private client: OpencodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private starting: Promise<void> | null = null;
  private managedPort: number | null = null;
  private readonly resolveAggregatorAddresses: AggregatorAddressResolver;

  constructor(
    private readonly config: OpenCodeConfig,
    stateDir?: string,
    security: OpenCodeServiceSecurityOptions = {},
  ) {
    this.managedProviders = new ManagedProviderStore(stateDir);
    this.verifier = new ModelVerifier(() => this.client, () => this.listProviders(), config.agent, stateDir);
    this.resolveAggregatorAddresses = security.resolveAggregatorAddresses
      ?? defaultAggregatorAddressResolver;
  }

  get expectedUrl(): string {
    return configuredOpenCodeUrl(this.config);
  }

  get url(): string {
    return this.server?.url ?? this.config.serverUrl ?? this.expectedUrl;
  }

  async start(): Promise<void> {
    if (this.client) return;
    if (!this.starting) {
      this.starting = this.startInternal()
        .catch((error) => {
          this.server?.close();
          this.server = null;
          this.client = null;
          throw error;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    await this.starting;
  }

  async listProviders(): Promise<ProviderCatalogItem[]> {
    await this.start();
    const client = this.requireClient();
    const [providerResult, authResult] = await Promise.all([
      client.provider.list({ throwOnError: true }),
      client.provider.auth({ throwOnError: true }),
    ]);
    const connected = new Set(providerResult.data.connected);
    return providerResult.data.all
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        connected: connected.has(provider.id),
        env: provider.env,
        authMethods: (authResult.data[provider.id] ?? []).map((method, index) => ({
          ...method,
          index,
        })),
        models: Object.values(provider.models)
          .filter((model) => model.status !== "deprecated")
          .map((model) => {
            const compatibleModel = model as RuntimeProviderModel;
            const variants = normalizeModelVariants(compatibleModel.variants);
            return {
              id: model.id,
              name: model.name,
              toolCall: model.tool_call ?? compatibleModel.capabilities?.toolcall ?? false,
              reasoning: model.reasoning ?? compatibleModel.capabilities?.reasoning ?? false,
              reasoningEfforts: Object.keys(variants),
              status: model.status ?? "active",
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async setApiKey(providerId: string, key: string): Promise<void> {
    await this.start();
    await this.requireClient().auth.set({
      path: { id: providerId },
      body: { type: "api", key },
      throwOnError: true,
    });
  }

  async listPackyProviders(): Promise<PackyProviderSummary[]> {
    await this.start();
    const client = this.requireClient();
    const [configResult, providers, packyCatalog] = await Promise.all([
      client.config.get({ throwOnError: true }),
      this.listProviders(),
      this.listPackyCatalog().catch(() => null),
    ]);
    const providerById = new Map(providers.map((provider) => [provider.id, provider]));
    return Object.entries(configResult.data.provider ?? {})
      .flatMap(([providerId, config]) => {
        const baseUrl = config.options?.baseURL;
        if (!baseUrl || !isPackyBaseUrl(baseUrl)) return [];
        const providerCatalog = providerById.get(providerId);
        const models = Object.entries(config.models ?? {})
          .map(([modelId, model]) => ({
            id: modelId,
            name: model.name ?? modelId,
            toolCall: providerCatalog?.models.find((item) => item.id === modelId)?.toolCall ?? false,
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        const group = inferPackyGroup(providerId, models, packyCatalog);
        return [{
          providerId,
          name: config.name ?? providerCatalog?.name ?? providerId,
          protocol: inferPackyProtocol(config.npm),
          baseUrl,
          connected: providerCatalog?.connected ?? false,
          models,
          ...(group ? { group } : {}),
        }];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async configurePackyProvider(
    input: PackyProviderConfiguration,
  ): Promise<PackyProviderSummary> {
    await this.start();
    const client = this.requireClient();
    const providers = await this.listRuntimeProviders();
    const enrichedInput: PackyProviderConfiguration = {
      ...input,
      models: enrichPackyModels(input.models, input.protocol, input.providerId, providers),
    };
    const providerConfig = createPackyProviderConfig(enrichedInput);
    if (this.config.serverUrl) {
      const current = await client.config.get({ throwOnError: true });
      await client.config.update({
        body: {
          provider: {
            ...(current.data.provider ?? {}),
            [input.providerId]: providerConfig,
          },
        },
        throwOnError: true,
      });
    } else {
      this.managedProviders.set("packy", input.providerId, providerConfig);
      await this.managedProviders.persist("packy");
    }
    await client.auth.set({
      path: { id: input.providerId },
      body: { type: "api", key: input.apiKey },
      throwOnError: true,
    });
    await this.reloadAfterProviderChange(client);
    let configured: PackyProviderSummary | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      configured = (await this.listPackyProviders())
        .find((provider) => provider.providerId === input.providerId);
      if (configured?.models.some((model) => input.models.some((item) => item.id === model.id))) break;
      if (attempt < 9) await delay(150);
    }
    if (!configured) throw new Error("PackyAPI 配置已保存，但 OpenCode 重载后仍未发现该供应商");
    return input.group ? { ...configured, group: input.group } : configured;
  }

  async listAggregatorProviders(): Promise<AggregatorProviderSummary[]> {
    await this.start();
    const client = this.requireClient();
    const [configResult, providers] = await Promise.all([
      client.config.get({ throwOnError: true }),
      this.listProviders(),
    ]);
    const providerById = new Map(providers.map((provider) => [provider.id, provider]));
    return Object.entries(configResult.data.provider ?? {})
      .flatMap(([providerId, config]) => {
        if (!providerId.startsWith("aggregate-")) return [];
        const baseUrl = config.options?.baseURL;
        if (!baseUrl) return [];
        const providerCatalog = providerById.get(providerId);
        const models = Object.entries(config.models ?? {})
          .map(([modelId, model]) => {
            const compatibleModel = model as ProviderModelConfig;
            return {
              id: modelId,
              name: model.name ?? modelId,
              toolCall: providerCatalog?.models.find((item) => item.id === modelId)?.toolCall ?? false,
              ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
              ...(compatibleModel.variants ? { variants: compatibleModel.variants } : {}),
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name));
        return [{
          providerId,
          name: config.name ?? providerCatalog?.name ?? providerId,
          baseUrl,
          connected: providerCatalog?.connected ?? false,
          models,
        }];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async discoverAggregatorModels(
    baseUrl: string,
    apiKey: string,
  ): Promise<AggregatorModelDiscovery> {
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/models`;
    let response: Response;
    try {
      await assertSafeAggregatorEndpoint(endpoint, this.resolveAggregatorAddresses);
      response = await fetch(endpoint, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`聚合供应商模型目录连接失败: ${readableFetchError(error)}`);
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) {
        throw new Error("API Key 无效，或该 Key 没有读取模型目录的权限");
      }
      throw new Error(`聚合供应商模型目录读取失败: HTTP ${response.status}`);
    }
    const rawCatalog = await readBoundedResponseText(response, AGGREGATOR_MAX_RESPONSE_BYTES);
    let parsedCatalog: unknown;
    try {
      parsedCatalog = rawCatalog ? JSON.parse(rawCatalog) : {};
    } catch {
      throw new Error("聚合供应商模型目录响应不是有效 JSON");
    }
    const discovered = parseAggregatorModelList(parsedCatalog);
    const probes = await mapWithConcurrency(discovered, 4, (model) =>
      probeAggregatorModel(baseUrl, apiKey, model, this.resolveAggregatorAddresses));
    const models = probes.flatMap((probe) => probe.ready ? [probe.model] : []);
    if (models.length === 0) {
      const reasons = [...new Set(probes.map((probe) => probe.error).filter(Boolean))]
        .slice(0, 3)
        .join("；");
      throw new Error(
        `目录返回了 ${discovered.length} 个模型，但没有模型通过真实工具调用验证`
        + (reasons ? `：${reasons}` : ""),
      );
    }
    return {
      models,
      discoveredModelCount: discovered.length,
      rejectedModelCount: discovered.length - models.length,
    };
  }

  async configureAggregatorProvider(
    input: AggregatorProviderConfiguration,
  ): Promise<AggregatorProviderSummary> {
    await this.start();
    const client = this.requireClient();
    const providers = await this.listRuntimeProviders();
    const models = enrichPackyModels(input.models, "openai", input.providerId, providers);
    const providerConfig = createPackyProviderConfig({
      name: input.name,
      protocol: "openai",
      baseUrl: input.baseUrl,
      models,
    });
    if (this.config.serverUrl) {
      const current = await client.config.get({ throwOnError: true });
      await client.config.update({
        body: {
          provider: {
            ...(current.data.provider ?? {}),
            [input.providerId]: providerConfig,
          },
        },
        throwOnError: true,
      });
    } else {
      this.managedProviders.set("aggregator", input.providerId, providerConfig);
      await this.managedProviders.persist("aggregator");
    }
    await client.auth.set({
      path: { id: input.providerId },
      body: { type: "api", key: input.apiKey },
      throwOnError: true,
    });
    await this.reloadAfterProviderChange(client);
    let configured: AggregatorProviderSummary | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      configured = (await this.listAggregatorProviders())
        .find((provider) => provider.providerId === input.providerId);
      if (configured?.models.some((model) => input.models.some((item) => item.id === model.id))) break;
      if (attempt < 9) await delay(150);
    }
    if (!configured) throw new Error("聚合供应商配置已保存，但 OpenCode 重载后仍未发现该供应商");
    await this.verifier.recordDirectVerifications(input.providerId, input.models);
    const discoveredModelCount = input.discoveredModelCount ?? input.models.length;
    return {
      ...configured,
      discoveredModelCount,
      rejectedModelCount: Math.max(0, discoveredModelCount - input.models.length),
    };
  }

  async startOAuth(providerId: string, method: number): Promise<ProviderAuthAuthorization> {
    await this.start();
    const result = await this.requireClient().provider.oauth.authorize({
      path: { id: providerId },
      body: { method },
      throwOnError: true,
    });
    return result.data;
  }

  async completeOAuth(providerId: string, method: number, code?: string): Promise<void> {
    await this.start();
    await this.requireClient().provider.oauth.callback({
      path: { id: providerId },
      body: { method, ...(code ? { code } : {}) },
      throwOnError: true,
    });
  }

  close(): void {
    this.server?.close();
    this.server = null;
    this.client = null;
  }

  private async reloadAfterProviderChange(client: OpencodeClient): Promise<void> {
    if (!this.config.serverUrl && this.server) {
      this.managedPort = portFromUrl(this.server.url) ?? this.managedPort;
      this.server.close();
      this.server = null;
      this.client = null;
      await delay(100);
      await this.start();
      return;
    }
    await client.instance.dispose({ throwOnError: true });
  }

  private async startInternal(): Promise<void> {
    await Promise.all([
      this.managedProviders.load(),
      this.verifier.load(),
    ]);
    await this.verifier.migrateManagedAggregatorVerifications(this.managedProviders.get("aggregator"));
    const runtimeConfig = this.runtimeConfig();
    const runtime = await connectOrStartOpenCode(runtimeConfig, {
      reuseExisting: Boolean(runtimeConfig.serverUrl),
    });
    this.server = runtime.server;
    this.client = runtime.client;
    if (runtime.server) this.managedPort = portFromUrl(runtime.url) ?? this.managedPort;
    if (!this.config.serverUrl && await this.upgradeManagedPackyProviders()) {
      await this.managedProviders.persist("packy");
      this.managedPort = this.server ? portFromUrl(this.server.url) ?? this.managedPort : this.managedPort;
      this.server?.close();
      this.server = null;
      this.client = null;
      await delay(100);
      const restarted = await connectOrStartOpenCode(this.runtimeConfig(), { reuseExisting: false });
      this.server = restarted.server;
      this.client = restarted.client;
      if (restarted.server) this.managedPort = portFromUrl(restarted.url) ?? this.managedPort;
    }
  }

  private async listRuntimeProviders(): Promise<RuntimeProvider[]> {
    const result = await this.requireClient().provider.list({ throwOnError: true });
    return result.data.all as unknown as RuntimeProvider[];
  }

  private async upgradeManagedPackyProviders(): Promise<boolean> {
    if (Object.keys(this.managedProviders.get("packy")).length === 0) return false;
    const providers = await this.listRuntimeProviders();
    let changed = false;
    for (const [providerId, config] of Object.entries(this.managedProviders.get("packy"))) {
      const protocol = inferPackyProtocol(config.npm);
      const models = Object.entries(config.models ?? {}).map(([modelId, model]) => ({
        id: modelId,
        name: model.name ?? modelId,
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.variants ? { variants: model.variants } : {}),
      }));
      const enriched = enrichPackyModels(models, protocol, providerId, providers);
      const nextModels = Object.fromEntries(enriched.map((model) => {
        const existing = config.models?.[model.id] ?? {};
        return [model.id, {
          ...existing,
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
          ...(model.variants ? { variants: model.variants } : {}),
        } satisfies ProviderModelConfig];
      }));
      const next = {
        ...config,
        options: {
          ...config.options,
          ...(typeof config.options?.baseURL === "string"
            ? { baseURL: normalizePackyProviderBaseUrl(config.options.baseURL, protocol) }
            : {}),
          timeout: false as const,
        },
        models: nextModels,
      };
      if (JSON.stringify(next) === JSON.stringify(config)) continue;
      this.managedProviders.set("packy", providerId, next);
      changed = true;
    }
    return changed;
  }

  private runtimeConfig(): OpenCodeConfig {
    const configuredProviders = recordValue(this.config.config.provider);
    const providers = {
      ...configuredProviders,
      ...this.managedProviders.get("packy"),
      ...this.managedProviders.get("aggregator"),
    };
    return {
      ...this.config,
      ...(this.managedPort !== null ? { port: this.managedPort } : {}),
      config: Object.keys(providers).length > 0
        ? { ...this.config.config, provider: providers }
        : { ...this.config.config },
    };
  }

  private requireClient(): OpencodeClient {
    if (!this.client) throw new Error("OpenCode 服务尚未启动");
    return this.client;
  }

  listPackyCatalog(force = false): Promise<PackyCatalog> {
    return this.packyCatalog.listPackyCatalog(force);
  }

  listPackyAuthorizedModels(apiKey: string): Promise<string[]> {
    return this.packyCatalog.listPackyAuthorizedModels(apiKey);
  }

  async listModelVerifications(): Promise<ModelVerificationRecord[]> {
    await this.start();
    return this.verifier.listModelVerifications();
  }

  async verifyModels(requests: ModelVerificationRequest[], force = false): Promise<ModelVerificationResult[]> {
    await this.start();
    return this.verifier.verifyModels(requests, force);
  }
}
