import type { ControlPlane } from "../../application/control-plane.js";
import type { GenerationEvent } from "../../domain/types.js";
import type { BenchmarkDatabase } from "../../persistence/database.js";

export interface RouteContext {
  // HTTP may read snapshots; lifecycle writes must go through application commands.
  db: Pick<BenchmarkDatabase, "getExperiment" | "getModelRunSummaries" | "getRoundSummary"
    | "getSummary" | "listExperiments" | "listRecentEvents" | "listRunPage" | "getRounds" | "getRun">;
  controlPlane: ControlPlane;
  options: { hostname: string; port: number };
  csrfToken: string;
  assertLocalCredentialManagement(): void;
  runEventPage(experimentId: string, runId: string): {
    events: GenerationEvent[];
    eventPage: { limit: number; hasMore: boolean; oldestEventId: number | null; newestEventId: number | null };
  };
}
