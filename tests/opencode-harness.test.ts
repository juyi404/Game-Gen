import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkspaceSystemPrompt,
  describeAssistantError,
  isPathInsideWorkspace,
  OpenCodeHarness,
  summarizeSessionMessages,
} from "../src/harness/opencode.js";
import type { HarnessRunContext, OpenCodeConfig, RoundDefinition } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("OpenCode harness message errors", () => {
  it("injects and validates the per-run workspace boundary", async () => {
    const workspacePath = await createWorkspace("<main>generated game</main>");
    const childPath = path.join(workspacePath, "assets", "game.js");
    const siblingPath = path.join(path.dirname(workspacePath), "outside.html");
    const system = buildWorkspaceSystemPrompt("base system", workspacePath);

    expect(system).toContain(path.resolve(workspacePath));
    expect(system).toContain("唯一允许");
    expect(system).toContain("不得引用 http://、https://");
    expect(system).toContain("先检查工作区现有文件");
    expect(isPathInsideWorkspace(workspacePath, childPath)).toBe(true);
    expect(isPathInsideWorkspace(workspacePath, "index.html")).toBe(true);
    expect(isPathInsideWorkspace(workspacePath, siblingPath)).toBe(false);
    expect(isPathInsideWorkspace(workspacePath, "../outside.html")).toBe(false);
  });

  it("aborts a session that reports an edit outside its workspace", async () => {
    const workspacePath = await createWorkspace("<main>generated game</main><script>window.game = true;</script>");
    const outsidePath = path.join(path.dirname(workspacePath), "outside.html");
    const state: FakeState = { accepted: false, promptCalled: false, statusCalls: 0 };
    const client = fakeClient(state, completedMessages(), [{
      type: "file.edited",
      properties: { file: outsidePath },
    }]);
    const harness = new OpenCodeHarness(openCodeConfig(), "system", {
      connect: async () => ({ client, server: null, url: "http://127.0.0.1:4096" }),
      pollIntervalMs: 1,
    });
    await harness.start();
    try {
      await expect(harness.executeRound(
        runContext(workspacePath),
        "session-1",
        round(),
        0,
      )).rejects.toThrow("工作区之外");
      expect(state.aborted).toBe(true);
      expect(state.systemPrompt).toContain(path.resolve(workspacePath));
    } finally {
      await harness.stop();
    }
  });

  it("treats assistant-level provider errors as failed rounds", () => {
    expect(describeAssistantError(undefined)).toBeNull();
    expect(describeAssistantError({
      name: "UnknownError",
      data: { message: "unknown certificate verification error" },
    })).toBe(
      "OpenCode 模型调用失败 (UnknownError): unknown certificate verification error",
    );
    expect(describeAssistantError({
      name: "MessageOutputLengthError",
      data: { limit: 100 },
    })).toBe('OpenCode 模型调用失败 (MessageOutputLengthError): {"limit":100}');
    expect(() => summarizeSessionMessages([], {
      name: "UnknownError",
      data: { message: "Model not found: provider/model" },
    })).toThrow("UnknownError: Model not found: provider/model");
  });

  it("uses async prompts and recovers the completed session through polling", async () => {
    const workspacePath = await createWorkspace("<main>generated game</main><script>window.game = true;</script>");
    const state = { accepted: false, promptCalled: false, statusCalls: 0 };
    const client = fakeClient(state, completedMessages());
    const harness = new OpenCodeHarness(openCodeConfig(), "system", {
      connect: async () => ({ client, server: null, url: "http://127.0.0.1:4096" }),
      pollIntervalMs: 1,
    });
    await harness.start();
    try {
      const result = await harness.executeRound(
        runContext(workspacePath),
        "session-1",
        round(),
        0,
      );
      expect(result).toMatchObject({
        response: "generation complete",
        usage: {
          input: 12,
          output: 3,
          reasoning: 2,
          cacheRead: 7,
          cacheWrite: 4,
          cost: 0.01,
        },
      });
      expect(state.accepted).toBe(true);
      expect(state.promptCalled).toBe(false);
      expect(state.statusCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await harness.stop();
    }
  });

  it("continues an unknown finish in the same session and preserves its workspace", async () => {
    const workspacePath = await createWorkspace("<main>Replace this page with the generated game.</main>");
    const state: FakeState = {
      accepted: false,
      promptCalled: false,
      statusCalls: 0,
      onPrompt: async (call) => {
        if (call === 2) {
          await writeFile(
            path.join(workspacePath, "index.html"),
            "<main>continued game</main><script>window.game = true;</script>",
            "utf8",
          );
        }
      },
    };
    const client = fakeClient(state, (promptCalls) => promptCalls <= 1
      ? emptyMessages("assistant-1")
      : [...emptyMessages("assistant-1"), ...completedMessages("assistant-2")]);
    const harness = new OpenCodeHarness(openCodeConfig(), "system", {
      connect: async () => ({ client, server: null, url: "http://127.0.0.1:4096" }),
      pollIntervalMs: 1,
    });
    await harness.start();
    try {
      await expect(harness.executeRound(
        runContext(workspacePath),
        "session-1",
        round(),
        0,
      )).resolves.toMatchObject({ response: "generation complete" });
      expect(state.promptCalls).toBe(2);
      expect(await readFile(path.join(workspacePath, "index.html"), "utf8")).toContain("continued game");
    } finally {
      await harness.stop();
    }
  });

  it("stops after three unknown-finish continuations", async () => {
    const workspacePath = await createWorkspace("<main>Replace this page with the generated game.</main>");
    const state: FakeState = { accepted: false, promptCalled: false, statusCalls: 0 };
    const client = fakeClient(state, (promptCalls) => Array.from(
      { length: promptCalls },
      (_, index) => emptyMessages(`assistant-${index + 1}`)[0],
    ));
    const harness = new OpenCodeHarness(openCodeConfig(), "system", {
      connect: async () => ({ client, server: null, url: "http://127.0.0.1:4096" }),
      pollIntervalMs: 1,
    });
    await harness.start();
    try {
      await expect(harness.executeRound(
        runContext(workspacePath),
        "session-1",
        round(),
        0,
      )).rejects.toThrow("连续异常结束");
      expect(state.promptCalls).toBe(4);
    } finally {
      await harness.stop();
    }
  });

  it("aborts a model that stays busy without producing execution events", async () => {
    const workspacePath = await createWorkspace("<main>generated game</main><script>window.game = true;</script>");
    const state: FakeState = {
      accepted: false,
      promptCalled: false,
      statusCalls: 0,
      stuckBusy: true,
    };
    const client = fakeClient(state, completedMessages());
    const harness = new OpenCodeHarness(openCodeConfig(), "system", {
      connect: async () => ({ client, server: null, url: "http://127.0.0.1:4096" }),
      pollIntervalMs: 1,
      idleTimeoutMs: 5,
    });
    await harness.start();
    try {
      await expect(harness.executeRound(
        runContext(workspacePath),
        "session-1",
        round(),
        0,
      )).rejects.toThrow("空闲超时");
      expect(state.statusCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await harness.stop();
    }
  });

  it("releases workspace instances and only deletes terminal sessions", async () => {
    const workspacePath = await createWorkspace("<main>generated game</main>");
    const state: FakeState = { accepted: false, promptCalled: false, statusCalls: 0 };
    const client = fakeClient(state, completedMessages());
    const harness = new OpenCodeHarness(openCodeConfig(), "system", {
      connect: async () => ({ client, server: null, url: "http://127.0.0.1:4096" }),
    });
    await harness.start();
    try {
      await harness.releaseRun("session-1", workspacePath, { preserveSession: true });
      expect(state.deletedSessions ?? 0).toBe(0);
      expect(state.disposedInstances).toBe(1);
      await harness.releaseRun("session-1", workspacePath);
      expect(state.deletedSessions).toBe(1);
      expect(state.disposedInstances).toBe(2);
    } finally {
      await harness.stop();
    }
  });

  it("rejects zero-token empty assistant completions", async () => {
    const workspacePath = await createWorkspace("<main>generated game</main>");
    const state = { accepted: false, promptCalled: false, statusCalls: 0 };
    const client = fakeClient(state, emptyMessages());
    const harness = new OpenCodeHarness(openCodeConfig(), "system", {
      connect: async () => ({ client, server: null, url: "http://127.0.0.1:4096" }),
      pollIntervalMs: 1,
    });
    await harness.start();
    try {
      await expect(harness.executeRound(
        runContext(workspacePath, "packy-claude-sale"),
        "session-1",
        round(),
        0,
      )).rejects.toThrow("仅允许官方 Claude CLI 调用");
      expect(state.promptCalled).toBe(false);
    } finally {
      await harness.stop();
    }
  });
});

function fakeClient(
  state: FakeState,
  messages: unknown[] | ((promptCalls: number) => unknown[]),
  events: unknown[] = [],
): OpencodeClient {
  return {
    session: {
      messages: async () => ({
        data: state.accepted
          ? typeof messages === "function" ? messages(state.promptCalls ?? 0) : messages
          : [],
      }),
      prompt: async () => {
        state.promptCalled = true;
        throw new Error("synchronous prompt must not be used");
      },
      promptAsync: async (options: { body?: { system?: string } }) => {
        state.accepted = true;
        state.promptCalls = (state.promptCalls ?? 0) + 1;
        state.systemPrompt = options.body?.system;
        await state.onPrompt?.(state.promptCalls);
        return { data: undefined };
      },
      abort: async () => {
        state.aborted = true;
        return { data: true };
      },
      delete: async () => {
        state.deletedSessions = (state.deletedSessions ?? 0) + 1;
        return { data: true };
      },
      status: async () => {
        state.statusCalls += 1;
        return {
          data: {
            "session-1": { type: state.stuckBusy || state.statusCalls === 1 ? "busy" : "idle" },
          },
        };
      },
    },
    instance: {
      dispose: async () => {
        state.disposedInstances = (state.disposedInstances ?? 0) + 1;
        return { data: true };
      },
    },
    event: {
      subscribe: async () => ({ stream: eventStream(events) }),
    },
  } as unknown as OpencodeClient;
}

interface FakeState {
  accepted: boolean;
  promptCalled: boolean;
  statusCalls: number;
  aborted?: boolean;
  systemPrompt?: string | undefined;
  deletedSessions?: number;
  disposedInstances?: number;
  stuckBusy?: boolean;
  promptCalls?: number;
  onPrompt?: (call: number) => void | Promise<void>;
}

async function* eventStream(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
}

function completedMessages(id = "assistant-1"): unknown[] {
  return [{
    info: assistantInfo("stop", 12, 3, 2, 0.01, id),
    parts: [
      { type: "text", text: "generation complete" },
      {
        type: "step-finish",
        reason: "stop",
        cost: 0.01,
        tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 7, write: 4 } },
      },
    ],
  }];
}

