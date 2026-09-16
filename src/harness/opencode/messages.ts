import type { AssistantMessage, Part } from "@opencode-ai/sdk";
import type { HarnessRoundResult } from "../../domain/types.js";
import type { OpenCodeSessionMessage } from "./contracts.js";

export function describeAssistantError(
  error: AssistantMessage["error"],
): string | null {
  if (!error) return null;
  const detail = "message" in error.data
    ? error.data.message
    : JSON.stringify(error.data);
  return `OpenCode 模型调用失败 (${error.name}): ${detail}`;
}

export function summarizeSessionMessages(
  messages: OpenCodeSessionMessage[],
  sessionError: unknown | null = null,
): HarnessRoundResult {
  const assistantMessages = messages.filter(
    (message): message is OpenCodeSessionMessage & { info: AssistantMessage } => (
      message.info.role === "assistant"
    ),
  );
  if (assistantMessages.length === 0) {
    if (sessionError) throw new Error(`OpenCode 会话失败: ${errorMessage(sessionError)}`);
    throw new Error("OpenCode 返回空结果：没有模型消息");
  }
  for (const message of assistantMessages) {
    const assistantError = describeAssistantError(message.info.error);
    if (assistantError) throw new Error(assistantError);
  }
  if (sessionError) throw new Error(`OpenCode 会话失败: ${errorMessage(sessionError)}`);
  const parts = assistantMessages.flatMap((message) => message.parts);
  const response = parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const usage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  for (const part of parts) {
    if (part.type !== "step-finish") continue;
    usage.input += part.tokens.input;
    usage.output += part.tokens.output;
    usage.reasoning += part.tokens.reasoning;
    usage.cacheRead += part.tokens.cache.read;
    usage.cacheWrite += part.tokens.cache.write;
    usage.cost += part.cost;
  }
  const hasCompletedTool = parts.some(
    (part) => part.type === "tool" && part.state.status === "completed",
  );
  if (!response && usage.input === 0 && usage.output === 0
    && usage.reasoning === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0
    && usage.cost === 0 && !hasCompletedTool) {
    throw new Error("OpenCode 返回空结果：0 Token、无文本、无工具调用");
  }
  return { response, usage };
}

export function latestAssistantFinish(messages: OpenCodeSessionMessage[]): string | null {
  const latest = [...messages].reverse().find((message) => message.info.role === "assistant");
  return latest?.info.role === "assistant" ? latest.info.finish ?? null : null;
}

export function hasTerminalAssistantMessage(messages: OpenCodeSessionMessage[]): boolean {
  const assistantMessages = messages.filter(
    (message): message is OpenCodeSessionMessage & { info: AssistantMessage } => (
      message.info.role === "assistant"
    ),
  );
  const latest = assistantMessages.at(-1);
  if (!latest) return false;
  if (latest.info.error) return true;
  if (!latest.info.time.completed) return false;
  return latest.info.finish !== "tool-calls";
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    if (error && typeof error === "object") {
      const record = error as { name?: unknown; data?: unknown; message?: unknown };
      const name = typeof record.name === "string" ? record.name : null;
      const data = record.data && typeof record.data === "object"
        ? record.data as { message?: unknown }
        : null;
      const detail = typeof data?.message === "string"
        ? data.message
        : typeof record.message === "string"
          ? record.message
          : JSON.stringify(error);
      return name ? `${name}: ${detail}` : detail;
    }
    return String(error);
  }
  const cause = error.cause ? errorMessage(error.cause) : "";
  return cause && cause !== error.message ? `${error.message}: ${cause}` : error.message;
}
