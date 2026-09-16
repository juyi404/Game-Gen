import type { ModelVariantOptions, PackyCatalog, PackyCatalogGroup, PackyCatalogModel, PackyEndpoint, PackyModelDefinition, PackyProtocol, PackyProviderConfig, PackyProviderConfiguration, ProviderModelConfig, RuntimeProvider } from "./contracts.js";
import { PACKY_CATALOG_URL, PACKY_ENDPOINTS, PACKY_PROTOCOL_DEFAULTS, PACKY_PROTOCOLS } from "./contracts.js";
import { recordValue, uniqueStrings } from "./values.js";

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

export function packyPricingMetadata(model: Record<string, unknown>): NonNullable<PackyCatalogModel["pricing"]> {
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

export function normalizePackyProviderBaseUrl(baseUrl: string, protocol: PackyProtocol): string {
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

export function enrichPackyModels(
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

export function inferredReasoningVariants(
  modelId: string,
  protocol: PackyProtocol,
): ModelVariantOptions | undefined {
  if (protocol !== "openai" || !/^kimi-k3(?:$|[-.:])/i.test(modelId)) return undefined;
  return Object.fromEntries(["low", "high", "max"].map((effort) => [
    effort,
    { reasoningEffort: effort },
  ]));
}

export function findReasoningProfile(
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

export function reasoningProfileScore(
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

export function normalizeModelVariants(value: unknown): ModelVariantOptions {
  const variants = recordValue(value);
  return Object.fromEntries(Object.entries(variants).flatMap(([name, options]) => {
    if (name === "default") return [];
    const normalized = recordValue(options);
    return Object.keys(normalized).length > 0 ? [[name, normalized]] : [];
  }));
}

export function inferReasoningCapability(modelId: string): boolean {
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

export function inferPackyProtocol(npm: string | undefined): PackyProtocol {
  if (npm?.includes("anthropic")) return "anthropic";
  if (npm?.includes("google")) return "google";
  return "openai";
}

export function inferPackyGroup(
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

export function protocolsForEndpoints(endpoints: PackyEndpoint[]): PackyProtocol[] {
  const protocols = new Set<PackyProtocol>();
  if (endpoints.includes("openai") || endpoints.includes("openai-response")) {
    protocols.add("openai");
  }
  if (endpoints.includes("anthropic")) protocols.add("anthropic");
  if (endpoints.includes("gemini")) protocols.add("google");
  return PACKY_PROTOCOLS.filter((protocol) => protocols.has(protocol));
}

export function commonProtocols(models: PackyCatalogModel[]): PackyProtocol[] {
  if (models.length === 0) return [];
  return PACKY_PROTOCOLS.filter((protocol) =>
    models.every((model) => model.protocols.includes(protocol)),
  );
}

export function preferredGroupProtocol(
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

export function groupDisplayName(groupId: string): string {
  return groupId.split("-").map((part) => part.length <= 3
    ? part.toUpperCase()
    : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
  ).join(" ");
}
