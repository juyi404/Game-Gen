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
  ResolvedBenchmarkConfig,
  RoundRecord,
  RoundSummary,
  RoundStatus,
  RunRecord,
  RunStatus,
  StageMode,
  TaskDefinition,
} from "./types.js";

type DbRow = Record<string, unknown>;

export class BenchmarkDatabase extends EventEmitter {
  readonly filePath: string;
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    super();
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
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
          completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END
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
          UPDATE runs SET status = 'queued', session_id = NULL, error = NULL,
            available_at = ?, updated_at = ?
          WHERE experiment_id = ? AND status IN ('preparing', 'running', 'retrying')
        `)
        .run(now, now, experimentId);
      this.db
        .prepare(`
          UPDATE rounds SET status = 'pending', started_at = NULL, completed_at = NULL,
            response = NULL, error = NULL
          WHERE run_id IN (SELECT id FROM runs WHERE experiment_id = ? AND status = 'queued')
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
        ORDER BY runs.available_at, runs.queued_at, runs.task_id, runs.model_id
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
    const continuingStage = current.status === "awaiting_stage";
    const now = Date.now();
    const result = this.db
      .prepare(`
        UPDATE runs SET status = 'preparing',
          attempt = CASE WHEN status = 'awaiting_stage' THEN attempt ELSE attempt + 1 END,
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
    if (!continuingStage) {
      this.db
        .prepare(`
          UPDATE rounds SET status = 'pending', started_at = NULL, completed_at = NULL,
            response = NULL, error = NULL WHERE run_id = ?
        `)
        .run(id);
    }
    return this.getRun(id);
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
          completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END
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
    options: { preserveAttemptBudget?: boolean } = {},
  ): void {
    const now = Date.now();
    if (options.preserveAttemptBudget) {
      this.db
        .prepare("UPDATE runs SET max_attempts = max_attempts + 1 WHERE id = ?")
        .run(id);
    }
    this.updateRun(id, {
      status: "retrying",
      currentRound: 0,
      sessionId: null,
      error,
      availableAt: now + delayMs,
    });
  }

  resetFailedRun(id: string): void {
    const run = this.getRun(id);
    if (!run) throw new Error(`运行不存在: ${id}`);
    if (!['failed', 'cancelled'].includes(run.status)) {
      throw new Error("只能重试失败或已取消的运行");
    }
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE runs SET status = 'queued', current_round = 0,
          max_attempts = MAX(max_attempts, attempt + 1), available_at = ?,
          session_id = NULL, error = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(now, now, id);
    this.db
      .prepare(`
        UPDATE rounds SET status = 'pending', started_at = NULL, completed_at = NULL,
          response = NULL, error = NULL WHERE run_id = ?
      `)
      .run(id);
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
    values: { response?: string | null; error?: string | null } = {},
  ): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE rounds SET status = ?,
          started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
          completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END,
          response = COALESCE(?, response), error = ?
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

  getRoundSummary(experimentId: string): RoundSummary {
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
        WHERE runs.experiment_id = ?
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

  appendEvent(
    experimentId: string,
    runId: string | null,
    type: string,
    level: EventLevel,
    message: string,
    data: Record<string, unknown> = {},
  ): GenerationEvent {
    const createdAt = Date.now();
    const result = this.db
      .prepare(`
        INSERT INTO events (experiment_id, run_id, type, level, message, data_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(experimentId, runId, type, level, message, JSON.stringify(data), createdAt);
    const event: GenerationEvent = {
      id: Number(result.lastInsertRowid),
      experimentId,
      runId,
      type,
      level,
      message,
      data,
      createdAt,
    };
    this.emit("event", event);
    return event;
  }

  listEvents(options: {
    experimentId: string;
    runId?: string;
    afterId?: number;
    limit?: number;
  }): GenerationEvent[] {
    const afterId = options.afterId ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2_000);
    let statement: StatementSync;
    let rows: DbRow[];
    if (options.runId) {
      statement = this.db.prepare(`
        SELECT * FROM events WHERE experiment_id = ? AND run_id = ? AND id > ?
        ORDER BY id ASC LIMIT ?
      `);
      rows = statement.all(options.experimentId, options.runId, afterId, limit) as DbRow[];
    } else {
      statement = this.db.prepare(`
        SELECT * FROM events WHERE experiment_id = ? AND id > ?
        ORDER BY id ASC LIMIT ?
      `);
      rows = statement.all(options.experimentId, afterId, limit) as DbRow[];
    }
    return rows.map(mapEvent);
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
        WHERE experiment_id = ? AND status IN ('queued', 'retrying', 'awaiting_stage')
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
    this.db.exec(`
      UPDATE experiments
      SET max_rounds = COALESCE((
        SELECT MAX(total_rounds) FROM runs WHERE runs.experiment_id = experiments.id
      ), 0)
      WHERE max_rounds = 0;
      UPDATE experiments
      SET target_round = max_rounds
      WHERE stage_mode = 'all' AND target_round != max_rounds;
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
