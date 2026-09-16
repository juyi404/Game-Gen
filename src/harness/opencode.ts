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
  lastActivityAt(): number;
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

export class OpenCodeHarness implements GenerationHarness {
  private client: OpencodeClient | null = null;
  private server: { close(): void } | null = null;
  private readonly finalizeRequested = new Set<string>();

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

  async checkInfrastructure(scope: "opencode" | "provider", providerId: string): Promise<void> {
    const result = await this.requireClient().config.get({
      signal: AbortSignal.timeout(10_000), throwOnError: true,
    });
    if (scope === "opencode") return;
    const baseURL = result.data.provider?.[providerId]?.options?.baseURL;
    if (typeof baseURL !== "string") return;
    const endpoint = new URL(`${baseURL.replace(/\/$/, "")}/models`);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error("供应商连通检查地址无效");
    }
    endpoint.search = "";
    // No API key, game prompt, or session history is sent. 401/403/404 show only
    // that transport works; the single resumed task still probes model health.
    const response = await (this.options.transportFetch ?? fetch)(endpoint, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok && ![401, 403, 404, 405].includes(response.status)) {
      throw new Error(`供应商连通检查 HTTP ${response.status}`);
    }
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
    const roundMessageIds = new Set(messagesBeforeRound.map((message) => message.info.id));
    let previousMessageIds = roundMessageIds;
    let continuationCount = 0;
    const maximumContinuations = context.run.resumePending
      ? 0
      : MAXIMUM_TRUNCATED_FINISH_CONTINUATIONS;
    const softLimitMs = roundIndex === 0 ? (this.options.initialBuildSoftTimeoutMs ?? 0) : 0;
    // A manual retry keeps the original run.startedAt for reporting, but starts a
    // fresh, bounded recovery window from the time it was explicitly requeued.
    // Automatic in-place retries retain their session id and therefore keep the
    // original deadline instead of extending the budget on every transient error.
    const manuallyRequeued = context.run.resumePending
      && context.run.workspacePath !== null
      && context.run.sessionId === null;
    const budgetStartedAt = manuallyRequeued
      ? context.run.availableAt
      : (context.run.startedAt ?? Date.now());
    const softDeadline = softLimitMs > 0
      ? budgetStartedAt + softLimitMs : Infinity;
    const deliveryDeadline = softDeadline + (this.options.initialBuildWrapUpMs ?? 900_000);
    let wrappingUp = Date.now() >= softDeadline;
    const system = buildWorkspaceSystemPrompt(
      buildEffectiveSystemPrompt(this.systemPrompt, context.model.systemPrompt),
      context.workspacePath,
    );
    while (true) {
      if (!wrappingUp && Date.now() >= softDeadline) wrappingUp = true;
      if (Date.now() >= deliveryDeadline) {
        await this.abortForBudget(context, sessionId);
        return this.collectBudgetDelivery(context, sessionId, roundMessageIds, roundIndex);
      }
      const eventMonitor = this.monitorSessionEvents(context, sessionId);
      try {
        const prompt = wrappingUp ? INITIAL_BUILD_WRAP_UP_PROMPT : continuationCount === 0
          ? context.run.resumePending
            ? RETRY_RESUME_PROMPT
            : renderRoundPrompt(round.prompt, context, roundIndex)
          : TRUNCATED_FINISH_CONTINUATION_PROMPT;
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
          parts: [{ type: "text" as const, text: prompt }],
        };
        await client.session.promptAsync({
          path: { id: sessionId },
          query: { directory: context.workspacePath },
          body,
          signal: controlSignal(context.signal, 30_000),
          throwOnError: true,
        });
        context.emit(
          continuationCount === 0 ? "harness.prompt.accepted" : "harness.session.continuation.accepted",
          continuationCount === 0 ? "info" : "warn",
          continuationCount === 0
            ? "OpenCode 已接收本轮 Prompt，正在异步生成"
            : "OpenCode 已接收断尾续作 Prompt，继续使用当前会话和工作目录",
          { sessionId, roundIndex, continuationCount },
        );
        if (wrappingUp) {
          context.emit("harness.delivery.started", "warn", "生成时限已到，原会话进入一次限时交付收尾，不再扩展或反复打磨", {
            sessionId, roundIndex, softDeadline, deliveryDeadline,
          });
        }
        const budgetExpired = await this.waitForSessionCompletion(
          context, sessionId, previousMessageIds, eventMonitor,
          wrappingUp ? deliveryDeadline : softDeadline,
        );
        if (budgetExpired) {
          await this.abortForBudget(context, sessionId);
          if (eventMonitor.error()) throw new Error(`OpenCode 会话失败: ${errorMessage(eventMonitor.error())}`);
          if (wrappingUp) {
            return this.collectBudgetDelivery(context, sessionId, roundMessageIds, roundIndex);
          }
          eventMonitor.stop();
          const currentMessages = await this.listSessionMessages(context, sessionId);
          previousMessageIds = new Set(currentMessages.map((message) => message.info.id));
          wrappingUp = true;
          continue;
        }
        if (this.finalizeRequested.delete(sessionId)) {
          const currentMessages = await this.listSessionMessages(context, sessionId);
          const messages = currentMessages.filter((message) => !roundMessageIds.has(message.info.id));
          let result: HarnessRoundResult;
          try {
            result = summarizeSessionMessages(messages, null);
          } catch {
            result = { response: "用户要求停止继续修改，已按现有产物完成本轮验收" };
          }
          await validateGeneratedGameArtifacts(context.workspacePath);
          context.emit(
            "harness.session.finalized",
            "info",
            "已停止继续修改并按现有产物完成验收",
            { sessionId, roundIndex },
          );
          return result;
        }
        const turnMessages = await this.readCompletedRoundMessages(
          context,
          sessionId,
          previousMessageIds,
          eventMonitor,
        );
        if (eventMonitor.error()) {
          throw new Error(`OpenCode 会话失败: ${errorMessage(eventMonitor.error())}`);
        }
        if (wrappingUp) {
          // A delivery pass is one turn only, including when the upstream truncates it.
          // Artifact validation still applies; the orchestrator will preserve failures without retrying.
          return this.collectBudgetDelivery(context, sessionId, roundMessageIds, roundIndex);
        }
        const finish = latestAssistantFinish(turnMessages);
        if (finish === "unknown" || finish === "length") {
          if (finish === "unknown" && context.model.provider === "packy-claude-sale") {
            try {
              summarizeSessionMessages(turnMessages, eventMonitor.error());
            } catch (error) {
              if (errorMessage(error).startsWith("OpenCode 返回空结果")) {
                throw new Error(
                  "PackyAPI 的 Claude Sale 分组仅允许官方 Claude CLI 调用；当前 OpenCode Harness 收到空结果，无法生成游戏",
                );
              }
              throw error;
            }
          }
          if (continuationCount >= maximumContinuations) {
            throw new Error(
              `OpenCode 上游响应连续断尾：finish=${finish}，已在原会话续作 ${continuationCount} 次`,
            );
          }
          continuationCount += 1;
          context.emit(
            finish === "length"
              ? "harness.session.length_finish"
              : "harness.session.unknown_finish",
            "warn",
            finish === "length"
              ? "检测到模型达到单次输出长度上限，将保留当前产物并在原会话自动续作"
              : "检测到模型响应异常断尾，将保留当前产物并在原会话自动续作",
            {
              sessionId,
              roundIndex,
              finish,
              continuationCount,
              maximumContinuations,
            },
          );
          const currentMessages = await this.listSessionMessages(context, sessionId);
          previousMessageIds = new Set(currentMessages.map((message) => message.info.id));
          continue;
        }
        const currentMessages = await this.listSessionMessages(context, sessionId);
        const messages = currentMessages.filter((message) => !roundMessageIds.has(message.info.id));
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
  }

