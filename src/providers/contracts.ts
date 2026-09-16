import type { ProviderConfig } from "@opencode-ai/sdk";

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

export const PACKY_CATALOG_CACHE_MS = 5 * 60 * 1000;

export const DIRECT_VERIFICATION_TTL_MS = 60 * 60 * 1000;

export const OPENCODE_VERIFICATION_TTL_MS = 6 * 60 * 60 * 1000;

export const MAX_DISCOVERED_AGGREGATOR_MODELS = 50;

export const AGGREGATOR_PROBE_TIMEOUT_MS = 15_000;

export const AGGREGATOR_MAX_RESPONSE_BYTES = 1024 * 1024;

export const MODEL_PROBE_TIMEOUT_MS = 120_000;

export const MODEL_PROBE_FILE_SETTLE_MS = 5_000;

export const PACKY_ENDPOINTS = [
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
  reasoningEffort?: string;
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

export type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[string] & {
  variants?: ModelVariantOptions;
};

export type PackyProviderConfig = Omit<ProviderConfig, "models"> & {
  models?: Record<string, ProviderModelConfig>;
};

export type AggregatorAddressResolver = (hostname: string) => Promise<string[]>;

export interface OpenCodeServiceSecurityOptions {
  resolveAggregatorAddresses?: AggregatorAddressResolver;
}

export interface RuntimeProviderModel {
  id: string;
  name: string;
  tool_call?: boolean;
  reasoning?: boolean;
  status?: string;
  capabilities?: { toolcall?: boolean; reasoning?: boolean };
  api?: { id?: string; npm?: string };
  variants?: Record<string, unknown>;
}

export interface RuntimeProvider {
  id: string;
  name: string;
  env: string[];
  options?: Record<string, unknown>;
  models: Record<string, RuntimeProviderModel>;
}
