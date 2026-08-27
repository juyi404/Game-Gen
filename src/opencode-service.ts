import {
  type OpencodeClient,
  type ProviderAuthAuthorization,
  type ProviderConfig,
} from "@opencode-ai/sdk";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { OpenCodeConfig } from "./types.js";
import { configuredOpenCodeUrl, connectOrStartOpenCode } from "./opencode-runtime.js";

export interface ProviderCatalogModel {
  id: string;
  name: string;
  toolCall: boolean;
  reasoning: boolean;
  reasoningEfforts: string[];
  status: string;
}

export interface ProviderCatalogItem {
  id: string;
  name: string;
  connected: boolean;
  env: string[];
  authMethods: Array<{ type: "oauth" | "api"; label: string; index: number }>;
  models: ProviderCatalogModel[];
}

export const PACKY_PROTOCOLS = ["openai", "anthropic", "google"] as const;
export type PackyProtocol = (typeof PACKY_PROTOCOLS)[number];

export const PACKY_CATALOG_URL = "https://www.packyapi.ai/api/pricing";
export const PACKY_MODEL_LIST_URL = "https://www.packyapi.com/v1/models";
const PACKY_CATALOG_CACHE_MS = 5 * 60 * 1000;
const DIRECT_VERIFICATION_TTL_MS = 60 * 60 * 1000;
const OPENCODE_VERIFICATION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_DISCOVERED_AGGREGATOR_MODELS = 50;
const AGGREGATOR_PROBE_TIMEOUT_MS = 15_000;
const AGGREGATOR_MAX_RESPONSE_BYTES = 1024 * 1024;
const MODEL_PROBE_TIMEOUT_MS = 45_000;
const PACKY_ENDPOINTS = [
  "openai",
  "openai-response",
  "anthropic",
  "gemini",
  "image-generation",
] as const;
export type PackyEndpoint = (typeof PACKY_ENDPOINTS)[number];

export const PACKY_PROTOCOL_DEFAULTS = {
  openai: {
    label: "GPT / Codex",
    npm: "@ai-sdk/openai",
    baseUrl: "https://www.packyapi.com/v1",
  },
  anthropic: {
    label: "Claude",
    npm: "@ai-sdk/anthropic",
    baseUrl: "https://www.packyapi.com/v1",
  },
  google: {
    label: "Gemini",
    npm: "@ai-sdk/google",
    baseUrl: "https://www.packyapi.com/v1beta",
  },
} as const satisfies Record<
  PackyProtocol,
  { label: string; npm: string; baseUrl: string }
>;

export interface PackyModelDefinition {
  id: string;
  name: string;
  reasoning?: boolean;
  variants?: ModelVariantOptions;
}

export interface PackyProviderConfiguration {
  providerId: string;
  name: string;
  protocol: PackyProtocol;
  baseUrl: string;
  apiKey: string;
  models: PackyModelDefinition[];
  group?: string;
}

export interface PackyProviderSummary {
  providerId: string;
  name: string;
  protocol: PackyProtocol;
  baseUrl: string;
  connected: boolean;
  models: Array<PackyModelDefinition & { toolCall: boolean }>;
  group?: string;
}

export interface AggregatorProviderConfiguration {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: PackyModelDefinition[];
  discoveredModelCount?: number;
}

export interface AggregatorProviderSummary {
  providerId: string;
  name: string;
  baseUrl: string;
  connected: boolean;
  models: Array<PackyModelDefinition & { toolCall: boolean }>;
  discoveredModelCount?: number;
  rejectedModelCount?: number;
}

export interface AggregatorModelDiscovery {
  models: PackyModelDefinition[];
  discoveredModelCount: number;
  rejectedModelCount: number;
}

export interface ModelVerificationRecord {
  providerId: string;
  modelId: string;
  verifiedAt: number;
  expiresAt: number;
  method: "direct" | "opencode";
  latencyMs: number;
}

export interface ModelVerificationRequest {
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
}

export interface ModelVerificationResult extends ModelVerificationRequest {
  ready: boolean;
  cached: boolean;
  error: string;
  record?: ModelVerificationRecord;
}

export interface PackyCatalogVendor {
  id: number;
  name: string;
}

export interface PackyCatalogModel {
  id: string;
  name: string;
  vendorId: number | null;
  vendor: string;
  groups: string[];
  endpoints: PackyEndpoint[];
  protocols: PackyProtocol[];
  sourceGeneration: boolean;
  pricing?: {
    quotaType?: number | string;
    modelRatio?: number | string;
    modelPrice?: number | string;
    completionRatio?: number | string;
    tiers?: unknown;
  };
}

export interface PackyCatalogGroup {
  id: string;
  name: string;
  description: string;
  modelCount: number;
  sourceModelCount: number;
  protocols: PackyProtocol[];
  defaultProtocol: PackyProtocol | null;
}

export interface PackyCatalog {
  source: string;
  fetchedAt: number;
  models: PackyCatalogModel[];
  groups: PackyCatalogGroup[];
  vendors: PackyCatalogVendor[];
}

export type ModelAccessStatus =
  | "ready"
  | "provider_missing"
  | "model_missing"
  | "tools_unsupported"
  | "reasoning_effort_unsupported"
  | "credential_missing";

export interface ModelAccessCheck {
  id: string;
  model: string;
  providerId: string;
  modelId: string;
  status: ModelAccessStatus;
  ready: boolean;
  message: string;
}

export type ModelVariantOptions = Record<string, Record<string, unknown>>;

type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[string] & {
  variants?: ModelVariantOptions;
};