  private async abortForBudget(context: HarnessRunContext, sessionId: string): Promise<void> {
    await this.requireClient().session.abort({
      path: { id: sessionId },
      query: { directory: context.workspacePath },
      signal: controlSignal(context.signal, 10_000),
      throwOnError: true,
    });
  }

  private async collectBudgetDelivery(
    context: HarnessRunContext,
    sessionId: string,
    previousIds: Set<string>,
    roundIndex: number,
  ): Promise<HarnessRoundResult> {
    await validateGeneratedGameArtifacts(context.workspacePath);
    const messages = (await this.listSessionMessages(context, sessionId))
      .filter((message) => !previousIds.has(message.info.id));
    let result: HarnessRoundResult;
    try {
      result = summarizeSessionMessages(messages, null);
    } catch {
      result = { response: "限时收尾结束，现有产物通过静态验收；未保证已完成所有功能" };
    }
    context.emit("harness.delivery.completed", "info", "限时交付结束，现有产物已通过静态验收，不再自动续写", {
      sessionId, roundIndex,
    });
    return result;
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

  async requestFinalize(sessionId: string, workspacePath: string): Promise<void> {
    const client = this.requireClient();
    this.finalizeRequested.add(sessionId);
    try {
      await client.session.abort({
        path: { id: sessionId },
        query: { directory: workspacePath },
        signal: AbortSignal.timeout(10_000),
        throwOnError: true,
      });
    } catch (error) {
      this.finalizeRequested.delete(sessionId);
      throw error;
    }
  }

  async releaseRun(
    sessionId: string | null,
    workspacePath: string,
    options: { preserveSession?: boolean } = {},
  ): Promise<void> {
    if (sessionId) this.finalizeRequested.delete(sessionId);
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
    let lastActivityAt = Date.now();
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
          lastActivityAt = Date.now();
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
      lastActivityAt: () => lastActivityAt,
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
    stopAt = Infinity,
  ): Promise<boolean> {
    let consecutiveErrors = 0;
    const maxPollErrors = this.options.maxPollErrors ?? 10;
    while (!monitor.isComplete()) {
      throwIfAborted(context.signal);
      if (Date.now() >= stopAt) return true;
      const idleTimeoutMs = this.options.idleTimeoutMs ?? 0;
      if (idleTimeoutMs > 0 && Date.now() - monitor.lastActivityAt() >= idleTimeoutMs) {
        throw new Error(`模型连续 ${idleTimeoutMs}ms 没有产生执行事件，已触发空闲超时`);
      }
      try {
        const result = await this.requireClient().session.status({
          query: { directory: context.workspacePath },
          signal: controlSignal(context.signal, 10_000),
          throwOnError: true,
        });
        consecutiveErrors = 0;
        const status = result.data[sessionId];
        if (status?.type === "idle") return false;
        if (!status) {
          const messages = await this.listSessionMessages(context, sessionId);
          const currentRoundMessages = messages.filter(
            (message) => !previousMessageIds.has(message.info.id),
          );
          if (hasTerminalAssistantMessage(currentRoundMessages)) return false;
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
      await monitor.wait(Math.min(this.options.pollIntervalMs ?? 5_000, Math.max(1, stopAt - Date.now())), context.signal);
    }
    return false;
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
  const artifactContract = [
    "离线游戏产物要求（必须遵守）：",
    "- 最终游戏必须能在受限沙箱中离线运行；HTML、JavaScript、CSS、字体、图片、音频和模型不得引用 http://、https:// 或 // 开头的外部资源。",
    "- 不要使用 CDN（包括 cdnjs、jsDelivr、unpkg、Tailwind CDN）。依赖必须保存到工作区内并以相对路径引用；无法本地化时改用原生 HTML/CSS/JavaScript。",
    "- 开始前先检查工作区现有文件。若目录中已有未完成产物，应在原文件上定向修复，不能用默认模板或占位页覆盖已有成果。",
    "- 结束前检查 index.html 不是占位页、所有本地引用确实存在，并清除损坏的合并标记、模板插值路径和不可解析的脚本。",
  ].join("\n");
  return [systemPrompt, boundary, artifactContract].filter(Boolean).join("\n\n");
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
  return new OpenCodeHarness(config.opencode, config.systemPrompt, {
    idleTimeoutMs: config.runtime.roundIdleTimeoutMs,
    initialBuildSoftTimeoutMs: config.runtime.initialBuildSoftTimeoutMs ?? 0,
    initialBuildWrapUpMs: config.runtime.initialBuildWrapUpMs ?? 900_000,
  });
}

const INITIAL_BUILD_WRAP_UP_PROMPT = [
  "本游戏的生成时间预算已用完，现在只做一次交付收尾。保留当前工作目录、会话和已有成果。",
  "停止新增功能、美术扩展、重构和反复优化；只补齐让当前游戏能够加载、进入核心玩法并运行所必需的缺失内容。",
  "修复阻断运行的语法错误、缺失文件和入口引用，做一次最小运行检查，然后立即结束并简述交付结果与尚存限制。",
  "不要重新生成、覆盖已有成果或重启设计。收尾最多十五分钟，优先立即交付现有可运行版本。",
].join("\n");

const RETRY_RESUME_PROMPT = [
  "上一轮执行因临时错误中断。请在当前同一工作目录和会话中直接续跑。",
  "先检查已有文件与未完成内容，保留所有可用成果；不要从零重建、不要覆盖已完成部分，也不要重新规划或扩展需求。",
  "如果必须补写较大的源文件，请先建立可运行骨架，再用多次小范围编辑或追加逐块完成；不要在单次工具调用中写入整个大型文件，以免再次达到响应长度上限。",
  "继续完成当前轮原始任务，优先修复阻断加载、核心玩法和交付的事项，然后尽快结束。",
].join("\n");

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

// A truncated/unknown finish may be a transient stream cutoff. Allow exactly one
// same-session continuation, then let the scheduler apply its automatic backoff.
const MAXIMUM_TRUNCATED_FINISH_CONTINUATIONS = 1;
const TRUNCATED_FINISH_CONTINUATION_PROMPT = [
  "The previous model turn ended before the game was complete, possibly because it reached the provider output limit.",
  "Continue from the files already present in the current workspace and complete any interrupted tool or file write; do not restart or merely describe a plan.",
  "Finish the requested playable game, ensure index.html is no longer the placeholder, and verify every local file reference.",
  "Only finish your response after the implementation is complete.",
].join(" ");

function latestAssistantFinish(messages: OpenCodeSessionMessage[]): string | null {
  const latest = [...messages].reverse().find((message) => message.info.role === "assistant");
  return latest?.info.role === "assistant" ? latest.info.finish ?? null : null;
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
    context.emit("harness.step.completed", "info", "模型完成一个生成步骤", {
      reason: part.reason,
      cost: part.cost,
      tokens: part.tokens,
    });
  }
}

function truncateDiagnostic(value: string, maximum = 2_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
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
