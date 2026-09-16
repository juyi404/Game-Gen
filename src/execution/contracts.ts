import type { InfrastructureScope } from "../domain/harness-failure.js";

export interface ActiveRun {
  controller: AbortController;
  providerId: string;
  modelId: string;
  sessionId: string | null;
  workspacePath: string | null;
  completion: Promise<void> | null;
  circuitProbes: InfrastructureProbe[];
}

export interface InfrastructureCircuit {
  scope: InfrastructureScope;
  failureCount: number;
  blockedUntil: number;
  probeInFlight: boolean;
  error: string;
}

export interface InfrastructureProbe {
  scope: InfrastructureScope;
  providerId?: string;
}
