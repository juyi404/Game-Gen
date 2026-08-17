import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
        usage: { input: 12, output: 3, reasoning: 2, cost: 0.01 },
      });
      expect(state.accepted).toBe(true);
      expect(state.promptCalled).toBe(false);
      expect(state.statusCalls).toBeGreaterThanOrEqual(2);
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
  messages: unknown[],
  events: unknown[] = [],
): OpencodeClient {
  return {
    session: {
      messages: async () => ({ data: state.accepted ? messages : [] }),
      prompt: async () => {
        state.promptCalled = true;
        throw new Error("synchronous prompt must not be used");
      },
      promptAsync: async (options: { body?: { system?: string } }) => {
        state.accepted = true;
        state.systemPrompt = options.body?.system;
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
            "session-1": { type: state.statusCalls === 1 ? "busy" : "idle" },
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
}

async function* eventStream(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
}

function completedMessages(): unknown[] {
  return [{
    info: assistantInfo("stop", 12, 3, 2, 0.01),
    parts: [
      { type: "text", text: "generation complete" },
      {
        type: "step-finish",
        reason: "stop",
        cost: 0.01,
        tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 0, write: 0 } },
      },
    ],
  }];
}

function emptyMessages(): unknown[] {
  return [{
    info: assistantInfo("unknown", 0, 0, 0, 0),
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
): Record<string, unknown> {
  return {
    id: "assistant-1",
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