type PackyProviderConfig = Omit<ProviderConfig, "models"> & {
  models?: Record<string, ProviderModelConfig>;
};

export type AggregatorAddressResolver = (hostname: string) => Promise<string[]>;

export interface OpenCodeServiceSecurityOptions {
  resolveAggregatorAddresses?: AggregatorAddressResolver;
}

interface RuntimeProviderModel {
  id: string;
  name: string;
  tool_call?: boolean;
  reasoning?: boolean;
  status?: string;
  capabilities?: { toolcall?: boolean; reasoning?: boolean };
  api?: { id?: string; npm?: string };
  variants?: Record<string, unknown>;
}

interface RuntimeProvider {
  id: string;
  name: string;
  env: string[];
  options?: Record<string, unknown>;
  models: Record<string, RuntimeProviderModel>;
}

export class OpenCodeService {
  private client: OpencodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private starting: Promise<void> | null = null;
  private packyCatalogCache: PackyCatalog | null = null;
  private packyCatalogLoading: Promise<PackyCatalog> | null = null;
  private managedPort: number | null = null;
  private managedPackyProviders: Record<string, PackyProviderConfig> = {};
  private managedPackyProvidersLoaded = false;
  private managedAggregatorProviders: Record<string, PackyProviderConfig> = {};
  private managedAggregatorProvidersLoaded = false;
  private modelVerifications: Record<string, ModelVerificationRecord> = {};
  private modelVerificationsLoaded = false;
  private readonly resolveAggregatorAddresses: AggregatorAddressResolver;

  constructor(
    private readonly config: OpenCodeConfig,
    private readonly stateDir?: string,
    security: OpenCodeServiceSecurityOptions = {},
  ) {
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

  async listPackyCatalog(force = false): Promise<PackyCatalog> {
    if (!force && this.packyCatalogCache
      && Date.now() - this.packyCatalogCache.fetchedAt < PACKY_CATALOG_CACHE_MS) {
      return this.packyCatalogCache;
    }
    if (!this.packyCatalogLoading) {
      this.packyCatalogLoading = this.fetchPackyCatalog().finally(() => {
        this.packyCatalogLoading = null;
      });
    }
    try {
      return await this.packyCatalogLoading;
    } catch (error) {
      if (this.packyCatalogCache) return this.packyCatalogCache;
      throw error;
    }
  }

  async listPackyAuthorizedModels(apiKey: string): Promise<string[]> {
    const response = await fetch(PACKY_MODEL_LIST_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) {
        throw new Error("PackyAPI Key 无效，或该 Key 没有模型目录权限");
      }
      throw new Error(`PackyAPI Key 检查失败: HTTP ${response.status}`);
    }
    return parsePackyModelList(await response.json());
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
      this.managedPackyProviders[input.providerId] = providerConfig;
      await this.persistManagedPackyProviders();
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
      this.managedAggregatorProviders[input.providerId] = providerConfig;
      await this.persistManagedAggregatorProviders();
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
    await this.recordDirectVerifications(input.providerId, input.models);
    const discoveredModelCount = input.discoveredModelCount ?? input.models.length;
    return {
      ...configured,
      discoveredModelCount,
      rejectedModelCount: Math.max(0, discoveredModelCount - input.models.length),
    };
  }

  async listModelVerifications(): Promise<ModelVerificationRecord[]> {
    await this.start();
    return Object.values(this.modelVerifications)
      .sort((left, right) => right.verifiedAt - left.verifiedAt);
  }

