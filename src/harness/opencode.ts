import {
  type AssistantMessage,
  type Event,
  type Message,
  type OpencodeClient,
  type Part,
} from "@opencode-ai/sdk";
import path from "node:path";
import { connectOrStartOpenCode } from "../opencode-runtime.js";
import { validateGeneratedGameArtifacts } from "../generated-artifact.js";
import { buildEffectiveSystemPrompt, renderRoundPrompt } from "../prompt-context.js";
import type {
  GenerationHarness,
  HarnessRoundResult,
  HarnessRunContext,
  OpenCodeConfig,
  ResolvedBenchmarkConfig,
  RoundDefinition,
} from "../types.js";

interface OpenCodeSessionMessage {
  info: Message;
  parts: Part[];
}

interface SessionEventMonitor {
  isComplete(): boolean;
  error(): unknown | null;
  wait(durationMs: number, signal: AbortSignal): Promise<void>;
  stop(): void;
}

export interface OpenCodeHarnessOptions {
  connect?: typeof connectOrStartOpenCode;
  pollIntervalMs?: number;
  maxPollErrors?: number;
}

export class OpenCodeHarness implements GenerationHarness {
  private client: OpencodeClient | null = null;
  private server: { close(): void } | null = null;

  constructor(
    private readonly config: OpenCodeConfig,
    private readonly systemPrompt: string,
    private readonly options: OpenCodeHarnessOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.client) return;
    const runtime = await (this.options.connect ?? connectOrStartOpenCode)(this.config);
    this.server = runtime.server;
    this.client = runtime.client;
  }

  async stop(): Promise<void> {
    this.server?.close();
    this.server = null;
    this.client = null;
  }

  async beginRun(context: HarnessRunContext): Promise<string> {
    const client = this.requireClient();
    const result = await client.session.create({
      query: { directory: context.workspacePath },
      body: { title: `${context.task.id} · ${context.model.id} · attempt ${context.run.attempt}` },
      signal: context.signal,
      throwOnError: true,
    });
    context.emit("harness.session.created", "info", "OpenCode 会话已创建", {
      sessionId: result.data.id,
    });
    return result.data.id;
  }

  async executeRound(
    context: HarnessRunContext,
    sessionId: string,
    round: RoundDefinition,
    roundIndex: number,
  ): Promise<HarnessRoundResult> {
    const client = this.requireClient();
    const messagesBeforeRound = await this.listSessionMessages(context, sessionId);
    const previousMessageIds = new Set(messagesBeforeRound.map((message) => message.info.id));
    const eventMonitor = this.monitorSessionEvents(context, sessionId);
    try {
      const system = buildWorkspaceSystemPrompt(
        buildEffectiveSystemPrompt(this.systemPrompt, context.model.systemPrompt),
        context.workspacePath,
      );
      const body = {
        model: {
          providerID: context.model.provider,
          modelID: context.model.modelName,
        },
        agent: context.model.agent ?? this.config.agent,
        system,
        ...(context.model.reasoningEffort
          ? { variant: context.model.reasoningEffort }
          : {}),
        parts: [{ type: "text" as const, text: renderRoundPrompt(round.prompt, context, roundIndex) }],
      };
      await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory: context.workspacePath },
        body,
        signal: controlSignal(context.signal, 30_000),
        throwOnError: true,
      });
      context.emit("harness.prompt.accepted", "info", "OpenCode 已接收本轮 Prompt，正在异步生成", {
        sessionId,
        roundIndex,
      });
      await this.waitForSessionCompletion(context, sessionId, previousMessageIds, eventMonitor);
      const messages = await this.readCompletedRoundMessages(
        context,
        sessionId,
        previousMessageIds,
        eventMonitor,
      );
      let result: HarnessRoundResult;
      try {
        result = summarizeSessionMessages(messages, eventMonitor.error());
      } catch (error) {
        if (context.model.provider === "packy-claude-sale"
          && errorMessage(error).startsWith("OpenCode 返回空结果")) {
          throw new Error(
            "PackyAPI 的 Claude Sale 分组仅允许官方 Claude CLI 调用；当前 OpenCode Harness 收到空结果，无法生成游戏",
          );
        }
        throw error;
      }
      await validateGeneratedGameArtifacts(context.workspacePath);
      return result;
    } finally {
      eventMonitor.stop();
    }
  }

  async captureRoundContext(
    context: HarnessRunContext,
    sessionId: string,
    _round: RoundDefinition,
    _roundIndex: number,
  ): Promise<unknown> {
    const capturedAt = new Date().toISOString();
    try {
      const result = await this.requireClient().session.messages({
        path: { id: sessionId },
        query: { directory: context.workspacePath, limit: 1_000 },
        signal: AbortSignal.timeout(10_000),
        throwOnError: true,
      });
      return {
        type: "opencode.session.messages",
        capturedAt,
        sessionId,
        messageCount: result.data.length,
        messages: result.data,
      };
    } catch (error) {
      return {
        type: "opencode.session.messages",
        capturedAt,
        sessionId,
        captureError: errorMessage(error),
      };
    }
  }

  async abortRun(sessionId: string, workspacePath: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.session.abort({
        path: { id: sessionId },
        query: { directory: workspacePath },
        signal: AbortSignal.timeout(10_000),
        throwOnError: true,
      });
    } catch {
      // The local AbortSignal already stops the request; server abort is best effort.
    }
  }

  async releaseRun(
    sessionId: string | null,
    workspacePath: string,
    options: { preserveSession?: boolean } = {},
  ): Promise<void> {
    const client = this.client;
    if (!client) return;
    const errors: string[] = [];
    if (sessionId && !options.preserveSession) {
      try {
        await client.session.delete({
          path: { id: sessionId },
          query: { directory: workspacePath },
          signal: AbortSignal.timeout(10_000),
          throwOnError: true,
        });
      } catch (error) {
        errors.push(`会话删除失败: ${errorMessage(error)}`);
      }
    }
    try {
      await client.instance.dispose({
        query: { directory: workspacePath },
        signal: AbortSignal.timeout(10_000),
        throwOnError: true,
      });
    } catch (error) {
      errors.push(`工作区实例释放失败: ${errorMessage(error)}`);
    }
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  private requireClient(): OpencodeClient {
    if (!this.client) throw new Error("OpenCode harness 尚未启动");
    return this.client;
  }

  private async listSessionMessages(
    context: HarnessRunContext,
    sessionId: string,
  ): Promise<OpenCodeSessionMessage[]> {
    const result = await this.requireClient().session.messages({
      path: { id: sessionId },
      query: { directory: context.workspacePath, limit: 1_000 },
      signal: controlSignal(context.signal, 10_000),
      throwOnError: true,
    });
    return result.data;
  }

  private monitorSessionEvents(
    context: HarnessRunContext,
    sessionId: string,
  ): SessionEventMonitor {
    const controller = new AbortController();
    const stopForParent = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", stopForParent, { once: true });
    let complete = false;
    let sessionError: unknown | null = null;
    const completionListeners = new Set<() => void>();
    const finish = () => {
      if (complete) return;
      complete = true;
      for (const listener of completionListeners) listener();
      completionListeners.clear();
    };
    void (async () => {
      try {
        const result = await this.requireClient().event.subscribe({
          query: { directory: context.workspacePath },
          signal: controller.signal,
          sseMaxRetryAttempts: 0,
        });
        for await (const event of result.stream) {
          if (controller.signal.aborted) break;
          if (event.type === "file.edited"
            && !isPathInsideWorkspace(context.workspacePath, event.properties.file)) {
            const violation = new Error(
              `OpenCode 尝试修改游戏工作区之外的文件: ${event.properties.file}`,
            );
            sessionError = violation;
            context.emit("harness.workspace.violation", "error", violation.message, {
              file: event.properties.file,
              workspacePath: context.workspacePath,
            });
            void this.requireClient().session.abort({
              path: { id: sessionId },
              query: { directory: context.workspacePath },
              throwOnError: true,
            }).catch(() => undefined);
            finish();
            continue;
          }
          emitOpenCodeEvent(context, sessionId, event);
          if (event.type === "session.error"
            && (!event.properties.sessionID || event.properties.sessionID === sessionId)) {
            sessionError = event.properties.error;
          }
          if ((event.type === "session.idle" && event.properties.sessionID === sessionId)
            || (event.type === "session.status"
              && event.properties.sessionID === sessionId
              && event.properties.status.type === "idle")) {
            finish();
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          context.emit("harness.stream.error", "warn", "OpenCode 事件流中断，已切换状态轮询", {
            error: errorMessage(error),
          });
        }
      }
    })();
    return {
      isComplete: () => complete,
      error: () => sessionError,
      wait: (durationMs, signal) => {
        if (complete) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(finishWait, durationMs);
          const onAbort = () => finishWait(signal.reason ?? new Error("生成已取消"));
          const onComplete = () => finishWait();
          function finishWait(error?: unknown): void {
            clearTimeout(timer);
            completionListeners.delete(onComplete);
            signal.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve();
          }
          completionListeners.add(onComplete);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          else if (complete) onComplete();
        });
      },
      stop: () => {
        controller.abort();
        context.signal.removeEventListener("abort", stopForParent);
      },
    };
  }

  private async waitForSessionCompletion(
    context: HarnessRunContext,
    sessionId: string,
    previousMessageIds: Set<string>,
    monitor: SessionEventMonitor,
  ): Promise<void> {
    let consecutiveErrors = 0;
    const maxPollErrors = this.options.maxPollErrors ?? 10;
    while (!monitor.isComplete()) {
      throwIfAborted(context.signal);
      try {
        const result = await this.requireClient().session.status({
          query: { directory: context.workspacePath },
          signal: controlSignal(context.signal, 10_000),
          throwOnError: true,
        });
        consecutiveErrors = 0;
        const status = result.data[sessionId];
        if (status?.type === "idle") return;
        if (!status) {
          const messages = await this.listSessionMessages(context, sessionId);
          const currentRoundMessages = messages.filter(
            (message) => !previousMessageIds.has(message.info.id),
          );
          if (hasTerminalAssistantMessage(currentRoundMessages)) return;
        }
      } catch (error) {
        throwIfAborted(context.signal);
        consecutiveErrors += 1;
        if (consecutiveErrors === 1 || consecutiveErrors === maxPollErrors) {
          context.emit("harness.poll.error", "warn", "OpenCode 状态检查暂时失败，正在重连", {
            error: errorMessage(error),
            consecutiveErrors,
          });
        }
        if (consecutiveErrors >= maxPollErrors) {
          throw new Error(`OpenCode 状态连接连续失败 ${consecutiveErrors} 次: ${errorMessage(error)}`);
        }
      }
      await monitor.wait(this.options.pollIntervalMs ?? 5_000, context.signal);
    }
  }

  private async readCompletedRoundMessages(
    context: HarnessRunContext,
    sessionId: string,
    previousMessageIds: Set<string>,
    monitor: SessionEventMonitor,
  ): Promise<OpenCodeSessionMessage[]> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const messages = await this.listSessionMessages(context, sessionId);
      const currentRoundMessages = messages.filter(
        (message) => !previousMessageIds.has(message.info.id),
      );
      if (hasTerminalAssistantMessage(currentRoundMessages)) return currentRoundMessages;
      if (monitor.error()) {
        throw new Error(`OpenCode 会话失败: ${errorMessage(monitor.error())}`);
      }
      if (attempt < 4) await abortableDelay(100, context.signal);
    }
    throw new Error("OpenCode 会话已结束，但没有找到完整的模型消息");
  }
}

