import type { OpenCodeConfig } from "../domain/types.js";
import type { AggregatorModelDiscovery, AggregatorProviderConfiguration, AggregatorProviderSummary, ModelVerificationRecord, ModelVerificationRequest, ModelVerificationResult, PackyCatalog, PackyProviderConfiguration, PackyProviderSummary, ProviderCatalogItem } from "../providers/contracts.js";

export interface ControlPlaneOptions {
  projectRoot: string;
  dataDir: string;
  outputDir: string;
  workspaceTemplate?: string;
  opencode: OpenCodeConfig;
  dashboard: { hostname: string; port: number };
}

export interface ProviderRuntime {
  readonly expectedUrl: string;
  readonly url: string;
  start(): Promise<void>;
  close(): void;
}

export interface ProviderCatalogReader {
  listProviders(): Promise<ProviderCatalogItem[]>;
}

export interface PackyCatalogReader {
  listPackyProviders(): Promise<PackyProviderSummary[]>;
  listPackyCatalog(force?: boolean): Promise<PackyCatalog>;
}

export interface AggregatorCatalogReader {
  listAggregatorProviders(): Promise<AggregatorProviderSummary[]>;
}

export interface ProviderDiscovery {
  listPackyAuthorizedModels(apiKey: string): Promise<string[]>;
  discoverAggregatorModels(
    baseUrl: string,
    apiKey: string,
  ): Promise<AggregatorModelDiscovery>;
}

export interface ProviderConfiguration {
  configurePackyProvider(input: PackyProviderConfiguration): Promise<PackyProviderSummary>;
  configureAggregatorProvider(
    input: AggregatorProviderConfiguration,
  ): Promise<AggregatorProviderSummary>;
}

export interface ModelVerificationGateway {
  listModelVerifications(): Promise<ModelVerificationRecord[]>;
  verifyModels(
    requests: ModelVerificationRequest[],
    force?: boolean,
  ): Promise<ModelVerificationResult[]>;
}

export interface ProviderCredentials {
  setApiKey(providerId: string, key: string): Promise<void>;
  startOAuth(providerId: string, method: number): Promise<{
    url: string;
    method: "auto" | "code";
    instructions: string;
  }>;
  completeOAuth(providerId: string, method: number, code?: string): Promise<void>;
}

/** Compatibility composition used at the application composition root. */
export interface ProviderGateway extends ProviderRuntime, ProviderCatalogReader,
  PackyCatalogReader, AggregatorCatalogReader, ProviderDiscovery,
  ProviderConfiguration, ModelVerificationGateway, ProviderCredentials {}
