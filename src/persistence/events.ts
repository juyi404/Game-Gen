import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { EventLevel, GenerationEvent } from "../domain/types.js";
import { boundedEventData, mapEvent, positiveIntegerEnvironment, type DbRow } from "./rows.js";
import { transaction } from "./transaction.js";

export const DEFAULT_EVENT_RETENTION_PER_EXPERIMENT = 200_000;

export const DEFAULT_EVENT_RETENTION_GLOBAL = 1_000_000;

export const EVENT_PRUNE_INTERVAL = 1_000;

export const DEFAULT_EVENT_DATA_MAX_BYTES = 128 * 1024;

export interface EventPage {
  events: GenerationEvent[];
  hasMore: boolean;
}

/** Event persistence and retention share the database connection and its transaction boundary. */
export class EventStore {
  private readonly eventRetentionPerExperiment: number;
  private readonly eventRetentionGlobal: number;
  private readonly eventDataMaxBytes: number;
  private eventsSincePrune = 0;
  constructor(private readonly db: DatabaseSync, private readonly publish: (event: GenerationEvent) => void) {
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
    this.publish(event);
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
    transaction(this.db, () => {
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
}
