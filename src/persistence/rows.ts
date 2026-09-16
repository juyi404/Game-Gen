import type { EventLevel, ExperimentRecord, ExperimentStatus, GenerationEvent, ResolvedBenchmarkConfig, RoundRecord, RoundStatus, RunRecord, RunStatus, StageMode } from "../domain/types.js";

export type DbRow = Record<string, unknown>;

export function mapExperiment(row: DbRow): ExperimentRecord {
  const stageMode = stringValue(row.stage_mode) as StageMode;
  const config = JSON.parse(stringValue(row.config_json)) as ResolvedBenchmarkConfig;
  config.runtime.stageMode ??= stageMode;
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    status: stringValue(row.status) as ExperimentStatus,
    stageMode,
    targetRound: numberValue(row.target_round),
    maxRounds: numberValue(row.max_rounds),
    configPath: stringValue(row.config_path),
    config,
    totalRuns: numberValue(row.total_runs),
    createdAt: numberValue(row.created_at),
    startedAt: nullableNumber(row.started_at),
    completedAt: nullableNumber(row.completed_at),
    error: nullableString(row.error),
  };
}

export function mapRun(row: DbRow): RunRecord {
  return {
    id: stringValue(row.id),
    experimentId: stringValue(row.experiment_id),
    taskId: stringValue(row.task_id),
    taskTitle: stringValue(row.task_title),
    modelId: stringValue(row.model_id),
    providerId: stringValue(row.provider_id),
    modelName: stringValue(row.model_name),
    status: stringValue(row.status) as RunStatus,
    currentRound: numberValue(row.current_round),
    totalRounds: numberValue(row.total_rounds),
    attempt: numberValue(row.attempt),
    maxAttempts: numberValue(row.max_attempts),
    resumePending: numberValue(row.resume_pending) === 1,
    availableAt: numberValue(row.available_at),
    workspacePath: nullableString(row.workspace_path),
    sessionId: nullableString(row.session_id),
    error: nullableString(row.error),
    queuedAt: numberValue(row.queued_at),
    startedAt: nullableNumber(row.started_at),
    initialBuildStartedAt: nullableNumber(row.initial_build_started_at),
    completedAt: nullableNumber(row.completed_at),
    updatedAt: numberValue(row.updated_at),
  };
}

export function mapRound(row: DbRow): RoundRecord {
  return {
    runId: stringValue(row.run_id),
    roundIndex: numberValue(row.round_index),
    roundId: stringValue(row.round_id),
    prompt: stringValue(row.prompt),
    status: stringValue(row.status) as RoundStatus,
    startedAt: nullableNumber(row.started_at),
    completedAt: nullableNumber(row.completed_at),
    response: nullableString(row.response),
    error: nullableString(row.error),
  };
}

export function mapEvent(row: DbRow): GenerationEvent {
  return {
    id: numberValue(row.id),
    experimentId: stringValue(row.experiment_id),
    runId: nullableString(row.run_id),
    type: stringValue(row.type),
    level: stringValue(row.level) as EventLevel,
    message: stringValue(row.message),
    data: JSON.parse(stringValue(row.data_json)) as Record<string, unknown>,
    createdAt: numberValue(row.created_at),
  };
}

export function stringValue(value: unknown): string {
  return String(value);
}

export function numberValue(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

export function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function finiteNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function positiveIntegerEnvironment(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function boundedEventData(
  data: Record<string, unknown>,
  maximumBytes: number,
): Record<string, unknown> {
  const serialized = JSON.stringify(data);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maximumBytes) return data;
  return {
    truncated: true,
    originalBytes,
    preview: Buffer.from(serialized, "utf8").subarray(0, maximumBytes).toString("utf8"),
  };
}
