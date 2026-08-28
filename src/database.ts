import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  EventLevel,
  ExperimentRecord,
  ExperimentStatus,
  ExperimentSummary,
  GenerationEvent,
  HarnessUsage,
  ModelRunSummary,
  ResolvedBenchmarkConfig,
  RoundRecord,
  RoundSummary,
  RoundStatus,
  RunRecord,
  RunPage,
  RunStatus,
  StageMode,
  TaskDefinition,
} from "./types.js";

type DbRow = Record<string, unknown>;

const DEFAULT_EVENT_RETENTION_PER_EXPERIMENT = 200_000;
const DEFAULT_EVENT_RETENTION_GLOBAL = 1_000_000;
const EVENT_PRUNE_INTERVAL = 1_000;
const DEFAULT_EVENT_DATA_MAX_BYTES = 128 * 1024;

export interface EventPage {
  events: GenerationEvent[];
  hasMore: boolean;
}

export interface InfrastructureRetryState {
  attempts: number;
  firstFailedAt: number | null;
}

export interface UsageSummary extends HarnessUsage {
  rounds: number;
}

export class BenchmarkDatabase extends EventEmitter {
  readonly filePath: string;
  private readonly db: DatabaseSync;
  private readonly eventRetentionPerExperiment: number;
  private readonly eventRetentionGlobal: number;
  private readonly eventDataMaxBytes: number;
  private eventsSincePrune = 0;

