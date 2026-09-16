export type InfrastructureScope = "engine" | "provider";

export type HarnessFailureKind =
  | "infrastructure"
  | "authorization"
  | "incomplete"
  | "artifact"
  | "timeout"
  | "execution";

export interface HarnessFailureDetails {
  kind: HarnessFailureKind;
  retryable: boolean;
  scope?: InfrastructureScope;
}

/** Adapter-neutral failure contract. Human-readable messages never select recovery policy. */
export class HarnessFailure extends Error {
  readonly kind: HarnessFailureKind;
  readonly retryable: boolean;
  readonly scope: InfrastructureScope | undefined;

  constructor(message: string, details: HarnessFailureDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessFailure";
    this.kind = details.kind;
    this.retryable = details.retryable;
    this.scope = details.scope;
    if (details.kind === "infrastructure" && !details.scope) {
      throw new TypeError("Infrastructure failures require an engine or provider scope");
    }
  }
}

/** Unclassified failures keep the bounded attempt retry behavior of existing adapters. */
export function harnessFailure(error: unknown): HarnessFailure {
  if (error instanceof HarnessFailure) return error;
  return new HarnessFailure(error instanceof Error ? error.message : String(error ?? "未知错误"), {
    kind: "execution", retryable: true,
  }, { cause: error });
}
