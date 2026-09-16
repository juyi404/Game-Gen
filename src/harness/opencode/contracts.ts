import type { Message, Part } from "@opencode-ai/sdk";
import { connectOrStartOpenCode } from "../../runtime/opencode.js";

export interface OpenCodeSessionMessage {
  info: Message;
  parts: Part[];
}

export interface SessionEventMonitor {
  isComplete(): boolean;
  error(): unknown | null;
  lastActivityAt(): number;
  expectBudgetAbort(): void;
  wait(durationMs: number, signal: AbortSignal): Promise<void>;
  stop(): void;
}

export interface OpenCodeHarnessOptions {
  connect?: typeof connectOrStartOpenCode;
  pollIntervalMs?: number;
  maxPollErrors?: number;
  idleTimeoutMs?: number;
  initialBuildSoftTimeoutMs?: number;
  initialBuildWrapUpMs?: number;
  transportFetch?: typeof fetch;
}