  constructor(filePath: string) {
    super();
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.eventRetentionPerExperiment = positiveIntegerEnvironment(
      "GAMEBENCH_EVENT_RETENTION_PER_EXPERIMENT",
      DEFAULT_EVENT_RETENTION_PER_EXPERIMENT,
    );
    this.eventRetentionGlobal = positiveIntegerEnvironment(
      "GAMEBENCH_EVENT_RETENTION_GLOBAL",
      DEFAULT_EVENT_RETENTION_GLOBAL,
    );
    this.eventDataMaxBytes = positiveIntegerEnvironment(
      "GAMEBENCH_EVENT_DATA_MAX_BYTES",
      DEFAULT_EVENT_DATA_MAX_BYTES,
    );
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createExperiment(config: ResolvedBenchmarkConfig, tasks: TaskDefinition[]): ExperimentRecord {
    const id = randomUUID();
    const now = Date.now();
    const enabledModels = config.models.filter((model) => model.enabled);
    const totalRuns = tasks.length * enabledModels.length;
    const maxRounds = tasks.reduce((maximum, task) => Math.max(maximum, task.rounds.length), 0);
    const targetRound = config.runtime.stageMode === "manual" ? 1 : maxRounds;
    const insertExperiment = this.db.prepare(`
      INSERT INTO experiments (
        id, name, status, stage_mode, target_round, max_rounds,
        config_path, config_json, total_runs, created_at
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRun = this.db.prepare(`
      INSERT INTO runs (
        id, experiment_id, task_id, task_title, model_id, provider_id, model_name,
        status, current_round, total_rounds, attempt, max_attempts, available_at,
        queued_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, 0, ?, ?, ?, ?)
    `);
    const insertRound = this.db.prepare(`
      INSERT INTO rounds (run_id, round_index, round_id, prompt, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);

    this.transaction(() => {
      insertExperiment.run(
        id,
        config.name,
        config.runtime.stageMode,
        targetRound,
        maxRounds,
        config.sourcePath,
        JSON.stringify(config),
        totalRuns,
        now,
      );
      for (const task of tasks) {
        for (const model of enabledModels) {
          const runId = randomUUID();
          insertRun.run(
            runId,
            id,
            task.id,
            task.title,
            model.id,
            model.provider,
            model.modelName,
            task.rounds.length,
            config.runtime.maxAttempts,
            now,
            now,
            now,
          );
          for (const [index, round] of task.rounds.entries()) {
            insertRound.run(runId, index, round.id, round.prompt);
          }
        }
      }
    });

    this.appendEvent(id, null, "experiment.created", "info", "生成实验已创建", {
      tasks: tasks.length,
      models: enabledModels.length,
      totalRuns,
      stageMode: config.runtime.stageMode,
      targetRound,
      maxRounds,
    });
    return this.getExperiment(id)!;
  }

  getExperiment(id: string): ExperimentRecord | null {
    const row = this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapExperiment(row) : null;
  }

  listExperiments(): ExperimentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM experiments ORDER BY created_at DESC")
      .all() as DbRow[];
    return rows.map(mapExperiment);
  }

  listRecoverableExperiments(): ExperimentRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM experiments WHERE status IN ('queued', 'running', 'paused') ORDER BY created_at DESC",
      )
      .all() as DbRow[];
    return rows.map(mapExperiment);
  }

  updateExperimentStatus(id: string, status: ExperimentStatus, error: string | null = null): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE experiments SET
          status = ?,
          error = ?,
          started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
          completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE NULL END
        WHERE id = ?
      `)
      .run(status, error, status, now, status, now, id);
  }

  advanceExperimentStage(id: string): ExperimentRecord {
    const experiment = this.getExperiment(id);
    if (!experiment) throw new Error(`生成实验不存在: ${id}`);
    if (experiment.stageMode !== "manual") throw new Error("该任务不是分阶段生成模式");
    if (experiment.status !== "awaiting_stage") throw new Error("只有当前阶段全部完成后才能启动下一阶段");
    if (experiment.targetRound >= experiment.maxRounds) throw new Error("所有生成阶段均已完成");
    const targetRound = experiment.targetRound + 1;
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE experiments SET target_round = ?, status = 'queued', error = NULL,
          completed_at = NULL
        WHERE id = ? AND status = 'awaiting_stage' AND target_round = ?
      `)
      .run(targetRound, id, experiment.targetRound);
    this.appendEvent(id, null, "experiment.stage.advanced", "info", `已开放第 ${targetRound} 阶段`, {
      targetRound,
      maxRounds: experiment.maxRounds,
      advancedAt: now,
    });
    return this.getExperiment(id)!;
  }

  recoverInterruptedRuns(experimentId: string): void {
    const now = Date.now();
    this.transaction(() => {
      this.db
        .prepare(`
          UPDATE runs SET status = 'queued', error = NULL, completed_at = NULL,
            current_round = (
              SELECT COUNT(*) FROM rounds
              WHERE rounds.run_id = runs.id AND rounds.status = 'completed'
            ),
            resume_pending = 1, available_at = ?, updated_at = ?
          WHERE experiment_id = ? AND status IN ('preparing', 'running')
        `)
        .run(now, now, experimentId);
      this.db
        .prepare(`
          UPDATE rounds SET status = 'pending', started_at = NULL, completed_at = NULL,
            response = NULL, error = NULL, usage_json = NULL
          WHERE status IN ('running', 'failed')
            AND run_id IN (
              SELECT id FROM runs
              WHERE experiment_id = ? AND status = 'queued' AND resume_pending = 1
            )
        `)
        .run(experimentId);
    });
  }

  listRuns(experimentId: string): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE experiment_id = ? ORDER BY queued_at, task_id, model_id")
      .all(experimentId) as DbRow[];
    return rows.map(mapRun);
  }

  listRunPage(
    experimentId: string,
    options: { page?: number; pageSize?: number; search?: string; status?: RunStatus } = {},
  ): RunPage {
    const requestedPage = Math.max(1, Math.trunc(options.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize ?? 100)));
    const search = options.search?.trim().toLowerCase() ?? "";
    const conditions = ["experiment_id = ?"];
    const parameters: Array<string | number> = [experimentId];
    if (search) {
      conditions.push("(instr(lower(task_id), ?) > 0 OR instr(lower(task_title), ?) > 0)");
      parameters.push(search, search);
    }
    if (options.status) {
      conditions.push(`EXISTS (
        SELECT 1 FROM runs AS status_runs
        WHERE status_runs.experiment_id = runs.experiment_id
          AND status_runs.task_id = runs.task_id
          AND status_runs.status = ?
      )`);
      parameters.push(options.status);
    }
    const where = conditions.join(" AND ");
    const count = this.db
      .prepare(`SELECT COUNT(DISTINCT task_id) AS total FROM runs WHERE ${where}`)
      .get(...parameters) as DbRow;
    const totalTasks = numberValue(count.total);
    const totalPages = Math.ceil(totalTasks / pageSize);
    const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
    const taskRows = this.db
      .prepare(`
        SELECT task_id, MIN(queued_at) AS first_queued,
          MIN(CASE status
            WHEN 'running' THEN 0
            WHEN 'preparing' THEN 1
            WHEN 'retrying' THEN 2
            WHEN 'queued' THEN 3
            WHEN 'awaiting_stage' THEN 4
            WHEN 'completed' THEN 5
            WHEN 'failed' THEN 6
            WHEN 'cancelled' THEN 7
            ELSE 8
          END) AS status_priority
        FROM runs
        WHERE ${where}
        GROUP BY task_id
        ORDER BY status_priority, first_queued, task_id
        LIMIT ? OFFSET ?
      `)
      .all(...parameters, pageSize, (page - 1) * pageSize) as DbRow[];
    const taskIds = taskRows.map((row) => stringValue(row.task_id));
    if (taskIds.length === 0) {
      return { runs: [], page, pageSize, totalTasks, totalPages, hasNextPage: false };
    }
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT runs.*, (
          SELECT COUNT(*) FROM rounds
          WHERE rounds.run_id = runs.id AND rounds.status = 'completed'
        ) AS completed_rounds
        FROM runs
        WHERE experiment_id = ? AND task_id IN (${placeholders})
        ORDER BY queued_at, task_id, model_id
      `)
      .all(experimentId, ...taskIds) as DbRow[];
    const taskOrder = new Map(taskIds.map((taskId, index) => [taskId, index]));
    rows.sort((left, right) => {
      const taskDifference = (taskOrder.get(stringValue(left.task_id)) ?? taskIds.length)
        - (taskOrder.get(stringValue(right.task_id)) ?? taskIds.length);
      if (taskDifference !== 0) return taskDifference;
      return stringValue(left.model_id).localeCompare(stringValue(right.model_id));
    });
    return {
      runs: rows.map((row) => ({ ...mapRun(row), completedRounds: numberValue(row.completed_rounds) })),
      page,
      pageSize,
      totalTasks,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }

  getModelRunSummaries(experimentId: string): ModelRunSummary[] {
    const rows = this.db
      .prepare(`
        SELECT
          runs.model_id,
          runs.provider_id,
          COUNT(*) AS total,
          SUM(CASE WHEN runs.status = 'queued' THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN runs.status = 'preparing' THEN 1 ELSE 0 END) AS preparing,
          SUM(CASE WHEN runs.status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN runs.status = 'retrying' THEN 1 ELSE 0 END) AS retrying,
          SUM(CASE WHEN runs.status = 'awaiting_stage' THEN 1 ELSE 0 END) AS awaiting_stage,
          SUM(CASE WHEN runs.status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN runs.status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN runs.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
          SUM(COALESCE(round_counts.completed_rounds, 0)) AS completed_rounds,
          SUM(runs.total_rounds) AS total_rounds,
          MIN(runs.queued_at) AS first_queued
        FROM runs
        LEFT JOIN (
          SELECT run_id, COUNT(*) AS completed_rounds
          FROM rounds
          WHERE status = 'completed'
          GROUP BY run_id
        ) AS round_counts ON round_counts.run_id = runs.id
        WHERE runs.experiment_id = ?
        GROUP BY runs.model_id, runs.provider_id
        ORDER BY first_queued, runs.model_id
      `)
      .all(experimentId) as DbRow[];
    return rows.map((row) => ({
      modelId: stringValue(row.model_id),
      providerId: stringValue(row.provider_id),
      total: numberValue(row.total),
      queued: numberValue(row.queued),
      preparing: numberValue(row.preparing),
      running: numberValue(row.running),
      retrying: numberValue(row.retrying),
      awaitingStage: numberValue(row.awaiting_stage),
      completed: numberValue(row.completed),
      failed: numberValue(row.failed),
      cancelled: numberValue(row.cancelled),
      completedRounds: numberValue(row.completed_rounds),
      totalRounds: numberValue(row.total_rounds),
    }));
  }

  listRunnableRuns(
    experimentId: string,
    now = Date.now(),
    limit?: number,
  ): RunRecord[] {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error(`可运行任务查询上限无效: ${limit}`);
    }
    const normalizedLimit = limit === undefined ? null : Math.min(limit, 10_000);
    const rows = this.db
      .prepare(`
        SELECT runs.* FROM runs
        JOIN experiments ON experiments.id = runs.experiment_id
        WHERE runs.experiment_id = ? AND (
          (runs.status IN ('queued', 'retrying') AND runs.available_at <= ?)
          OR (runs.status = 'awaiting_stage' AND runs.current_round < experiments.target_round)
        )
        ORDER BY
          CASE WHEN runs.resume_pending = 1 THEN 0 ELSE 1 END,
          runs.available_at, runs.queued_at, runs.task_id, runs.model_id
        ${normalizedLimit === null ? "" : "LIMIT ?"}
      `)
      .all(...(normalizedLimit === null
        ? [experimentId, now]
        : [experimentId, now, normalizedLimit])) as DbRow[];
    return rows.map(mapRun);
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapRun(row) : null;
  }

  claimRun(id: string): RunRecord | null {
    const current = this.getRun(id);
    if (!current) return null;
    const now = Date.now();
    const result = this.db
      .prepare(`
        UPDATE runs SET status = 'preparing',
          attempt = CASE
            WHEN status = 'awaiting_stage' OR resume_pending = 1 THEN attempt
            ELSE attempt + 1
          END,
          resume_pending = 0,
          error = NULL,
          started_at = COALESCE(started_at, ?), completed_at = NULL, updated_at = ?
        WHERE id = ? AND (
          (status IN ('queued', 'retrying') AND available_at <= ?)
          OR (
            status = 'awaiting_stage'
            AND current_round < (SELECT target_round FROM experiments WHERE id = runs.experiment_id)
          )
        )
      `)
      .run(now, now, id, now);
    if (Number(result.changes) === 0) return null;
    const claimed = this.getRun(id);
    return claimed ? { ...claimed, resumePending: current.resumePending } : null;
  }

  updateRun(
    id: string,
    values: {
      status?: RunStatus;
      currentRound?: number;
      workspacePath?: string | null;
      sessionId?: string | null;
      error?: string | null;
      availableAt?: number;
    },
  ): void {
    const current = this.getRun(id);
    if (!current) throw new Error(`运行不存在: ${id}`);
    const status = values.status ?? current.status;
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE runs SET status = ?, current_round = ?, workspace_path = ?, session_id = ?,
          error = ?, available_at = ?, updated_at = ?,
          completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE NULL END
        WHERE id = ?
      `)
      .run(
        status,
        values.currentRound ?? current.currentRound,
        values.workspacePath === undefined ? current.workspacePath : values.workspacePath,
        values.sessionId === undefined ? current.sessionId : values.sessionId,
        values.error === undefined ? current.error : values.error,
        values.availableAt ?? current.availableAt,
        now,
        status,
        now,
        id,
      );
  }

  retryRun(
    id: string,
    delayMs: number,
    error: string,
    options: { preserveProgress?: boolean; preserveSession?: boolean } = {},
  ): void {
    const now = Date.now();
    if (options.preserveProgress) {
      this.transaction(() => {
        this.db
          .prepare(`
            UPDATE rounds SET status = 'pending', started_at = NULL, completed_at = NULL,
              response = NULL, error = NULL, usage_json = NULL
            WHERE run_id = ? AND status != 'completed'
          `)
          .run(id);
        this.db
          .prepare(`
            UPDATE runs SET status = 'retrying',
              current_round = (
                SELECT COUNT(*) FROM rounds
                WHERE rounds.run_id = runs.id AND rounds.status = 'completed'
              ),
              resume_pending = 1, error = ?, available_at = ?, completed_at = NULL,
              updated_at = ?
            WHERE id = ?
          `)
          .run(error, now + delayMs, now, id);
      });
      return;
    }
    this.transaction(() => {
      this.db
        .prepare(`
          UPDATE rounds SET status = 'pending', started_at = NULL, completed_at = NULL,
            response = NULL, error = NULL, usage_json = NULL WHERE run_id = ?
        `)
        .run(id);
      this.db
        .prepare(`
          UPDATE runs SET status = 'retrying', current_round = 0, resume_pending = 0,
            session_id = CASE WHEN ? THEN session_id ELSE NULL END,
            error = ?, available_at = ?, completed_at = NULL,
            updated_at = ? WHERE id = ?
        `)
        .run(options.preserveSession ? 1 : 0, error, now + delayMs, now, id);
    });
  }

  recordInfrastructureFailure(id: string, failedAt = Date.now()): InfrastructureRetryState {
    this.db
      .prepare(`
        UPDATE runs SET infra_attempts = infra_attempts + 1,
          infra_first_failed_at = COALESCE(infra_first_failed_at, ?), updated_at = ?
        WHERE id = ?
      `)
      .run(failedAt, failedAt, id);
    return this.getInfrastructureRetryState(id);
  }

  getInfrastructureRetryState(id: string): InfrastructureRetryState {
    const row = this.db
      .prepare("SELECT infra_attempts, infra_first_failed_at FROM runs WHERE id = ?")
      .get(id) as DbRow | undefined;
    if (!row) throw new Error(`运行不存在: ${id}`);
    return {
      attempts: numberValue(row.infra_attempts),
      firstFailedAt: nullableNumber(row.infra_first_failed_at),
    };
  }

  clearInfrastructureFailures(id: string): void {
    this.db
      .prepare("UPDATE runs SET infra_attempts = 0, infra_first_failed_at = NULL WHERE id = ?")
      .run(id);
  }

  resetFailedRun(id: string): void {
    const run = this.getRun(id);
    if (!run) throw new Error(`运行不存在: ${id}`);
    if (!['failed', 'cancelled'].includes(run.status)) {
      throw new Error("只能重试失败或已取消的运行");
    }
    const now = Date.now();
    this.transaction(() => {
      this.db
        .prepare(`
          UPDATE rounds SET status = 'pending', started_at = NULL, completed_at = NULL,
            response = NULL, error = NULL, usage_json = NULL
          WHERE run_id = ? AND status != 'completed'
        `)
        .run(id);
      this.db
        .prepare(`
          UPDATE runs SET status = 'queued',
            current_round = (
              SELECT COUNT(*) FROM rounds
              WHERE rounds.run_id = runs.id AND rounds.status = 'completed'
            ),
            attempt = CASE WHEN workspace_path IS NOT NULL THEN attempt + 1 ELSE attempt END,
            max_attempts = MAX(max_attempts, attempt + 1), available_at = ?,
            session_id = NULL, error = NULL, completed_at = NULL, updated_at = ?,
            resume_pending = CASE WHEN workspace_path IS NOT NULL THEN 1 ELSE 0 END,
            infra_attempts = 0, infra_first_failed_at = NULL
          WHERE id = ?
        `)
        .run(now, now, id);
    });
  }

  getRounds(runId: string): RoundRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM rounds WHERE run_id = ? ORDER BY round_index")
      .all(runId) as DbRow[];
    return rows.map(mapRound);
  }

  updateRound(
    runId: string,
    roundIndex: number,
    status: RoundStatus,
    values: { response?: string | null; error?: string | null; usage?: HarnessUsage | null } = {},
  ): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE rounds SET status = ?,
          started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
          completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END,
          response = COALESCE(?, response), error = ?,
          usage_json = COALESCE(?, usage_json)
        WHERE run_id = ? AND round_index = ?
      `)
      .run(
        status,
        status,
        now,
        status,
        now,
        values.response ?? null,
        values.error ?? null,
        values.usage === undefined || values.usage === null
          ? null
          : JSON.stringify(values.usage),
        runId,
        roundIndex,
      );
  }

  getSummary(experimentId: string): ExperimentSummary {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN status = 'preparing' THEN 1 ELSE 0 END) AS preparing,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END) AS retrying,
          SUM(CASE WHEN status = 'awaiting_stage' THEN 1 ELSE 0 END) AS awaiting_stage,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
        FROM runs WHERE experiment_id = ?
      `)
      .get(experimentId) as DbRow;
    return {
      total: numberValue(row.total),
      queued: numberValue(row.queued),
      preparing: numberValue(row.preparing),
      running: numberValue(row.running),
      retrying: numberValue(row.retrying),
      awaitingStage: numberValue(row.awaiting_stage),
      completed: numberValue(row.completed),
      failed: numberValue(row.failed),
      cancelled: numberValue(row.cancelled),
    };
  }

  getRoundSummary(
    experimentId: string,
    options: { openedOnly?: boolean } = {},
  ): RoundSummary {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN rounds.status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN rounds.status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN rounds.status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN rounds.status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM rounds
        JOIN runs ON runs.id = rounds.run_id
        JOIN experiments ON experiments.id = runs.experiment_id
        WHERE runs.experiment_id = ?
          ${options.openedOnly ? "AND rounds.round_index < experiments.target_round" : ""}
      `)
      .get(experimentId) as DbRow;
    return {
      total: numberValue(row.total),
      pending: numberValue(row.pending),
      running: numberValue(row.running),
      completed: numberValue(row.completed),
      failed: numberValue(row.failed),
    };
  }

  getUsageSummary(experimentId: string): UsageSummary {
    const rows = this.db
      .prepare(`
        SELECT rounds.usage_json
        FROM rounds
        JOIN runs ON runs.id = rounds.run_id
        WHERE runs.experiment_id = ? AND rounds.usage_json IS NOT NULL
      `)
      .all(experimentId) as DbRow[];
    const summary: UsageSummary = {
      rounds: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    for (const row of rows) {
      const usage = JSON.parse(stringValue(row.usage_json)) as Partial<HarnessUsage>;
      summary.rounds += 1;
      summary.input += finiteNumber(usage.input);
      summary.output += finiteNumber(usage.output);
      summary.reasoning += finiteNumber(usage.reasoning);
      summary.cacheRead += finiteNumber(usage.cacheRead);
      summary.cacheWrite += finiteNumber(usage.cacheWrite);
      summary.cost += finiteNumber(usage.cost);
    }
    return summary;
  }

  appendEvent(
    experimentId: string,
    runId: string | null,
    type: string,
    level: EventLevel,
    message: string,
    data: Record<string, unknown> = {},
  ): GenerationEvent {
    const createdAt = Date.now();
    const storedData = boundedEventData(data, this.eventDataMaxBytes);
    const result = this.db
      .prepare(`
        INSERT INTO events (experiment_id, run_id, type, level, message, data_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(experimentId, runId, type, level, message, JSON.stringify(storedData), createdAt);
    const event: GenerationEvent = {
      id: Number(result.lastInsertRowid),
      experimentId,
      runId,
      type,
      level,
      message,
      data: storedData,
      createdAt,
    };
    this.emit("event", event);
    this.eventsSincePrune += 1;
    if (this.eventsSincePrune >= EVENT_PRUNE_INTERVAL) {
      this.eventsSincePrune = 0;
      this.pruneEvents(experimentId);
    }
    return event;
  }

  listEvents(options: {
    experimentId: string;
    runId?: string;
    afterId?: number;
    beforeId?: number;
    limit?: number;
    newest?: boolean;
  }): GenerationEvent[] {
    return this.listEventPage(options).events;
  }

  listEventPage(options: {
    experimentId: string;
    runId?: string;
    afterId?: number;
    beforeId?: number;
    limit?: number;
    newest?: boolean;
  }): EventPage {
    const afterId = Math.max(0, options.afterId ?? 0);
    const beforeId = Math.max(1, options.beforeId ?? Number.MAX_SAFE_INTEGER);
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2_000);
    const newest = options.newest === true;
    const runCondition = options.runId ? " AND run_id = ?" : "";
    const cursorCondition = newest ? "id < ?" : "id > ?";
    const order = newest ? "DESC" : "ASC";
    const statement: StatementSync = this.db.prepare(`
      SELECT * FROM events
      WHERE experiment_id = ?${runCondition} AND ${cursorCondition}
      ORDER BY id ${order} LIMIT ?
    `);
    const parameters: Array<string | number> = [options.experimentId];
    if (options.runId) parameters.push(options.runId);
    parameters.push(newest ? beforeId : afterId, limit + 1);
    const rows = statement.all(...parameters) as DbRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    if (newest) selected.reverse();
    return { events: selected.map(mapEvent), hasMore };
  }

  pruneEvents(experimentId?: string): void {
    this.transaction(() => {
      if (experimentId) {
        this.db.prepare(`
          DELETE FROM events
          WHERE experiment_id = ? AND id <= COALESCE((
            SELECT id FROM events
            WHERE experiment_id = ?
            ORDER BY id DESC LIMIT 1 OFFSET ?
          ), -1)
        `).run(experimentId, experimentId, this.eventRetentionPerExperiment);
      }
      this.db.prepare(`
        DELETE FROM events
        WHERE id <= COALESCE((
          SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?
        ), -1)
      `).run(this.eventRetentionGlobal);
    });
  }

  listRecentEvents(experimentId: string, limit = 100): GenerationEvent[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = this.db
      .prepare(`
        SELECT * FROM events WHERE experiment_id = ?
        ORDER BY id DESC LIMIT ?
      `)
      .all(experimentId, safeLimit) as DbRow[];
    return rows.reverse().map(mapEvent);
  }

  cancelQueuedRuns(experimentId: string): number {
    const now = Date.now();
    const result = this.db
      .prepare(`
        UPDATE runs SET status = 'cancelled', completed_at = ?, updated_at = ?
        WHERE experiment_id = ? AND status IN ('queued', 'retrying')
      `)
      .run(now, now, experimentId);
    return Number(result.changes);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        stage_mode TEXT NOT NULL DEFAULT 'all',
        target_round INTEGER NOT NULL DEFAULT 0,
        max_rounds INTEGER NOT NULL DEFAULT 0,
        config_path TEXT NOT NULL,
        config_json TEXT NOT NULL,
        total_runs INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        task_title TEXT NOT NULL,
        model_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        status TEXT NOT NULL,
        current_round INTEGER NOT NULL,
        total_rounds INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        workspace_path TEXT,
        session_id TEXT,
        error TEXT,
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        resume_pending INTEGER NOT NULL DEFAULT 0,
        infra_attempts INTEGER NOT NULL DEFAULT 0,
        infra_first_failed_at INTEGER,
        UNIQUE(experiment_id, task_id, model_id)
      );

      CREATE TABLE IF NOT EXISTS rounds (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        round_index INTEGER NOT NULL,
        round_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        response TEXT,
        error TEXT,
        usage_json TEXT,
        PRIMARY KEY(run_id, round_index)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_experiment_status
        ON runs(experiment_id, status, available_at);
      CREATE INDEX IF NOT EXISTS idx_runs_runnable_order
        ON runs(experiment_id, status, available_at, queued_at, task_id, model_id);
      CREATE INDEX IF NOT EXISTS idx_events_experiment_id
        ON events(experiment_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_run_id
        ON events(run_id, id);
    `);
    this.ensureColumn("experiments", "stage_mode", "TEXT NOT NULL DEFAULT 'all'");
    this.ensureColumn("experiments", "target_round", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("experiments", "max_rounds", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "resume_pending", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "infra_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "infra_first_failed_at", "INTEGER");
    this.ensureColumn("rounds", "usage_json", "TEXT");
    this.db.exec(`
      UPDATE experiments
      SET max_rounds = COALESCE((
        SELECT MAX(total_rounds) FROM runs WHERE runs.experiment_id = experiments.id
      ), 0)
      WHERE max_rounds = 0;
      UPDATE experiments
      SET target_round = max_rounds
      WHERE stage_mode = 'all' AND target_round != max_rounds;

      UPDATE runs
      SET status = 'awaiting_stage', completed_at = NULL
      WHERE status = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM experiments
          WHERE experiments.id = runs.experiment_id
            AND experiments.status = 'cancelled'
            AND experiments.stage_mode = 'manual'
            AND experiments.target_round > 0
            AND experiments.target_round < runs.total_rounds
            AND (
              SELECT COUNT(*)
              FROM rounds
              WHERE rounds.run_id = runs.id
                AND rounds.round_index < experiments.target_round
                AND rounds.status = 'completed'
            ) = experiments.target_round
        );
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[];
    if (columns.some((item) => stringValue(item.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private transaction(action: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapExperiment(row: DbRow): ExperimentRecord {
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

function mapRun(row: DbRow): RunRecord {
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
    completedAt: nullableNumber(row.completed_at),
    updatedAt: numberValue(row.updated_at),
  };
}

function mapRound(row: DbRow): RoundRecord {
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

function mapEvent(row: DbRow): GenerationEvent {
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

function stringValue(value: unknown): string {
  return String(value);
}

function numberValue(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function finiteNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedEventData(
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
