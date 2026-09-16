import type { DatabaseSync } from "node:sqlite";

export function transaction(db: DatabaseSync, action: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    action();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
