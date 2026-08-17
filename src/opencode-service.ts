import {
  type OpencodeClient,
  type ProviderAuthAuthorization,
  type ProviderConfig,
} from "@opencode-ai/sdk";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
    baseUrl: "https://www.packyapi.com",
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

  constructor(
    private readonly config: OpenCodeConfig,
    private readonly stateDir?: string,
  ) {}

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
    await this.loadManagedPackyProviders();
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
        options: { ...config.options, timeout: false as const },
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
    return [{
      id,
      name: id,
      vendorId,
      vendor: vendorId === null ? "其他" : vendorById.get(vendorId) ?? "其他",
      groups: uniqueStrings(model.enable_groups),
      endpoints,
      protocols,
      sourceGeneration: protocols.length > 0 && !/(?:image|moderation|sora)/i.test(id),
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

export function packyProviderIdForGroup(groupId: string): string {
  return `packy-${groupId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
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

export function createPackyProviderConfig(
  input: Omit<PackyProviderConfiguration, "apiKey" | "providerId">,
): PackyProviderConfig {
  const models: Record<string, ProviderModelConfig> = {};
  for (const model of input.models) {
    models[model.id] = {
      id: model.id,
      name: model.name,
      tool_call: true,
      status: "active",
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.variants && Object.keys(model.variants).length > 0
        ? { variants: model.variants }
        : {}),
    };
  }
  return {
    name: input.name,
    npm: PACKY_PROTOCOL_DEFAULTS[input.protocol].npm,
    options: {
      baseURL: input.baseUrl.replace(/\/+$/, ""),
      setCacheKey: true,
      timeout: false,
    },
    models,
  };
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
    const variants = model.variants ?? profile.variants;
    return {
      id: model.id,
      name: model.name,
      ...(reasoning ? { reasoning: true } : {}),
      ...(variants && Object.keys(variants).length > 0 ? { variants } : {}),
    };
  });
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