function emptyMessages(id = "assistant-1"): unknown[] {
  return [{
    info: assistantInfo("unknown", 0, 0, 0, 0, id),
    parts: [{
      type: "step-finish",
      reason: "unknown",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }],
  }];
}

function assistantInfo(
  finish: string,
  input: number,
  output: number,
  reasoning: number,
  cost: number,
  id = "assistant-1",
): Record<string, unknown> {
  return {
    id,
    sessionID: "session-1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "user-1",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "workspace", root: "workspace" },
    cost,
    tokens: { input, output, reasoning, cache: { read: 0, write: 0 } },
    finish,
  };
}

async function createWorkspace(indexHtml: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebench-opencode-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "index.html"), indexHtml, "utf8");
  return directory;
}

function openCodeConfig(): OpenCodeConfig {
  return {
    hostname: "127.0.0.1",
    port: 4096,
    startupTimeoutMs: 1_000,
    agent: "build",
    config: {},
  };
}

function round(): RoundDefinition {
  return { id: "initial-build", prompt: "build a game" };
}

function runContext(workspacePath: string, provider = "provider"): HarnessRunContext {
  return {
    run: {
      id: "run-1",
      experimentId: "experiment-1",
      taskId: "game-1",
      taskTitle: "Game",
      modelId: "model-1",
      providerId: provider,
      modelName: "model",
      status: "running",
      currentRound: 1,
      totalRounds: 1,
      attempt: 1,
      maxAttempts: 1,
      resumePending: false,
      availableAt: 0,
      workspacePath,
      sessionId: "session-1",
      error: null,
      queuedAt: 0,
      startedAt: 0,
      completedAt: null,
      updatedAt: 0,
    },
    model: {
      id: "model-1",
      model: `${provider}/model`,
      provider,
      modelName: "model",
      enabled: true,
      concurrency: 1,
    },
    task: {
      id: "game-1",
      title: "Game",
      sourcePath: "dataset.json",
      rounds: [round()],
      metadata: {},
    },
    workspacePath,
    signal: new AbortController().signal,
    emit: () => {},
  };
}
