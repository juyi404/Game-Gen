import type { OpencodeClient } from "@opencode-ai/sdk";
import { validateGeneratedGameArtifacts } from "../../artifacts/validation.js";
import type { InfrastructureScope } from "../../domain/harness-failure.js";
import type { GenerationHarness, HarnessRoundResult, HarnessRunContext, OpenCodeConfig, RoundDefinition } from "../../domain/types.js";
import { initialBuildDeadline } from "../../execution/generation-budget.js";
import { buildEffectiveSystemPrompt, renderRoundPrompt } from "../../prompt-context.js";
import { connectOrStartOpenCode } from "../../runtime/opencode.js";
import { abortableDelay, controlSignal, throwIfAborted } from "../signals.js";
import type { OpenCodeHarnessOptions, OpenCodeSessionMessage, SessionEventMonitor } from "./contracts.js";
import { emitOpenCodeEvent } from "./events.js";
import { openCodeFailure } from "./failures.js";
import { errorMessage, hasTerminalAssistantMessage, latestAssistantFinish, summarizeSessionMessages } from "./messages.js";
import { buildResumePrompt, buildWorkspaceSystemPrompt, INITIAL_BUILD_WRAP_UP_PROMPT, isPathInsideWorkspace, MAXIMUM_TRUNCATED_FINISH_CONTINUATIONS, TRUNCATED_FINISH_CONTINUATION_PROMPT } from "./prompts.js";

export class OpenCodeHarness implements GenerationHarness {
  private client: OpencodeClient | null = null;
  private server: { close(): void } | null = null;
  private readonly finalizeRequested = new Set<string>();

  constructor(
    private readonly config: OpenCodeConfig,
    private readonly systemPrompt: string,
    private readonly options: OpenCodeHarnessOptions = {},
  ) { }

  async start(): Promise<void> {
    try { return await this.startInternal(); }
    catch (error) { throw openCodeFailure(error); }
  }

  private async startInternal(): Promise<void> {
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

  async checkInfrastructure(scope: InfrastructureScope, providerId: string): Promise<void> {
    try { return await this.checkInfrastructureInternal(scope, providerId); }
    catch (error) { throw openCodeFailure(error); }
  }

  private async checkInfrastructureInternal(scope: InfrastructureScope, providerId: string): Promise<void> {
    const result = await this.requireClient().config.get({
      signal: AbortSignal.timeout(10_000), throwOnError: true,
    });
    if (scope === "engine") return;
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
    try { return await this.beginRunInternal(context); }
    catch (error) { throw openCodeFailure(error); }
  }

  private async beginRunInternal(context: HarnessRunContext): Promise<string> {
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
    try { return await this.executeRoundInternal(context, sessionId, round, roundIndex); }
    catch (error) { throw openCodeFailure(error); }
  }

  private async executeRoundInternal(
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
    const softDeadline = initialBuildDeadline(context.run, softLimitMs);
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
            ? buildResumePrompt(context, round, roundIndex, messagesBeforeRound.length === 0)
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
          if (eventMonitor.error()) throw new Error(`OpenCode 会话失败: ${errorMessage(eventMonitor.error())}`);
          eventMonitor.expectBudgetAbort();
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
    let budgetAbortExpected = false;
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
          // OpenCode reports our own budget cancellation as a session error.
          // Ignore only that expected error; unrelated failures must still block delivery.
          if (budgetAbortExpected && event.type === "session.error"
            && event.properties.sessionID === sessionId
            && event.properties.error?.name === "MessageAbortedError") {
            context.emit("harness.session.budget_aborted", "info", "已按生成时间预算中断当前响应，继续交付流程", { sessionId });
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
      expectBudgetAbort: () => { budgetAbortExpected = true; },
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
