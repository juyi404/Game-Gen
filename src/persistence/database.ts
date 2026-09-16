import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InfrastructureScope } from "../domain/harness-failure.js";
import type { EventLevel, ExperimentRecord, ExperimentStatus, ExperimentSummary, GenerationEvent, HarnessUsage, ModelRunSummary, ResolvedBenchmarkConfig, RoundRecord, RoundStatus, RoundSummary, RunPage, RunRecord, RunStatus, TaskDefinition } from "../domain/types.js";
import { EventStore, type EventPage } from "./events.js";
import type { DbRow } from "./rows.js";
import { finiteNumber, mapExperiment, mapRound, mapRun, nullableNumber, numberValue, stringValue } from "./rows.js";
import { migrateDatabase } from "./schema.js";
import { transaction } from "./transaction.js";

export interface InfrastructureRetryState {
  attempts: number;
  firstFailedAt: number | null;
  scope: InfrastructureScope | null;
  kind: "infrastructure" | "incomplete";
}

export interface UsageSummary extends HarnessUsage {
  rounds: number;
}

export class BenchmarkDatabase extends EventEmitter {
  readonly filePath: string;
  private readonly db: DatabaseSync;
  private readonly events: EventStore;

  constructor(filePath: string) {
    super();
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    migrateDatabase(this.db);
    this.events = new EventStore(this.db, (event) => this.emit("event", event));
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

  /** Only the lifecycle owner may roll back an advance whose startup failed. */
  rollbackExperimentStage(previous: ExperimentRecord): void {
    const result = this.db.prepare(`
      UPDATE experiments SET target_round = ?, status = ?, started_at = ?, completed_at = ?, error = ?
      WHERE id = ? AND target_round = ?
    `).run(previous.targetRound, previous.status, previous.startedAt, previous.completedAt,
      previous.error, previous.id, previous.targetRound + 1);
    if (result.changes !== 1) throw new Error("阶段状态已变化，无法回滚启动");
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
    options: { page?: number; pageSize?: number; search?: string; status?: RunStatus; modelId?: string } = {},
  ): RunPage {
    const requestedPage = Math.max(1, Math.trunc(options.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize ?? 100)));
    const search = options.search?.trim().toLowerCase() ?? "";
    const conditions = ["experiment_id = ?"];
    const parameters: Array<string | number> = [experimentId];
    if (options.modelId) {
      conditions.push("model_id = ?");
      parameters.push(options.modelId);
    }
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
          ${options.modelId ? "AND status_runs.model_id = ?" : ""}
      )`);
      parameters.push(options.status);
      if (options.modelId) parameters.push(options.modelId);
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
          ${options.modelId ? "AND model_id = ?" : ""}
        ORDER BY queued_at, task_id, model_id
      `)
      .all(experimentId, ...taskIds, ...(options.modelId ? [options.modelId] : [])) as DbRow[];
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
          initial_build_started_at = COALESCE(initial_build_started_at, started_at, ?),
          started_at = COALESCE(started_at, ?), completed_at = NULL, updated_at = ?
        WHERE id = ? AND (
          (status IN ('queued', 'retrying') AND available_at <= ?)
          OR (
            status = 'awaiting_stage'
            AND current_round < (SELECT target_round FROM experiments WHERE id = runs.experiment_id)
          )
        )
      `)
      .run(now, now, now, id, now);
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
    options: {
      preserveProgress?: boolean;
      preserveSession?: boolean;
      incrementAttempt?: boolean;
    } = {},
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
              attempt = attempt + ?, resume_pending = 1,
              error = ?, available_at = ?, completed_at = NULL,
              updated_at = ?
            WHERE id = ?
          `)
          .run(options.incrementAttempt ? 1 : 0, error, now + delayMs, now, id);
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

  recordInfrastructureFailure(
    id: string,
    failedAt = Date.now(),
    scope?: InfrastructureScope,
    kind: InfrastructureRetryState["kind"] = "infrastructure",
  ): InfrastructureRetryState {
    this.db
      .prepare(`
        UPDATE runs SET infra_attempts = infra_attempts + 1,
          infra_first_failed_at = COALESCE(infra_first_failed_at, ?),
          infra_scope = CASE WHEN ? = 'incomplete' THEN NULL ELSE COALESCE(?, infra_scope) END,
          infra_failure_kind = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(failedAt, kind, scope ?? null, kind, failedAt, id);
    return this.getInfrastructureRetryState(id);
  }

  getInfrastructureRetryState(id: string): InfrastructureRetryState {
    const row = this.db
      .prepare("SELECT infra_attempts, infra_first_failed_at, infra_scope, infra_failure_kind FROM runs WHERE id = ?")
      .get(id) as DbRow | undefined;
    if (!row) throw new Error(`运行不存在: ${id}`);
    return {
      attempts: numberValue(row.infra_attempts),
      firstFailedAt: nullableNumber(row.infra_first_failed_at),
      scope: row.infra_scope === "engine" || row.infra_scope === "provider" ? row.infra_scope : null,
      kind: row.infra_failure_kind === "incomplete" ? "incomplete" : "infrastructure",
    };
  }

  clearInfrastructureFailures(id: string): void {
    this.db
      .prepare("UPDATE runs SET infra_attempts = 0, infra_first_failed_at = NULL, infra_scope = NULL, infra_failure_kind = 'infrastructure' WHERE id = ?")
      .run(id);
  }

  /** The caller must serialize retries until startup succeeds or this rollback is called. */
  resetFailedRun(id: string): () => void {
    const run = this.getRun(id);
    if (!run) throw new Error(`运行不存在: ${id}`);
    if (!['failed', 'cancelled'].includes(run.status)) {
      throw new Error("只能重试失败或已取消的运行");
    }
    const savedRun = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as DbRow;
    const savedRounds = this.db.prepare("SELECT * FROM rounds WHERE run_id = ?").all(id) as DbRow[];
    const experiment = this.getExperiment(run.experimentId)!;
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
            initial_build_started_at = ?,
            session_id = NULL, error = NULL, completed_at = NULL, updated_at = ?,
            resume_pending = CASE WHEN workspace_path IS NOT NULL THEN 1 ELSE 0 END,
            infra_attempts = 0, infra_first_failed_at = NULL, infra_scope = NULL, infra_failure_kind = 'infrastructure'
          WHERE id = ?
        `)
        .run(now, now, now, id);
    });
    return () => this.transaction(() => {
      // Column names come only from SQLite's own rows, never from request input.
      const restore = (table: "runs" | "rounds", row: DbRow, where: string, keys: Array<string | number>) => {
        const columns = Object.keys(row);
        this.db.prepare(`UPDATE ${table} SET ${columns.map((key) => `${key} = ?`).join(", ")} WHERE ${where}`)
          .run(...columns.map((key) => row[key] as string | number | null), ...keys);
      };
      restore("runs", savedRun, "id = ?", [id]);
      for (const round of savedRounds) {
        restore("rounds", round, "run_id = ? AND round_index = ?", [id, numberValue(round.round_index)]);
      }
      this.db.prepare(`UPDATE experiments SET status = ?, started_at = ?, completed_at = ?, error = ? WHERE id = ?`)
        .run(experiment.status, experiment.startedAt, experiment.completedAt, experiment.error, experiment.id);
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
    return this.events.appendEvent(experimentId, runId, type, level, message, data);
  }

  listEvents(options: {
    experimentId: string;
    runId?: string;
    afterId?: number;
    beforeId?: number;
    limit?: number;
    newest?: boolean;
  }): GenerationEvent[] {
    return this.events.listEvents(options);
  }

  listEventPage(options: {
    experimentId: string;
    runId?: string;
    afterId?: number;
    beforeId?: number;
    limit?: number;
    newest?: boolean;
  }): EventPage {
    return this.events.listEventPage(options);
  }

  pruneEvents(experimentId?: string): void {
    return this.events.pruneEvents(experimentId);
  }

  listRecentEvents(experimentId: string, limit = 100): GenerationEvent[] {
    return this.events.listRecentEvents(experimentId, limit);
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

  private transaction(action: () => void): void {
    transaction(this.db, action);
  }
}
