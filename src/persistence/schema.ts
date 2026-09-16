import type { DatabaseSync } from "node:sqlite";
import { stringValue, type DbRow } from "./rows.js";

export function migrateDatabase(db: DatabaseSync): void {
  db.exec(`
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
  ensureColumn(db, "experiments", "stage_mode", "TEXT NOT NULL DEFAULT 'all'");
  ensureColumn(db, "experiments", "target_round", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "experiments", "max_rounds", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "runs", "resume_pending", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "runs", "infra_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "runs", "infra_first_failed_at", "INTEGER");
  ensureColumn(db, "runs", "infra_scope", "TEXT CHECK (infra_scope IN ('engine', 'provider'))");
  ensureColumn(db, "runs", "infra_failure_kind", "TEXT NOT NULL DEFAULT 'infrastructure' CHECK (infra_failure_kind IN ('infrastructure', 'incomplete'))");
  ensureColumn(db, "runs", "initial_build_started_at", "INTEGER");
  ensureColumn(db, "rounds", "usage_json", "TEXT");
  db.exec(`
      UPDATE runs SET initial_build_started_at = started_at
      WHERE initial_build_started_at IS NULL AND started_at IS NOT NULL;
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

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[];
  if (columns.some((item) => stringValue(item.name) === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
