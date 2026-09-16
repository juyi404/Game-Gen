import type { Event } from "@opencode-ai/sdk";
import type { HarnessRunContext } from "../../domain/types.js";

export function emitOpenCodeEvent(
  context: HarnessRunContext,
  sessionId: string,
  event: Event,
): void {
  if (event.type === "file.edited") {
    context.emit("harness.file.edited", "info", `已修改 ${event.properties.file}`, {
      file: event.properties.file,
    });
    return;
  }
  if (event.type === "session.error" && (!event.properties.sessionID || event.properties.sessionID === sessionId)) {
    context.emit("harness.session.error", "error", "OpenCode 会话发生错误", {
      error: event.properties.error,
    });
    return;
  }
  if (event.type === "session.status" && event.properties.sessionID === sessionId) {
    context.emit("harness.session.status", "debug", `OpenCode 状态: ${event.properties.status.type}`, {
      status: event.properties.status,
    });
    return;
  }
  if (event.type === "todo.updated" && event.properties.sessionID === sessionId) {
    context.emit("harness.todo.updated", "info", "OpenCode 更新了执行计划", {
      todos: event.properties.todos,
    });
    return;
  }
  if (event.type !== "message.part.updated" || event.properties.part.sessionID !== sessionId) return;
  const part = event.properties.part;
  if (part.type === "tool") {
    const state = part.state as { status?: string; title?: string; error?: string };
    const status = state.status ?? "updated";
    // OpenCode emits the same tool part repeatedly while it moves through
    // pending/running/completed. Persist only terminal transitions and keep
    // the diagnostic payload bounded: full command input/output can be very
    // large and may contain credentials returned by a tool.
    if (status !== "completed" && status !== "error") return;
    context.emit(
      `harness.tool.${status}`,
      status === "error" ? "error" : "info",
      state.title ?? `${part.tool}: ${status}`,
      {
        tool: part.tool,
        callId: part.callID,
        status,
        ...(state.title ? { title: truncateDiagnostic(state.title) } : {}),
        ...(state.error ? { error: truncateDiagnostic(state.error) } : {}),
      },
    );
  } else if (part.type === "step-finish") {
    if (!["unknown", "length"].includes(part.reason)) context.reportHealthy?.("provider");
    context.emit("harness.step.completed", "info", "模型完成一个生成步骤", {
      reason: part.reason,
      cost: part.cost,
      tokens: part.tokens,
    });
  }
}

export function truncateDiagnostic(value: string, maximum = 2_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}