export function buildWorkspaceSystemPrompt(systemPrompt: string, workspacePath: string): string {
  const boundary = [
    "工作区边界（必须遵守）：",
    `- 本次运行唯一允许读取、创建、修改或删除的目录是：${path.resolve(workspacePath)}`,
    "- 所有工具路径必须位于该目录或其子目录中；不要访问父目录、兄弟目录、Git 根目录或其他绝对路径。",
    "- 即使工具界面显示了更大的项目根目录，也只能操作上述本次运行目录。",
  ].join("\n");
  return [systemPrompt, boundary].filter(Boolean).join("\n\n");
}

export function isPathInsideWorkspace(workspacePath: string, editedPath: string): boolean {
  const workspace = path.resolve(workspacePath);
  const edited = path.resolve(workspace, editedPath);
  const relative = path.relative(workspace, edited);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative));
}

export function createHarness(config: ResolvedBenchmarkConfig): GenerationHarness {
  if (config.runtime.harness === "mock") return new MockHarnessProxy(config);
  return new OpenCodeHarness(config.opencode, config.systemPrompt);
}

class MockHarnessProxy implements GenerationHarness {
  private delegate: GenerationHarness | null = null;

  constructor(private readonly config: ResolvedBenchmarkConfig) {}

  private async getDelegate(): Promise<GenerationHarness> {
    if (!this.delegate) {
      const { MockHarness } = await import("./mock.js");
      this.delegate = new MockHarness(this.config.mock);
    }
    return this.delegate;
  }