  async verifyModels(
    requests: ModelVerificationRequest[],
    force = false,
  ): Promise<ModelVerificationResult[]> {
    await this.start();
    const providers = await this.listProviders();
    const providerById = new Map(providers.map((provider) => [provider.id, provider]));
    const now = Date.now();
    const results = new Array<ModelVerificationResult>(requests.length);
    const pending: Array<{ index: number; request: ModelVerificationRequest }> = [];
    for (const [index, request] of requests.entries()) {
      const provider = providerById.get(request.providerId);
      const model = provider?.models.find((item) => item.id === request.modelId);
      const existing = this.modelVerifications[modelVerificationKey(request.providerId, request.modelId)];
      if (!provider) {
        results[index] = { ...request, ready: false, cached: false, error: "供应商不存在" };
      } else if (!model) {
        results[index] = { ...request, ready: false, cached: false, error: "模型不存在" };
      } else if (!model.toolCall) {
        results[index] = { ...request, ready: false, cached: false, error: "模型不支持工具调用" };
      } else if (!provider.connected) {
        results[index] = { ...request, ready: false, cached: false, error: "供应商尚未连接凭据" };
      } else if (!force && existing?.method === "opencode" && existing.expiresAt > now) {
        results[index] = { ...request, ready: true, cached: true, error: "", record: existing };
      } else {
        pending.push({ index, request });
      }
    }

    const probed = await mapWithConcurrency(pending, 4, async ({ index, request }) => ({
      index,
      result: await this.probeModelThroughOpenCode(request),
    }));
    let changed = false;
    for (const { index, result } of probed) {
      results[index] = result;
      const key = modelVerificationKey(result.providerId, result.modelId);
      if (result.ready && result.record) this.modelVerifications[key] = result.record;
      else delete this.modelVerifications[key];
      changed = true;
    }
    if (changed) await this.persistModelVerifications();
    return results;
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
      this.loadManagedPackyProviders(),
      this.loadManagedAggregatorProviders(),
      this.loadModelVerifications(),
    ]);
    await this.migrateManagedAggregatorVerifications();
    const runtimeConfig = this.runtimeConfig();
    const runtime = await connectOrStartOpenCode(runtimeConfig, {
      reuseExisting: Boolean(runtimeConfig.serverUrl),
    });
    this.server = runtime.server;
    this.client = runtime.client;
    if (runtime.server) this.managedPort = portFromUrl(runtime.url) ?? this.managedPort;
    if (!this.config.serverUrl && await this.upgradeManagedPackyProviders()) {
      await this.persistManagedPackyProviders();
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
    if (Object.keys(this.managedPackyProviders).length === 0) return false;
    const providers = await this.listRuntimeProviders();
    let changed = false;
    for (const [providerId, config] of Object.entries(this.managedPackyProviders)) {
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
      this.managedPackyProviders[providerId] = next;
      changed = true;
    }
    return changed;
  }

  private runtimeConfig(): OpenCodeConfig {
    const configuredProviders = recordValue(this.config.config.provider);
    const providers = {
      ...configuredProviders,
      ...this.managedPackyProviders,
      ...this.managedAggregatorProviders,
    };
    return {
      ...this.config,
      ...(this.managedPort !== null ? { port: this.managedPort } : {}),
      config: Object.keys(providers).length > 0
        ? { ...this.config.config, provider: providers }
        : { ...this.config.config },
    };
  }

  private async loadManagedPackyProviders(): Promise<void> {
    if (this.managedPackyProvidersLoaded) return;
    this.managedPackyProvidersLoaded = true;
    const statePath = this.managedPackyProviderPath();
    if (!statePath) return;
    try {
      const raw = recordValue(JSON.parse(await readFile(statePath, "utf8")));
      const providers = recordValue(raw.providers);
      this.managedPackyProviders = Object.fromEntries(
        Object.entries(providers).filter((entry): entry is [string, PackyProviderConfig] =>
          Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistManagedPackyProviders(): Promise<void> {
    const statePath = this.managedPackyProviderPath();
    if (!statePath) return;
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({
      version: 1,
      providers: this.managedPackyProviders,
    }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, statePath);
  }

  private managedPackyProviderPath(): string | null {
    return this.stateDir ? path.join(this.stateDir, "packy-providers.json") : null;
  }

  private async loadManagedAggregatorProviders(): Promise<void> {
    if (this.managedAggregatorProvidersLoaded) return;
    this.managedAggregatorProvidersLoaded = true;
    const statePath = this.managedAggregatorProviderPath();
    if (!statePath) return;
    try {
      const raw = recordValue(JSON.parse(await readFile(statePath, "utf8")));
      const providers = recordValue(raw.providers);
      this.managedAggregatorProviders = Object.fromEntries(
        Object.entries(providers).filter((entry): entry is [string, PackyProviderConfig] =>
          entry[0].startsWith("aggregate-")
          && Boolean(entry[1])
          && typeof entry[1] === "object"
          && !Array.isArray(entry[1]),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistManagedAggregatorProviders(): Promise<void> {
    const statePath = this.managedAggregatorProviderPath();
    if (!statePath) return;
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({
      version: 1,
      providers: this.managedAggregatorProviders,
    }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, statePath);
  }

  private managedAggregatorProviderPath(): string | null {
    return this.stateDir ? path.join(this.stateDir, "aggregator-providers.json") : null;
  }

  private async loadModelVerifications(): Promise<void> {
    if (this.modelVerificationsLoaded) return;
    this.modelVerificationsLoaded = true;
    const statePath = this.modelVerificationsPath();
    if (!statePath) return;
    try {
      const raw = recordValue(JSON.parse(await readFile(statePath, "utf8")));
      const records = Array.isArray(raw.records) ? raw.records : [];
      this.modelVerifications = Object.fromEntries(records.flatMap((value) => {
        const record = recordValue(value);
        if (typeof record.providerId !== "string"
          || typeof record.modelId !== "string"
          || typeof record.verifiedAt !== "number"
          || typeof record.expiresAt !== "number"
          || !["direct", "opencode"].includes(String(record.method))) return [];
        const normalized = {
          providerId: record.providerId,
          modelId: record.modelId,
          verifiedAt: record.verifiedAt,
          expiresAt: record.expiresAt,
          method: record.method as ModelVerificationRecord["method"],
          latencyMs: typeof record.latencyMs === "number" ? record.latencyMs : 0,
        } satisfies ModelVerificationRecord;
        return [[modelVerificationKey(normalized.providerId, normalized.modelId), normalized]];
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistModelVerifications(): Promise<void> {
    const statePath = this.modelVerificationsPath();
    if (!statePath) return;
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({
      version: 1,
      records: Object.values(this.modelVerifications),
    }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, statePath);
  }

  private modelVerificationsPath(): string | null {
    return this.stateDir ? path.join(this.stateDir, "model-verifications.json") : null;
  }

  private async recordDirectVerifications(
    providerId: string,
    models: PackyModelDefinition[],
  ): Promise<void> {
    const verifiedAt = Date.now();
    for (const model of models) {
      this.modelVerifications[modelVerificationKey(providerId, model.id)] = {
        providerId,
        modelId: model.id,
        verifiedAt,
        expiresAt: verifiedAt + DIRECT_VERIFICATION_TTL_MS,
        method: "direct",
        latencyMs: 0,
      };
    }
    await this.persistModelVerifications();
  }

  private async migrateManagedAggregatorVerifications(): Promise<void> {
    const verifiedAt = Date.now();
    let changed = false;
    for (const [providerId, config] of Object.entries(this.managedAggregatorProviders)) {
      for (const modelId of Object.keys(config.models ?? {})) {
        const key = modelVerificationKey(providerId, modelId);
        if (this.modelVerifications[key]) continue;
        this.modelVerifications[key] = {
          providerId,
          modelId,
          verifiedAt,
          expiresAt: verifiedAt + DIRECT_VERIFICATION_TTL_MS,
          method: "direct",
          latencyMs: 0,
        };
        changed = true;
      }
    }
    if (changed) await this.persistModelVerifications();
  }

  private async probeModelThroughOpenCode(
    request: ModelVerificationRequest,
  ): Promise<ModelVerificationResult> {
    const probeRoot = this.stateDir
      ? path.join(this.stateDir, "model-probes")
      : path.join(process.cwd(), ".gamebench", "model-probes");
    await mkdir(probeRoot, { recursive: true });
    const workspace = await mkdtemp(path.join(probeRoot, "probe-"));
    const markerName = "gamebench-model-probe.txt";
    const markerPath = path.join(workspace, markerName);
    const marker = randomUUID();
    const startedAt = Date.now();
    let sessionId: string | null = null;
    try {
      const client = this.requireClient();
      const session = await client.session.create({
        query: { directory: workspace },
        body: { title: `model probe · ${request.providerId}/${request.modelId}` },
        signal: AbortSignal.timeout(10_000),
        throwOnError: true,
      });
      sessionId = session.data.id;
      await client.session.prompt({
        path: { id: sessionId },
        query: { directory: workspace },
        body: {
          model: { providerID: request.providerId, modelID: request.modelId },
          agent: this.config.agent,
          system: "This is a model capability probe. Use the write tool exactly once as instructed. Do not inspect other files or perform any other action.",
          ...(request.reasoningEffort ? { variant: request.reasoningEffort } : {}),
          tools: { write: true, edit: false, bash: false, read: false, glob: false, grep: false, webfetch: false },
          parts: [{
            type: "text",
            text: `Use the write tool to create ${markerName} in the current directory with exactly this content: ${marker}`,
          }],
        },
        signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
        throwOnError: true,
      });
      const content = await readFile(markerPath, "utf8");
      if (content.trim() !== marker) throw new Error("模型响应完成，但没有正确执行写文件工具");
      const verifiedAt = Date.now();
      const record = {
        providerId: request.providerId,
        modelId: request.modelId,
        verifiedAt,
        expiresAt: verifiedAt + OPENCODE_VERIFICATION_TTL_MS,
        method: "opencode",
        latencyMs: verifiedAt - startedAt,
      } satisfies ModelVerificationRecord;
      return { ...request, ready: true, cached: false, error: "", record };
    } catch (error) {
      return {
        ...request,
        ready: false,
        cached: false,
        error: modelProbeError(error),
      };
    } finally {
      const client = this.client;
      if (client && sessionId) {
        await client.session.delete({
          path: { id: sessionId },
          query: { directory: workspace },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      }
      if (client) {
        await client.instance.dispose({
          query: { directory: workspace },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private requireClient(): OpencodeClient {
    if (!this.client) throw new Error("OpenCode 服务尚未启动");
    return this.client;
  }

  private async fetchPackyCatalog(): Promise<PackyCatalog> {
    const response = await fetch(PACKY_CATALOG_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`PackyAPI 模型目录读取失败: HTTP ${response.status}`);
    }
    const catalog = parsePackyCatalog(await response.json());
    this.packyCatalogCache = catalog;
    return catalog;
  }
}

export function parsePackyCatalog(raw: unknown, fetchedAt = Date.now()): PackyCatalog {
  const root = recordValue(raw);
  if (root.success !== true || !Array.isArray(root.data)) {
    throw new Error("PackyAPI 模型目录响应格式无效");
  }

  const vendors = Array.isArray(root.vendors)
    ? root.vendors.flatMap((value) => {
      const vendor = recordValue(value);
      return typeof vendor.id === "number" && typeof vendor.name === "string"
        ? [{ id: vendor.id, name: vendor.name }]
        : [];
    })
    : [];
  const vendorById = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
  const usableGroups = recordValue(root.usable_group);
  const inactiveGroups = new Set(
    Array.isArray(root.inactive_groups)
      ? root.inactive_groups.filter((value): value is string => typeof value === "string")
      : [],
  );

  const models = root.data.flatMap((value) => {
    const model = recordValue(value);
    if (typeof model.model_name !== "string" || !model.model_name.trim()) return [];
    const endpoints = uniqueStrings(model.supported_endpoint_types)
      .filter((endpoint): endpoint is PackyEndpoint => PACKY_ENDPOINTS.includes(endpoint as PackyEndpoint));
    const protocols = protocolsForEndpoints(endpoints);
    const id = model.model_name.trim();
    const vendorId = typeof model.vendor_id === "number" ? model.vendor_id : null;
    const pricing = packyPricingMetadata(model);
    return [{
      id,
      name: id,
      vendorId,
      vendor: vendorId === null ? "其他" : vendorById.get(vendorId) ?? "其他",
      groups: uniqueStrings(model.enable_groups),
      endpoints,
      protocols,
      sourceGeneration: protocols.length > 0 && !/(?:image|moderation|sora)/i.test(id),
      pricing,
    } satisfies PackyCatalogModel];
  }).sort((left, right) => left.vendor.localeCompare(right.vendor)
    || left.name.localeCompare(right.name));

  const groups = Object.entries(usableGroups)
    .filter(([groupId, description]) => typeof description === "string" && !inactiveGroups.has(groupId))
    .map(([groupId, description]) => {
      const groupModels = models.filter((model) => model.groups.includes(groupId));
      const sourceModels = groupModels.filter((model) => model.sourceGeneration);
      const protocols = commonProtocols(sourceModels);
      return {
        id: groupId,
        name: groupDisplayName(groupId),
        description: typeof description === "string" ? description : "",
        modelCount: groupModels.length,
        sourceModelCount: sourceModels.length,
        protocols,
        defaultProtocol: preferredGroupProtocol(groupId, protocols),
      } satisfies PackyCatalogGroup;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    source: PACKY_CATALOG_URL,
    fetchedAt,
    models,
    groups,
    vendors: vendors.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function packyPricingMetadata(model: Record<string, unknown>): NonNullable<PackyCatalogModel["pricing"]> {
  const pricing: NonNullable<PackyCatalogModel["pricing"]> = {};
  if (typeof model.quota_type === "number" || typeof model.quota_type === "string") {
    pricing.quotaType = model.quota_type;
  }
  if (typeof model.model_ratio === "number" || typeof model.model_ratio === "string") {
    pricing.modelRatio = model.model_ratio;
  }
  if (typeof model.model_price === "number" || typeof model.model_price === "string") {
    pricing.modelPrice = model.model_price;
  }
  if (typeof model.completion_ratio === "number" || typeof model.completion_ratio === "string") {
    pricing.completionRatio = model.completion_ratio;
  }
  if ("tiers" in model && model.tiers !== undefined) pricing.tiers = structuredClone(model.tiers);
  return pricing;
}

export function packyProviderIdForGroup(groupId: string): string {
  return `packy-${groupId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}

export function aggregatorProviderIdForBaseUrl(value: string): string {
  const url = new URL(value);
  const source = `${url.hostname}${url.port ? `-${url.port}` : ""}${url.pathname}`;
  const suffix = source
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 110);
  return `aggregate-${suffix || "provider"}`;
}

export function parsePackyModelList(raw: unknown): string[] {
  const root = recordValue(raw);
  if (!Array.isArray(root.data)) throw new Error("PackyAPI Key 返回的模型目录格式无效");
  const modelIds = root.data.flatMap((value) => {
    const model = recordValue(value);
    return typeof model.id === "string" && model.id.trim() ? [model.id.trim()] : [];
  });
  if (modelIds.length === 0) throw new Error("该 PackyAPI Key 当前没有可用模型");
  return [...new Set(modelIds)];
}

export function parseAggregatorModelList(raw: unknown): PackyModelDefinition[] {
  const root = recordValue(raw);
  const values = Array.isArray(raw)
    ? raw
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.models)
        ? root.models
        : null;
  if (!values) throw new Error("聚合供应商返回的模型目录格式无效");
  const models = values.flatMap((value) => {
    if (typeof value === "string" && value.trim()) {
      const id = value.trim();
      return [{ id, name: id }];
    }
    const model = recordValue(value);
    if (typeof model.id !== "string" || !model.id.trim()) return [];
    const id = model.id.trim();
    const name = typeof model.name === "string" && model.name.trim()
      ? model.name.trim()
      : id;
    return [{ id, name }];
  });
  const unique = [...new Map(models.map((model) => [model.id, model])).values()];
  if (unique.length === 0) throw new Error("该 API Key 当前没有可用模型");
  if (unique.length > MAX_DISCOVERED_AGGREGATOR_MODELS) {
    throw new Error(`该 API Key 返回 ${unique.length} 个模型，超过单次验证上限 ${MAX_DISCOVERED_AGGREGATOR_MODELS} 个；请使用更精确的模型分组 Key`);
  }
  return unique;
}

interface AggregatorModelProbe {
  model: PackyModelDefinition;
  ready: boolean;
  error: string;
}

async function probeAggregatorModel(
  baseUrl: string,
  apiKey: string,
  model: PackyModelDefinition,
  resolveAddresses: AggregatorAddressResolver,
): Promise<AggregatorModelProbe> {
  const root = baseUrl.replace(/\/+$/, "");
  const toolName = "gamebench_model_probe";
  const tool = {
    type: "function",
    function: {
      name: toolName,
      description: "Verify that this model can call a source-generation tool.",
      parameters: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  };
  const chat = await runAggregatorProbe(
    `${root}/chat/completions`,
    apiKey,
    {
      model: model.id,
      messages: [{
        role: "user",
        content: "Call gamebench_model_probe exactly once with ok=true. Do not answer with text.",
      }],
      tools: [tool],
      tool_choice: { type: "function", function: { name: toolName } },
      stream: false,
    },
    (raw) => {
      const response = recordValue(raw);
      if (!Array.isArray(response.choices)) return false;
      return response.choices.some((choice) => {
        const message = recordValue(recordValue(choice).message);
        const legacyCall = recordValue(message.function_call);
        if (legacyCall.name === toolName && validProbeArguments(legacyCall.arguments)) return true;
        return Array.isArray(message.tool_calls) && message.tool_calls.some((call) =>
          recordValue(recordValue(call).function).name === toolName
          && validProbeArguments(recordValue(recordValue(call).function).arguments));
      });
    },
    resolveAddresses,
  );
  if (chat.ready) return { model, ready: true, error: "" };
  if ([401, 403, 429].includes(chat.status ?? 0)) {
    return { model, ready: false, error: `${model.id}: ${chat.error}` };
  }

  const responsesTool = {
    type: "function",
    name: toolName,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
  const responses = await runAggregatorProbe(
    `${root}/responses`,
    apiKey,
    {
      model: model.id,
      input: "Call gamebench_model_probe exactly once with ok=true. Do not answer with text.",
      tools: [responsesTool],
      tool_choice: { type: "function", name: toolName },
      stream: false,
    },
    (raw) => {
      const response = recordValue(raw);
      return Array.isArray(response.output) && response.output.some((item) => {
        const output = recordValue(item);
        return output.type === "function_call"
          && output.name === toolName
          && validProbeArguments(output.arguments);
      });
    },
    resolveAddresses,
  );
  if (responses.ready) return { model, ready: true, error: "" };
  return {
    model,
    ready: false,
    error: `${model.id}: ${responses.error || chat.error}`,
  };
}

async function runAggregatorProbe(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  accepts: (raw: unknown) => boolean,
  resolveAddresses: AggregatorAddressResolver,
): Promise<{ ready: boolean; status?: number; error: string }> {
  let lastError = "调用失败";
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await assertSafeAggregatorEndpoint(endpoint, resolveAddresses);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(AGGREGATOR_PROBE_TIMEOUT_MS),
      });
      lastStatus = response.status;
      const rawText = await readBoundedResponseText(response, AGGREGATOR_MAX_RESPONSE_BYTES);
      if (!response.ok) {
        lastError = aggregatorApiError(response.status, rawText);
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await delay(retryDelayMs(response.headers.get("retry-after")));
          continue;
        }
        return { ready: false, status: response.status, error: lastError };
      }
      let raw: unknown;
      try {
        raw = rawText ? JSON.parse(rawText) : {};
      } catch {
        return { ready: false, status: response.status, error: "响应不是有效 JSON" };
      }
      return accepts(raw)
        ? { ready: true, status: response.status, error: "" }
        : { ready: false, status: response.status, error: "响应未产生所需的工具调用" };
    } catch (error) {
      lastError = readableFetchError(error);
      // A timeout or transport error is unlikely to improve immediately and
      // retrying every model makes large catalog scans grow without bound.
      return { ready: false, ...(lastStatus ? { status: lastStatus } : {}), error: lastError };
    }
  }
  return { ready: false, ...(lastStatus ? { status: lastStatus } : {}), error: lastError };
}

function aggregatorApiError(status: number, rawText: string): string {
  let message = "";
  try {
    const root = recordValue(JSON.parse(rawText));
    const error = recordValue(root.error);
    if (typeof error.message === "string") message = error.message;
    else if (typeof root.message === "string") message = root.message;
  } catch {}
  const compact = message.replace(/\s+/g, " ").trim().slice(0, 180);
  if ([401, 403].includes(status)) return `Key 无权限 (HTTP ${status})${compact ? `: ${compact}` : ""}`;
  if (status === 429) return `模型调用被限流 (HTTP 429)${compact ? `: ${compact}` : ""}`;
  return `模型调用失败 (HTTP ${status})${compact ? `: ${compact}` : ""}`;
}

function validProbeArguments(value: unknown): boolean {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return recordValue(parsed).ok === true;
  } catch {
    return false;
  }
}

function retryDelayMs(retryAfter: string | null): number {
  if (!retryAfter) return 1_000;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(10_000, Math.max(250, seconds * 1_000));
  const date = Date.parse(retryAfter);
  if (Number.isNaN(date)) return 1_000;
  return Math.min(10_000, Math.max(250, date - Date.now()));
}

function readableFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown } | undefined;
  if (cause?.code === "UND_ERR_CONNECT_TIMEOUT") return "连接供应商超时";
  if (error.name === "TimeoutError") return "模型调用超时";
  return error.message === "fetch failed" ? "无法连接供应商" : error.message;
}

async function defaultAggregatorAddressResolver(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

export async function assertSafeAggregatorEndpoint(
  value: string,
  resolveAddresses: AggregatorAddressResolver = defaultAggregatorAddressResolver,
): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("聚合供应商地址必须是无账号、查询参数和片段的 HTTPS 地址");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw new Error("聚合供应商地址不能指向本机或内网");
  }

  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await resolveAddresses(hostname);
    } catch (error) {
      throw new Error(`聚合供应商域名解析失败: ${readableFetchError(error)}`);
    }
  }
  if (addresses.length === 0) throw new Error("聚合供应商域名没有可用 IP 地址");
  const forbidden = addresses.find((address) => isForbiddenAggregatorAddress(address));
  if (forbidden) {
    throw new Error(`聚合供应商地址解析到非公网 IP，已拒绝连接: ${forbidden}`);
  }
}

export function isForbiddenAggregatorAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(address);
  if (family === 4) return isForbiddenIpv4(address);
  if (family !== 6) return true;
  const words = parseIpv6Words(address);
  if (!words) return true;

  // IPv4-mapped IPv6 and the well-known NAT64 prefix must inherit the
  // embedded IPv4 address classification.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isForbiddenIpv4(wordsToIpv4(words[6]!, words[7]!));
  }
  if (words[0] === 0x64 && words[1] === 0xff9b
    && words.slice(2, 6).every((word) => word === 0)) {
    return isForbiddenIpv4(wordsToIpv4(words[6]!, words[7]!));
  }
  // Only globally-routable IPv6 unicast is accepted. This rejects loopback,
  // ULA, link-local, multicast and other special-use address space.
  if ((words[0]! & 0xe000) !== 0x2000) return true;
  if (words[0] === 0x2001 && (words[1] === 0 || words[1] === 0x0db8)) return true;
  if (words[0] === 0x2002) {
    return isForbiddenIpv4(wordsToIpv4(words[1]!, words[2]!));
  }
  return false;
}

function isForbiddenIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)
    || octet < 0 || octet > 255)) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function parseIpv6Words(value: string): number[] | null {
  let source = value.toLowerCase();
  if (source.includes(".")) {
    const colon = source.lastIndexOf(":");
    if (colon < 0) return null;
    const octets = source.slice(colon + 1).split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)
      || octet < 0 || octet > 255)) return null;
    source = `${source.slice(0, colon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}`
      + `:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const values = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (values.length !== 8 || values.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return values.map((word) => Number.parseInt(word, 16));
}

function wordsToIpv4(high: number, low: number): string {
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

async function readBoundedResponseText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`聚合供应商响应超过 ${limit} 字节上限`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`聚合供应商响应超过 ${limit} 字节上限`);
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export function createPackyProviderConfig(
  input: Omit<PackyProviderConfiguration, "apiKey" | "providerId">,
): PackyProviderConfig {
  const models = Object.fromEntries(input.models.map((model) => [model.id, {
      id: model.id,
      name: model.name,
      tool_call: true,
      status: "active",
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.variants && Object.keys(model.variants).length > 0
        ? { variants: model.variants }
        : {}),
    } satisfies ProviderModelConfig])) as Record<string, ProviderModelConfig>;
  return {
    name: input.name,
    npm: PACKY_PROTOCOL_DEFAULTS[input.protocol].npm,
    options: {
      baseURL: normalizePackyProviderBaseUrl(input.baseUrl, input.protocol),
      setCacheKey: true,
      timeout: false,
    },
    models,
  };
}

function normalizePackyProviderBaseUrl(baseUrl: string, protocol: PackyProtocol): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (protocol !== "anthropic" || !isPackyBaseUrl(normalized)) return normalized;
  try {
    const url = new URL(normalized);
    if (url.pathname.replace(/\/+$/, "") !== "") return normalized;
    url.pathname = "/v1";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function enrichPackyModels(
  models: PackyModelDefinition[],
  protocol: PackyProtocol,
  excludedProviderId: string,
  providers: RuntimeProvider[],
): PackyModelDefinition[] {
  return models.map((model) => {
    const profile = findReasoningProfile(model.id, protocol, excludedProviderId, providers);
    const reasoning = model.reasoning ?? profile.reasoning ?? inferReasoningCapability(model.id);
    const variants = model.variants ?? profile.variants ?? inferredReasoningVariants(model.id, protocol);
    return {
      id: model.id,
      name: model.name,
      ...(reasoning ? { reasoning: true } : {}),
      ...(variants && Object.keys(variants).length > 0 ? { variants } : {}),
    };
  });
}

function inferredReasoningVariants(
  modelId: string,
  protocol: PackyProtocol,
): ModelVariantOptions | undefined {
  if (protocol !== "openai" || !/^kimi-k3(?:$|[-.:])/i.test(modelId)) return undefined;
  return Object.fromEntries(["low", "high", "max"].map((effort) => [
    effort,
    { reasoningEffort: effort },
  ]));
}

function findReasoningProfile(
  modelId: string,
  protocol: PackyProtocol,
  excludedProviderId: string,
  providers: RuntimeProvider[],
): { reasoning?: boolean; variants?: ModelVariantOptions } {
  const targetNpm = PACKY_PROTOCOL_DEFAULTS[protocol].npm;
  const candidates = providers.flatMap((provider) => {
    const baseUrl = typeof provider.options?.baseURL === "string" ? provider.options.baseURL : "";
    if (provider.id === excludedProviderId || (baseUrl && isPackyBaseUrl(baseUrl))) return [];
    return Object.values(provider.models).flatMap((model) => {
      const apiId = model.api?.id;
      if (model.id !== modelId && apiId !== modelId) return [];
      return [{
        providerId: provider.id,
        npm: model.api?.npm,
        reasoning: model.reasoning ?? model.capabilities?.reasoning ?? false,
        variants: normalizeModelVariants(model.variants),
      }];
    });
  }).sort((left, right) => reasoningProfileScore(right, protocol, targetNpm)
    - reasoningProfileScore(left, protocol, targetNpm));
  const matchingTransport = candidates.find((candidate) => candidate.npm === targetNpm);
  const source = matchingTransport ?? candidates[0];
  if (!source) return {};
  const sourceVariants = Object.keys(source.variants).length > 0
    ? source.variants
    : undefined;
  if (matchingTransport || protocol !== "openai" || !sourceVariants) {
    return {
      reasoning: source.reasoning,
      ...(sourceVariants ? { variants: sourceVariants } : {}),
    };
  }
  const variants = Object.fromEntries(Object.keys(sourceVariants).map((effort) => [
    effort,
    { reasoningEffort: effort },
  ]));
  return { reasoning: source.reasoning, ...(Object.keys(variants).length > 0 ? { variants } : {}) };
}

function reasoningProfileScore(
  profile: { providerId: string; npm: string | undefined; reasoning: boolean; variants: ModelVariantOptions },
  protocol: PackyProtocol,
  targetNpm: string,
): number {
  const canonicalProvider = protocol === "openai" ? "openai" : protocol;
  return (profile.providerId === canonicalProvider ? 1_000 : 0)
    + (profile.npm === targetNpm ? 500 : 0)
    + (profile.reasoning ? 100 : 0)
    + Object.keys(profile.variants).length;
}

function normalizeModelVariants(value: unknown): ModelVariantOptions {
  const variants = recordValue(value);
  return Object.fromEntries(Object.entries(variants).flatMap(([name, options]) => {
    if (name === "default") return [];
    const normalized = recordValue(options);
    return Object.keys(normalized).length > 0 ? [[name, normalized]] : [];
  }));
}

function inferReasoningCapability(modelId: string): boolean {
  return /(?:^|[/._-])(?:gpt-5|o[1-9](?:[/._-]|$)|claude|gemini-(?:2\.5|3)|grok|deepseek-(?:reasoner|r1|v4)|kimi|k2|glm|qwen|minimax|magistral|seed)/i.test(modelId);
}

export function isPackyBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "cf.api.fan"
      || /(^|\.)packyapi\.(com|ai)$/.test(hostname)
      || /(^|\.)packycode\.com$/.test(hostname);
  } catch {
    return false;
  }
}

function inferPackyProtocol(npm: string | undefined): PackyProtocol {
  if (npm?.includes("anthropic")) return "anthropic";
  if (npm?.includes("google")) return "google";
  return "openai";
}

function inferPackyGroup(
  providerId: string,
  models: PackyModelDefinition[],
  catalog: PackyCatalog | null,
): string | undefined {
  if (!catalog) return undefined;
  const providerGroup = catalog.groups.find(
    (group) => packyProviderIdForGroup(group.id) === providerId,
  );
  if (providerGroup) return providerGroup.id;
  if (models.length === 0) return undefined;
  const commonGroups = catalog.groups.filter((group) => models.every((model) =>
    catalog.models.some((catalogModel) =>
      catalogModel.id === model.id && catalogModel.groups.includes(group.id),
    ),
  ));
  return commonGroups.length === 1 ? commonGroups[0]?.id : undefined;
}

function protocolsForEndpoints(endpoints: PackyEndpoint[]): PackyProtocol[] {
  const protocols = new Set<PackyProtocol>();
  if (endpoints.includes("openai") || endpoints.includes("openai-response")) {
    protocols.add("openai");
  }
  if (endpoints.includes("anthropic")) protocols.add("anthropic");
  if (endpoints.includes("gemini")) protocols.add("google");
  return PACKY_PROTOCOLS.filter((protocol) => protocols.has(protocol));
}

function commonProtocols(models: PackyCatalogModel[]): PackyProtocol[] {
  if (models.length === 0) return [];
  return PACKY_PROTOCOLS.filter((protocol) =>
    models.every((model) => model.protocols.includes(protocol)),
  );
}

function preferredGroupProtocol(
  groupId: string,
  protocols: PackyProtocol[],
): PackyProtocol | null {
  if (/gemini/i.test(groupId) && protocols.includes("google")) return "google";
  if (/(?:claude|^cc(?:-|$)|^aws(?:-|$)|kimi)/i.test(groupId)
    && protocols.includes("anthropic")) {
    return "anthropic";
  }
  if (protocols.includes("openai")) return "openai";
  if (protocols.includes("anthropic")) return "anthropic";
  if (protocols.includes("google")) return "google";
  return null;
}

function groupDisplayName(groupId: string): string {
  return groupId.split("-").map((part) => part.length <= 3
    ? part.toUpperCase()
    : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
  ).join(" ");
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function modelVerificationKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function modelProbeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return "OpenCode 端到端工具调用验证超时";
  const message = error.message.replace(/\s+/g, " ").trim();
  return message || "OpenCode 端到端工具调用验证失败";
}

function portFromUrl(value: string): number | null {
  const port = Number(new URL(value).port);
  return Number.isInteger(port) && port > 0 ? port : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function validateModelAccess(
  models: Array<{ id: string; model: string; reasoningEffort?: string | undefined }>,
  providers: ProviderCatalogItem[],
): ModelAccessCheck[] {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  return models.map((model) => {
    const slash = model.model.indexOf("/");
    const providerId = slash > 0 ? model.model.slice(0, slash) : "";
    const modelId = slash > 0 ? model.model.slice(slash + 1) : "";
    const provider = providerById.get(providerId);
    if (!provider) {
      return accessCheck(model, providerId, modelId, "provider_missing", "供应商不存在");
    }
    const catalogModel = provider.models.find((item) => item.id === modelId);
    if (!catalogModel) {
      return accessCheck(model, providerId, modelId, "model_missing", "OpenCode 中找不到该模型");
    }
    if (!catalogModel.toolCall) {
      return accessCheck(model, providerId, modelId, "tools_unsupported", "模型不支持工具调用，无法生成源码");
    }
    if (model.reasoningEffort
      && !catalogModel.reasoningEfforts.includes(model.reasoningEffort)) {
      const available = catalogModel.reasoningEfforts.length > 0
        ? catalogModel.reasoningEfforts.join("、")
        : "无可调档位";
      return accessCheck(
        model,
        providerId,
        modelId,
        "reasoning_effort_unsupported",
        `模型不支持推理强度 ${model.reasoningEffort}；当前可选：${available}`,
      );
    }
    if (!provider.connected) {
      return accessCheck(model, providerId, modelId, "credential_missing", "尚未连接 API Key 或登录凭据");
    }
    return accessCheck(model, providerId, modelId, "ready", "可用于游戏生成");
  });
}

function accessCheck(
  model: { id: string; model: string },
  providerId: string,
  modelId: string,
  status: ModelAccessStatus,
  message: string,
): ModelAccessCheck {
  return {
    id: model.id,
    model: model.model,
    providerId,
    modelId,
    status,
    ready: status === "ready",
    message,
  };
}
