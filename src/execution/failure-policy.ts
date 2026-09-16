import { harnessFailure, type InfrastructureScope } from "../domain/harness-failure.js";
export type { InfrastructureScope } from "../domain/harness-failure.js";

export function isRepairableArtifactFailure(error: unknown): boolean {
  return harnessFailure(error).kind === "artifact";
}
export function isHardRoundTimeout(error: unknown): boolean {
  return harnessFailure(error).kind === "timeout";
}
export function classifyInfrastructureFailure(error: unknown): InfrastructureScope | null {
  const failure = harnessFailure(error);
  return failure.kind === "infrastructure" && failure.retryable ? failure.scope ?? null : null;
}
export function isRecoverableIncompleteOutput(error: unknown): boolean {
  const failure = harnessFailure(error);
  return failure.kind === "incomplete" && failure.retryable;
}
export function isProviderAuthorizationBlock(error: unknown): boolean {
  return harnessFailure(error).kind === "authorization";
}