  async start(): Promise<void> {
    await (await this.getDelegate()).start();
  }

  async stop(): Promise<void> {
    await (await this.getDelegate()).stop();
  }

  async beginRun(context: HarnessRunContext): Promise<string> {
    return (await this.getDelegate()).beginRun(context);
  }

  async executeRound(
    context: HarnessRunContext,
    sessionId: string,
    round: RoundDefinition,
    roundIndex: number,
  ): Promise<HarnessRoundResult> {
    return (await this.getDelegate()).executeRound(context, sessionId, round, roundIndex);
  }

  async abortRun(sessionId: string, workspacePath: string): Promise<void> {
    await (await this.getDelegate()).abortRun(sessionId, workspacePath);
  }

  async releaseRun(
    sessionId: string | null,
    workspacePath: string,
    options?: { preserveSession?: boolean },
  ): Promise<void> {
    const delegate = await this.getDelegate();
    await delegate.releaseRun?.(sessionId, workspacePath, options);
  }
}

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
  const usage = { input: 0, output: 0, reasoning: 0, cost: 0 };
  for (const part of parts) {
    if (part.type !== "step-finish") continue;
    usage.input += part.tokens.input;
    usage.output += part.tokens.output;
    usage.reasoning += part.tokens.reasoning;
    usage.cost += part.cost;
  }
  const hasCompletedTool = parts.some(
    (part) => part.type === "tool" && part.state.status === "completed",
  );
  if (!response && usage.input === 0 && usage.output === 0
    && usage.reasoning === 0 && usage.cost === 0 && !hasCompletedTool) {
    throw new Error("OpenCode 返回空结果：0 Token、无文本、无工具调用");
  }
  return { response, usage };
}

function hasTerminalAssistantMessage(messages: OpenCodeSessionMessage[]): boolean {
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

function emitOpenCodeEvent(
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
    context.emit(
      `harness.tool.${status}`,
      status === "error" ? "error" : "info",
      state.title ?? `${part.tool}: ${status}`,
      { tool: part.tool, callId: part.callID, state: part.state },
    );
  } else if (part.type === "step-finish") {
    context.emit("harness.step.completed", "info", "模型完成一个生成步骤", {
      reason: part.reason,
      cost: part.cost,
      tokens: part.tokens,
    });
  }
}

function errorMessage(error: unknown): string {
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

function controlSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("生成已取消");
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, durationMs);
    const onAbort = () => finish(signal.reason ?? new Error("生成已取消"));
    function finish(error?: unknown): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
