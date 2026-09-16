import type { InfrastructureScope } from "./harness-failure.js";

export const RUN_STATUSES = [
  "queued",
  "preparing",
  "running",
  "retrying",
  "awaiting_stage",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const EXPERIMENT_STATUSES = [
  "queued",
  "running",
  "paused",
  "awaiting_stage",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export type StageMode = "all" | "manual";
export type RoundStatus = "pending" | "running" | "completed" | "failed";
export type EventLevel = "debug" | "info" | "warn" | "error";

export interface PackyBillingSnapshot {
  provider: "packy";
  group: string;
  catalogSource: string;
  catalogFetchedAt: number;
  pricing: {
    quotaType?: number | string;
    modelRatio?: number | string;
    modelPrice?: number | string;
    completionRatio?: number | string;
    tiers?: unknown;
  };
}

export interface ModelConfig {
  id: string;
  model: string;
  provider: string;
  modelName: string;
  enabled: boolean;
  concurrency: number;
  /** Per-model hard round timeout override. Zero disables the hard timeout. */
  roundTimeoutMs?: number;
  reasoningEffort?: string;
  agent?: string;
  systemPrompt?: string;
  billingSnapshot?: PackyBillingSnapshot;
}

export interface RoundDefinition {
  id: string;
  prompt: string;
  timeoutMs?: number;
}

export interface TaskDefinition {
  id: string;
  title: string;
  description?: string;
  sourcePath: string;
  seedDir?: string;
  rounds: RoundDefinition[];
  metadata: Record<string, unknown>;
}

export interface RuntimeConfig {
  harness: "opencode" | "mock";
  stageMode: StageMode;
  globalConcurrency: number;
  providerConcurrency: Record<string, number>;
  outputDir: string;
  dataDir: string;
  roundTimeoutMs: number;
  roundIdleTimeoutMs: number;
  /** Initial build budget; automatic retries retain it, explicit manual retries renew it. */
  initialBuildSoftTimeoutMs?: number;
  /** Bounded same-session delivery pass after the initial build budget. */
  initialBuildWrapUpMs?: number;
  maxAttempts: number;
  retryBackoffMs: number;
  workspaceTemplate?: string;
}

export interface DashboardConfig {
  hostname: string;
  port: number;
}

export interface OpenCodeConfig {
  serverUrl?: string;
  hostname: string;
  port: number;
  startupTimeoutMs: number;
  agent: string;
  config: Record<string, unknown>;
}

export interface MockConfig {
  delayMs: number;
  failTaskIds: string[];
}

export interface ResolvedBenchmarkConfig {
  version: 1;
  name: string;
  sourcePath: string;
  datasetDir: string;
  includeTaskIds: string[];
  models: ModelConfig[];
  runtime: RuntimeConfig;
  dashboard: DashboardConfig;
  opencode: OpenCodeConfig;
  mock: MockConfig;
  systemPrompt: string;
}

export interface ExperimentRecord {
  id: string;
  name: string;
  status: ExperimentStatus;
  stageMode: StageMode;
  targetRound: number;
  maxRounds: number;
  configPath: string;
  config: ResolvedBenchmarkConfig;
  totalRuns: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
}

export interface RunRecord {
  id: string;
  experimentId: string;
  taskId: string;
  taskTitle: string;
  modelId: string;
  providerId: string;
  modelName: string;
  status: RunStatus;
  currentRound: number;
  totalRounds: number;
  attempt: number;
  maxAttempts: number;
  resumePending: boolean;
  availableAt: number;
  workspacePath: string | null;
  sessionId: string | null;
  error: string | null;
  queuedAt: number;
  startedAt: number | null;
  /** Persisted initial-build budget anchor; renewed only by an explicit manual retry. */
  initialBuildStartedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface RunListRecord extends RunRecord {
  completedRounds: number;
}

export interface RunPage {
  runs: RunListRecord[];
  page: number;
  pageSize: number;
  totalTasks: number;
  totalPages: number;
  hasNextPage: boolean;
}

export interface ModelRunSummary {
  modelId: string;
  providerId: string;
  total: number;
  queued: number;
  preparing: number;
  running: number;
  retrying: number;
  awaitingStage: number;
  completed: number;
  failed: number;
  cancelled: number;
  completedRounds: number;
  totalRounds: number;
}

export interface RoundRecord {
  runId: string;
  roundIndex: number;
  roundId: string;
  prompt: string;
  status: RoundStatus;
  startedAt: number | null;
  completedAt: number | null;
  response: string | null;
  error: string | null;
}

export interface GenerationEvent {
  id: number;
  experimentId: string;
  runId: string | null;
  type: string;
  level: EventLevel;
  message: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface ExperimentSummary {
  total: number;
  queued: number;
  preparing: number;
  running: number;
  retrying: number;
  awaitingStage: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface RoundSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface HarnessRunContext {
  run: RunRecord;
  model: ModelConfig;
  task: TaskDefinition;
  workspacePath: string;
  signal: AbortSignal;
  /** A successful engine/provider exchange can release an infrastructure probe early. */
  reportHealthy?: (scope: InfrastructureScope) => void;
  emit: (
    type: string,
    level: EventLevel,
    message: string,
    data?: Record<string, unknown>,
  ) => void;
}

export interface HarnessUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface HarnessRoundResult {
  response: string;
  usage?: HarnessUsage;
}

/**
 * Adapters throw HarnessFailure for recovery decisions; untyped errors use the bounded attempt budget.
 * Optional methods declare supported capabilities. Transport checks must never submit generation work.
 */
export interface GenerationHarness {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Read-only transport check. Must not create a session or call a generation endpoint. */
  checkInfrastructure?(scope: InfrastructureScope, providerId: string): Promise<void>;
  beginRun(context: HarnessRunContext): Promise<string>;
  executeRound(
    context: HarnessRunContext,
    sessionId: string,
    round: RoundDefinition,
    roundIndex: number,
  ): Promise<HarnessRoundResult>;
  captureRoundContext?(
    context: HarnessRunContext,
    sessionId: string,
    round: RoundDefinition,
    roundIndex: number,
  ): Promise<unknown>;
  abortRun(sessionId: string, workspacePath: string): Promise<void>;
  requestFinalize?(sessionId: string, workspacePath: string): Promise<void>;
  releaseRun?(
    sessionId: string | null,
    workspacePath: string,
    options?: { preserveSession?: boolean },
  ): Promise<void>;
}
