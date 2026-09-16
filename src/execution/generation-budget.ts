import type { RunRecord } from "../domain/types.js";

/** Shared by dispatch recovery and the harness; retries never move this deadline. */
export function initialBuildDeadline(run: RunRecord, timeoutMs: number): number {
  const startedAt = run.initialBuildStartedAt ?? run.startedAt;
  return timeoutMs > 0 && startedAt !== null ? startedAt + timeoutMs : Infinity;
}
