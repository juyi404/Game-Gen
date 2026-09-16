import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "acorn";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/control-plane.js";
import { BenchmarkDatabase } from "../src/database.js";
import { OrchestratorManager } from "../src/manager.js";
import type {
  AggregatorProviderConfiguration,
  AggregatorProviderSummary,
} from "../src/opencode-service.js";
import { DashboardServer } from "../src/server/dashboard.js";

const temporaryDirectories: string[] = [];
const csrfTokens = new Map<string, string>();

afterEach(async () => {
  csrfTokens.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("dashboard lifecycle actions", () => {
  it("maps missing lifecycle command targets to 404 without starting a runtime", async () => {
    const fixture = await createFixture();
    try {
      expect((await postJson(fixture.url, "/api/experiments/missing/advance-stage", {})).response.status).toBe(404);
      expect((await postJson(fixture.url, "/api/runs/missing/retry", {})).response.status).toBe(404);
      expect(fixture.manager.activeExperimentId).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("serves the full browser module graph as JavaScript and keeps private paths unavailable", async () => {
    const fixture = await createFixture();
    try {
      const pending = ["/app.js"];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const pathname = pending.pop()!;
        if (visited.has(pathname)) continue;
        visited.add(pathname);
        const response = await fetch(`${fixture.url}${pathname}`);
        expect(response.status, pathname).toBe(200);
        expect(response.headers.get("content-type"), pathname).toContain("javascript");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        const ast = parse(await response.text(), { ecmaVersion: "latest", sourceType: "module" });
        for (const statement of ast.body) {
          if (statement.type !== "ImportDeclaration") continue;
          const dependency = new URL(String(statement.source.value), `${fixture.url}${pathname}`);
          expect(dependency.origin).toBe(fixture.url);
          pending.push(dependency.pathname);
        }
      }
      expect(visited.has("/modules/monitor.js")).toBe(true);
      expect(visited.has("/modules/api.js")).toBe(true);
      for (const pathname of ["/modules/missing.js", "/modules/state.ts", "/modules/state.js.map", "/domain/types.ts", "/modules/%2e%2e%2fapplication%2fcontracts.ts"]) {
        expect((await fetch(`${fixture.url}${pathname}`)).status, pathname).toBe(404);
      }
    } finally {
      await fixture.close();
    }
  });

  it("pauses, resumes, streams, cancels, retries, and serves artifacts", async () => {
    const fixture = await createFixture();
    try {
      const dataset = await importDataset(fixture.url, 12, 2);
      const experimentResponse = await postJson(fixture.url, "/api/experiments", {
        name: "Dashboard lifecycle",
        datasetId: dataset.id,
        harness: "mock",
        models: [{
          id: "mock-high",
          model: "vendor-a/game-model",
          enabled: true,
          concurrency: 1,
          reasoningEffort: "high",
        }],
        globalConcurrency: 1,
        providerConcurrency: { "vendor-a": 1 },
        maxAttempts: 1,
        roundTimeoutMs: 60_000,
        retryBackoffMs: 1,
      });
      expect(
        experimentResponse.response.status,
        JSON.stringify(experimentResponse.body),
      ).toBe(201);
      const experiment = experimentResponse.body as {
        id: string;
        manifestPath: string;
      };

      const streamController = new AbortController();
      const streamResponse = await fetch(
        `${fixture.url}/api/stream?experimentId=${experiment.id}`,
        { signal: streamController.signal },
      );
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
      const streamReader = streamResponse.body!.getReader();

      expect((await postJson(
        fixture.url,
        `/api/experiments/${experiment.id}/pause`,
        {},
      )).response.status).toBe(200);
      expect(await readSseEventOfType(streamReader, "experiment.paused")).toMatchObject({
        type: "experiment.paused",
      });
      await waitFor(async () => {
        const detail = await getJson<ExperimentDetail>(
          fixture.url,
          `/api/experiments/${experiment.id}`,
        );
        return detail.experiment.status === "paused"
          && detail.summary.running === 0
          && detail.summary.preparing === 0;
      });
      const paused = await getJson<ExperimentDetail>(
        fixture.url,
        `/api/experiments/${experiment.id}`,
      );
      expect(paused.summary.completed).toBeLessThanOrEqual(1);
      expect(paused.summary.queued).toBeGreaterThan(0);

      expect((await postJson(
        fixture.url,
        `/api/experiments/${experiment.id}/resume`,
        {},
      )).response.status).toBe(200);
      expect(await readSseEventOfType(streamReader, "experiment.resumed")).toMatchObject({
        type: "experiment.resumed",
      });
      await waitFor(async () => {
        const detail = await getJson<ExperimentDetail>(
          fixture.url,
          `/api/experiments/${experiment.id}`,
        );
        return detail.summary.completed >= 2;
      });

      expect((await postJson(
        fixture.url,
        `/api/experiments/${experiment.id}/cancel`,
        {},
      )).response.status).toBe(200);
      await waitFor(async () => {
        const detail = await getJson<ExperimentDetail>(
          fixture.url,
          `/api/experiments/${experiment.id}`,
        );
        return detail.experiment.status === "cancelled";
      });
      streamController.abort();
      await streamReader.cancel().catch(() => undefined);

      const cancelled = await getJson<ExperimentDetail>(
        fixture.url,
        `/api/experiments/${experiment.id}`,
      );
      expect(cancelled.summary.cancelled).toBeGreaterThan(0);
      const paged = await getJson<{
        runs: unknown[];
        runPage: { page: number; pageSize: number; totalTasks: number; totalPages: number };
        modelSummaries: Array<{ modelId: string; total: number }>;
      }>(fixture.url, `/api/experiments/${experiment.id}?page=2&pageSize=5`);
      expect(paged.runPage).toMatchObject({ page: 2, pageSize: 5, totalTasks: 12, totalPages: 3 });
      expect(paged.runs).toHaveLength(5);
      expect(paged.modelSummaries).toEqual([
        expect.objectContaining({ modelId: "mock-high", total: 12 }),
      ]);
      expect((await fetch(`${fixture.url}/api/experiments/${experiment.id}?pageSize=201`)).status).toBe(400);
      await waitFor(async () => {
        const current = JSON.parse(await readFile(experiment.manifestPath, "utf8")) as {
          status: string;
        };
        return current.status === "cancelled";
      });
      const manifest = JSON.parse(await readFile(experiment.manifestPath, "utf8")) as {
        status: string;
        runs: unknown[];
      };
      expect(manifest).toMatchObject({ status: "cancelled" });
      expect(manifest.runs).toHaveLength(12);

      const retryRun = cancelled.runs.find((run) => run.status === "cancelled")!;
      expect((await postJson(fixture.url, `/api/runs/${retryRun.id}/retry`, {})).response.status)
        .toBe(200);
      await waitFor(async () => {
        const detail = await getJson<{ run: { status: string } }>(
          fixture.url,
          `/api/runs/${retryRun.id}`,
        );
        return detail.run.status === "completed";
      });

      const runDetail = await getJson<{
        run: { status: string; workspacePath: string };
        resultPath: string;
        roundContextDirectory: string;
        rounds: Array<{ contextPath: string }>;
      }>(fixture.url, `/api/runs/${retryRun.id}`);
      expect(runDetail.run.status).toBe("completed");
      expect(runDetail.roundContextDirectory).toContain("round-contexts");
      expect(runDetail.rounds.every((round) => Boolean(round.contextPath))).toBe(true);
      expect(JSON.parse(await readFile(runDetail.resultPath, "utf8"))).toMatchObject({
        status: "completed",
        rounds: [{ status: "completed" }, { status: "completed" }],
      });

      const artifactResponse = await fetch(`${fixture.url}/artifacts/${retryRun.id}/`);
      expect(artifactResponse.status).toBe(200);
      expect(await artifactResponse.text()).toContain("Lifecycle game");
    expect(artifactResponse.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-pointer-lock");
      expect(artifactResponse.headers.get("content-security-policy")).toContain("connect-src 'none'");
      expect(artifactResponse.headers.get("access-control-allow-origin")).toBe("*");
      expect((await fetch(
        `${fixture.url}/artifacts/${retryRun.id}/.benchmark/result.json`,
      )).status).toBe(403);

      for (let index = 0; index < 1_005; index += 1) {
        fixture.db.appendEvent(
          experiment.id,
          retryRun.id,
          "test.log",
          "debug",
          `log-${index}`,
        );
      }
      const newestLogs = await getJson<{
        events: Array<{ message: string }>;
        eventPage: { limit: number; hasMore: boolean };
      }>(fixture.url, `/api/runs/${retryRun.id}`);
      expect(newestLogs.events).toHaveLength(1_000);
      expect(newestLogs.events[0]?.message).toBe("log-5");
      expect(newestLogs.events.at(-1)?.message).toBe("log-1004");
      expect(newestLogs.eventPage).toEqual({
        limit: 1_000,
        hasMore: true,
        oldestEventId: expect.any(Number),
        newestEventId: expect.any(Number),
      });

      const outsideArtifact = path.join(fixture.directory, "outside-artifact.txt");
      await writeFile(outsideArtifact, "server secret", "utf8");
      const linkedArtifact = path.join(runDetail.run.workspacePath, "linked-secret.txt");
      try {
        await symlink(outsideArtifact, linkedArtifact, "file");
        expect((await fetch(
          `${fixture.url}/artifacts/${retryRun.id}/linked-secret.txt`,
        )).status).not.toBe(200);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      }
      expect((await fetch(`${fixture.url}/app.js`)).status).toBe(200);
      expect((await fetch(`${fixture.url}/styles.css`)).status).toBe(200);
      expect((await fetch(`${fixture.url}/api/stream?experimentId=missing`)).status).toBe(400);

      const experiments = await getJson<Array<{ id: string }>>(fixture.url, "/api/experiments");
      expect(experiments).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: experiment.id }),
      ]));
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("advances manual stages through the API without replacing context state", async () => {
    const fixture = await createFixture();
    try {
      const dataset = await importDataset(fixture.url, 1, 3);
      const created = await postJson(fixture.url, "/api/experiments", {
        name: "Manual stages",
        datasetId: dataset.id,
        harness: "mock",
        stageMode: "manual",
        models: [{
          id: "mock-staged",
          model: "vendor-a/game-model",
          enabled: true,
          concurrency: 1,
        }],
        globalConcurrency: 1,
        providerConcurrency: { "vendor-a": 1 },
        maxAttempts: 1,
        roundTimeoutMs: 60_000,
        retryBackoffMs: 1,
      });
      expect(created.response.status).toBe(201);
      const experiment = created.body as {
        id: string;
        stageMode: string;
        targetRound: number;
        maxRounds: number;
      };
      expect(experiment).toMatchObject({
        stageMode: "manual",
        targetRound: 1,
        maxRounds: 3,
      });

      await waitFor(async () => {
        const detail = await getJson<ExperimentDetail>(
          fixture.url,
          `/api/experiments/${experiment.id}`,
        );
        return detail.experiment.status === "awaiting_stage";
      });
      const first = await getJson<ExperimentDetail>(
        fixture.url,
        `/api/experiments/${experiment.id}`,
      );
      expect(first.summary).toMatchObject({ awaitingStage: 1, completed: 0 });
      expect(first.roundSummary).toMatchObject({ total: 3, completed: 1, pending: 2 });
      expect(first.runs[0]).toMatchObject({
        status: "awaiting_stage",
        currentRound: 1,
        attempt: 1,
      });
      const originalRun = first.runs[0]!;

      expect((await postJson(
        fixture.url,
        `/api/experiments/${experiment.id}/advance-stage`,
        {},
      )).response.status).toBe(200);
      await waitFor(async () => {
        const detail = await getJson<ExperimentDetail>(
          fixture.url,
          `/api/experiments/${experiment.id}`,
        );
        return detail.experiment.status === "awaiting_stage"
          && detail.experiment.targetRound === 2;
      });
      const second = await getJson<ExperimentDetail>(
        fixture.url,
        `/api/experiments/${experiment.id}`,
      );
      expect(second.runs[0]).toMatchObject({
        status: "awaiting_stage",
        currentRound: 2,
        attempt: 1,
        workspacePath: originalRun.workspacePath,
        sessionId: originalRun.sessionId,
      });
      expect(second.roundSummary).toMatchObject({ completed: 2, pending: 1 });

      expect((await postJson(
        fixture.url,
        `/api/experiments/${experiment.id}/advance-stage`,
        {},
      )).response.status).toBe(200);
      await waitFor(async () => {
        const detail = await getJson<ExperimentDetail>(
          fixture.url,
          `/api/experiments/${experiment.id}`,
        );
        return detail.experiment.status === "completed";
      });
      const completed = await getJson<ExperimentDetail>(
        fixture.url,
        `/api/experiments/${experiment.id}`,
      );
      expect(completed.experiment).toMatchObject({ targetRound: 3, maxRounds: 3 });
      expect(completed.runs[0]).toMatchObject({
        status: "completed",
        currentRound: 3,
        attempt: 1,
        workspacePath: originalRun.workspacePath,
        sessionId: originalRun.sessionId,
      });
      expect(completed.roundSummary).toMatchObject({ completed: 3, pending: 0 });
      expect((await postJson(
        fixture.url,
        `/api/experiments/${experiment.id}/advance-stage`,
        {},
      )).response.status).toBe(409);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("validates uploads and completes API key and OAuth routes", async () => {
    const fixture = await createFixture();
    try {
      const wrongContentType = await fetch(`${fixture.url}/api/datasets/import`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-GameBench-CSRF": await csrfToken(fixture.url),
        },
        body: "{}",
      });
      expect(wrongContentType.status).toBe(415);

      const malformed = await fetch(`${fixture.url}/api/datasets/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GameBench-CSRF": await csrfToken(fixture.url),
        },
        body: "{",
      });
      expect(malformed.status).toBe(400);

      const traversal = await postJson(fixture.url, "/api/datasets/import", {
        name: "Traversal",
        files: [{ path: "../outside.json", content: taskJson("outside", 1) }],
      });
      expect(traversal.response.status).toBe(400);

      const duplicate = await postJson(fixture.url, "/api/datasets/import", {
        name: "Duplicate path",
        files: [
          { path: "same.json", content: taskJson("one", 1) },
          { path: "same.json", content: taskJson("two", 1) },
        ],
      });
      expect(duplicate.response.status).toBe(400);
      expect(await getJson<unknown[]>(fixture.url, "/api/setup").then(() => true)).toBe(true);

      expect((await postJson(fixture.url, "/api/auth/api-key", {
        providerId: "vendor-a",
        key: "local-test-secret",
      })).response.status).toBe(200);
      expect(fixture.calls.apiKeys).toEqual([{
        providerId: "vendor-a",
        key: "local-test-secret",
      }]);

      const oauth = await postJson(fixture.url, "/api/auth/oauth/start", {
        providerId: "vendor-a",
        method: 1,
      });
      expect(oauth).toMatchObject({
        response: { status: 200 },
        body: {
          url: "https://example.invalid/authorize",
          method: "code",
          instructions: "Sign in",
        },
      });
      expect((await postJson(fixture.url, "/api/auth/oauth/complete", {
        providerId: "vendor-a",
        method: 1,
        code: "oauth-code",
      })).response.status).toBe(200);
      expect(fixture.calls.oauth).toEqual([
        { action: "start", providerId: "vendor-a", method: 1 },
        { action: "complete", providerId: "vendor-a", method: 1, code: "oauth-code" },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects browser credential writes on non-loopback dashboards", async () => {
    const fixture = await createFixture("0.0.0.0");
    try {
      const response = await postJson(fixture.url, "/api/auth/api-key", {
        providerId: "vendor-a",
        key: "must-not-be-written",
      });
      expect(response.response.status).toBe(403);
      expect(response.body).toMatchObject({ error: expect.stringContaining("只允许") });
      expect(fixture.calls.apiKeys).toEqual([]);
      const aggregatorResponse = await postJson(
        fixture.url,
        "/api/providers/aggregators/connect",
        {
          baseUrl: "https://gateway.example.com/v1",
          apiKey: "must-not-be-sent",
        },
      );
      expect(aggregatorResponse.response.status).toBe(403);
      expect(fixture.calls.aggregatorDiscoveries).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects missing or cross-origin CSRF credentials for every write route", async () => {
    const fixture = await createFixture();
    try {
      const missing = await fetch(`${fixture.url}/api/datasets/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "blocked", files: [] }),
      });
      expect(missing.status).toBe(403);

      const crossOrigin = await fetch(`${fixture.url}/api/datasets/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://attacker.example",
          "X-GameBench-CSRF": await csrfToken(fixture.url),
        },
        body: JSON.stringify({ name: "blocked", files: [] }),
      });
      expect(crossOrigin.status).toBe(403);
    } finally {
      await fixture.close();
    }
  });
});

interface ExperimentDetail {
  experiment: { id: string; status: string; targetRound: number; maxRounds: number };
  summary: {
    queued: number;
    preparing: number;
    running: number;
    awaitingStage: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  roundSummary: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  runs: Array<{
    id: string;
    status: string;
    currentRound: number;
    attempt: number;
    workspacePath: string | null;
    sessionId: string | null;
  }>;
}

async function createFixture(hostname = "127.0.0.1") {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebench-dashboard-actions-"));
  temporaryDirectories.push(directory);
  const dataDir = path.join(directory, "data");
  const db = new BenchmarkDatabase(path.join(dataDir, "benchmark.sqlite"));
  const manager = new OrchestratorManager(db);
  const calls = {
    apiKeys: [] as Array<{ providerId: string; key: string }>,
    oauth: [] as Array<Record<string, unknown>>,
    aggregatorDiscoveries: [] as Array<{ baseUrl: string; apiKey: string }>,
  };
  const providerGateway = {
    expectedUrl: "http://127.0.0.1:4096",
    url: "http://127.0.0.1:4096",
    async start() {},
    async listProviders() {
      return [{
        id: "vendor-a",
        name: "Vendor A",
        connected: true,
        env: [],
        authMethods: [
          { type: "api" as const, label: "API Key", index: 0 },
          { type: "oauth" as const, label: "OAuth", index: 1 },
        ],
        models: [{
          id: "game-model",
          name: "Game Model",
          toolCall: true,
          reasoning: true,
          reasoningEfforts: ["low", "high"],
          status: "active",
        }],
      }];
    },
    async listPackyProviders() { return []; },
    async listPackyCatalog() {
      return { source: "test", fetchedAt: 1, vendors: [], groups: [], models: [] };
    },
    async listPackyAuthorizedModels() { return ["game-model"]; },
    async configurePackyProvider() { throw new Error("not used"); },
    async listAggregatorProviders() { return [] as AggregatorProviderSummary[]; },
    async discoverAggregatorModels(baseUrl: string, apiKey: string) {
      calls.aggregatorDiscoveries.push({ baseUrl, apiKey });
      return {
        models: [{ id: "game-model", name: "Game Model" }],
        discoveredModelCount: 1,
        rejectedModelCount: 0,
      };
    },
    async configureAggregatorProvider(input: AggregatorProviderConfiguration) {
      return {
        providerId: input.providerId,
        name: input.name,
        baseUrl: input.baseUrl,
        connected: true,
        models: input.models.map((model) => ({ ...model, toolCall: true })),
      } satisfies AggregatorProviderSummary;
    },
    async listModelVerifications() { return []; },
    async verifyModels(requests: Array<{ providerId: string; modelId: string }>) {
      return requests.map((request) => ({
        ...request,
        ready: true,
        cached: false,
        error: "",
        record: {
          ...request,
          verifiedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          method: "opencode" as const,
          latencyMs: 1,
        },
      }));
    },
    async setApiKey(providerId: string, key: string) {
      calls.apiKeys.push({ providerId, key });
    },
    async startOAuth(providerId: string, method: number) {
      calls.oauth.push({ action: "start", providerId, method });
      return {
        url: "https://example.invalid/authorize",
        method: "code" as const,
        instructions: "Sign in",
      };
    },
    async completeOAuth(providerId: string, method: number, code?: string) {
      calls.oauth.push({ action: "complete", providerId, method, code });
    },
    close() {},
  };
  const controlPlane = new ControlPlane(manager, {
    projectRoot: directory,
    dataDir,
    outputDir: path.join(directory, "runs"),
    workspaceTemplate: path.resolve("examples/template"),
    dashboard: { hostname, port: 8787 },
    opencode: {
      hostname: "127.0.0.1",
      port: 4096,
      startupTimeoutMs: 5_000,
      agent: "build",
      config: {},
    },
  }, providerGateway);
  await controlPlane.initialize();
  const dashboard = new DashboardServer(db, manager, controlPlane, { hostname, port: 0 });
  const startedUrl = await dashboard.start();
  const url = startedUrl.replace("0.0.0.0", "127.0.0.1");
  return {
    directory,
    db,
    manager,
    controlPlane,
    dashboard,
    url,
    calls,
    async close() {
      await manager.shutdown();
      await dashboard.close();
      controlPlane.close();
      db.close();
    },
  };
}

async function importDataset(url: string, tasks: number, rounds: number) {
  const response = await postJson(url, "/api/datasets/import", {
    name: "Lifecycle dataset",
    files: Array.from({ length: tasks }, (_, index) => ({
      path: `games/game-${index + 1}.json`,
      content: taskJson(`lifecycle-${index + 1}`, rounds),
    })),
  });
  expect(response.response.status).toBe(201);
  return response.body as { id: string };
}

function taskJson(id: string, rounds: number): string {
  return JSON.stringify({
    id,
    title: `Lifecycle game ${id}`,
    rounds: Array.from({ length: rounds }, (_, index) => ({
      id: `round-${index + 1}`,
      prompt: `prompt ${index + 1}`,
    })),
  });
}

async function postJson(url: string, pathname: string, body: unknown) {
  const response = await fetch(`${url}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GameBench-CSRF": await csrfToken(url),
    },
    body: JSON.stringify(body),
  });
  return {
    response,
    body: await response.json() as unknown,
  };
}

async function csrfToken(url: string): Promise<string> {
  const cached = csrfTokens.get(url);
  if (cached) return cached;
  const response = await fetch(`${url}/api/setup`);
  const setup = await response.json() as { csrfToken?: string };
  if (!setup.csrfToken) throw new Error("dashboard did not issue a CSRF token");
  csrfTokens.set(url, setup.csrfToken);
  return setup.csrfToken;
}

async function getJson<T>(url: string, pathname: string): Promise<T> {
  const response = await fetch(`${url}${pathname}`);
  expect(response.status).toBe(200);
  return await response.json() as T;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for dashboard state");
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for SSE event")), remaining),
      ),
    ]);
    if (result.done) throw new Error("SSE stream closed before an event arrived");
    buffer += decoder.decode(result.value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event.split("\n").find((line) => line.startsWith("data: "));
      if (data) return JSON.parse(data.slice(6)) as Record<string, unknown>;
    }
  }
  throw new Error("timed out waiting for SSE event");
}

async function readSseEventOfType(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  type: string,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await readSseEvent(reader, Math.max(1, deadline - Date.now()));
    if (event.type === type) return event;
  }
  throw new Error(`timed out waiting for SSE event ${type}`);
}
