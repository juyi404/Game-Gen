import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/control-plane.js";
import { BenchmarkDatabase } from "../src/database.js";
import { OrchestratorManager } from "../src/manager.js";
import type {
  PackyCatalog,
  PackyProviderConfiguration,
  PackyProviderSummary,
} from "../src/opencode-service.js";
import { DashboardServer } from "../src/server/dashboard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("web control plane", () => {
  it("imports a JSON batch and starts a configured mock matrix through HTTP", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-control-"));
    temporaryDirectories.push(directory);
    const dataDir = path.join(directory, "data");
    const db = new BenchmarkDatabase(path.join(dataDir, "benchmark.sqlite"));
    const manager = new OrchestratorManager(db);
    const credentialWrites: Array<{ providerId: string; key: string }> = [];
    const packyWrites: PackyProviderConfiguration[] = [];
    const packyKeyChecks: string[] = [];
    const packyProviders: PackyProviderSummary[] = [];
    const packyCatalog: PackyCatalog = {
      source: "https://www.packyapi.ai/api/pricing",
      fetchedAt: 1234,
      vendors: [{ id: 2, name: "OpenAI" }, { id: 42, name: "DeepSeek" }],
      groups: [{
        id: "codex",
        name: "Codex",
        description: "Codex 专用",
        modelCount: 2,
        sourceModelCount: 2,
        protocols: ["openai"],
        defaultProtocol: "openai",
      }, {
        id: "azure-officially",
        name: "Azure Officially",
        description: "Azure 官方渠道",
        modelCount: 1,
        sourceModelCount: 1,
        protocols: ["openai"],
        defaultProtocol: "openai",
      }, {
        id: "deepseek-officially",
        name: "DeepSeek Officially",
        description: "DeepSeek 官方渠道",
        modelCount: 2,
        sourceModelCount: 2,
        protocols: ["openai", "anthropic"],
        defaultProtocol: "openai",
      }],
      models: [{
        id: "gpt-5.2-codex",
        name: "gpt-5.2-codex",
        vendorId: 2,
        vendor: "OpenAI",
        groups: ["codex"],
        endpoints: ["openai-response"],
        protocols: ["openai"],
        sourceGeneration: true,
      }, {
        id: "gpt-5.2",
        name: "gpt-5.2",
        vendorId: 2,
        vendor: "OpenAI",
        groups: ["codex", "azure-officially"],
        endpoints: ["openai", "openai-response"],
        protocols: ["openai"],
        sourceGeneration: true,
      }, {
        id: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        vendorId: 42,
        vendor: "DeepSeek",
        groups: ["deepseek-officially"],
        endpoints: ["openai", "anthropic"],
        protocols: ["openai", "anthropic"],
        sourceGeneration: true,
      }, {
        id: "deepseek-v4-pro",
        name: "deepseek-v4-pro",
        vendorId: 42,
        vendor: "DeepSeek",
        groups: ["deepseek-officially"],
        endpoints: ["openai", "anthropic"],
        protocols: ["openai", "anthropic"],
        sourceGeneration: true,
      }],
    };
    const providerGateway = {
      expectedUrl: "http://127.0.0.1:4096",
      url: "http://127.0.0.1:4096",
      async start() {},
      async listProviders() {
        return [{
          id: "vendor-a",
          name: "Vendor A",
          connected: credentialWrites.length > 0,
          env: ["VENDOR_A_API_KEY"],
          authMethods: [{ type: "api" as const, label: "API Key", index: 0 }],
          models: [{
            id: "game-model",
            name: "Game Model",
            toolCall: true,
            reasoning: true,
            reasoningEfforts: ["low", "high"],
            status: "active",
          }, {
            id: "text-only",
            name: "Text Only",
            toolCall: false,
            reasoning: false,
            reasoningEfforts: [],
            status: "active",
          }],
        }, ...packyProviders.map((provider) => ({
          id: provider.providerId,
          name: provider.name,
          connected: provider.connected,
          env: [],
          authMethods: [],
          models: provider.models.map((model) => ({
            id: model.id,
            name: model.name,
            toolCall: model.toolCall,
            reasoning: model.reasoning ?? false,
            reasoningEfforts: Object.keys(model.variants ?? {}),
            status: "active",
          })),
        }))];
      },
      async listPackyProviders() {
        return packyProviders;
      },
      async listPackyCatalog() {
        return packyCatalog;
      },
      async listPackyAuthorizedModels(apiKey: string) {
        packyKeyChecks.push(apiKey);
        if (apiKey === "packy-codex-target-secret") return ["gpt-5.2-codex", "gpt-5.2"];
        if (apiKey === "packy-wrong-target-secret") return ["deepseek-v4-pro"];
        return packyCatalog.models.map((model) => model.id);
      },
      async configurePackyProvider(input: PackyProviderConfiguration) {
        packyWrites.push(input);
        const summary: PackyProviderSummary = {
          providerId: input.providerId,
          name: input.name,
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          connected: true,
          models: input.models.map((model) => ({ ...model, toolCall: true })),
          ...(input.group ? { group: input.group } : {}),
        };
        const existingIndex = packyProviders.findIndex(
          (provider) => provider.providerId === input.providerId,
        );
        if (existingIndex >= 0) packyProviders[existingIndex] = summary;
        else packyProviders.push(summary);
        return summary;
      },
      async setApiKey(providerId: string, key: string) {
        credentialWrites.push({ providerId, key });
      },
      async startOAuth() {
        return { url: "https://example.invalid/auth", method: "code" as const, instructions: "Login" };
      },
      async completeOAuth() {},
      close() {},
    };
    const controlPlane = new ControlPlane(manager, {
      projectRoot: directory,
      dataDir,
      outputDir: path.join(directory, "runs"),
      dashboard: { hostname: "127.0.0.1", port: 8787 },
      opencode: {
        hostname: "127.0.0.1",
        port: 4096,
        startupTimeoutMs: 5_000,
        agent: "build",
        config: {},
      },
    }, providerGateway);
    await controlPlane.initialize();
    const dashboard = new DashboardServer(
      db,
      manager,
      controlPlane,
      { hostname: "127.0.0.1", port: 0 },
    );
    const url = await dashboard.start();

    try {
      const datasetResponse = await fetch(`${url}/api/datasets/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "HTTP upload",
          files: [
            { path: "games/one.json", content: taskJson("game-one", 2) },
            { path: "games/two.json", content: taskJson("game-two", 3) },
          ],
        }),
      });
      expect(datasetResponse.status).toBe(201);
      const dataset = await datasetResponse.json() as { id: string; taskCount: number };
      expect(dataset.taskCount).toBe(2);

      const aggregateDatasetResponse = await fetch(`${url}/api/datasets/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Single aggregate upload",
          files: [{
            path: "all-games.json",
            content: JSON.stringify({
              dataset: "All games",
              count: 2,
              games: [
                JSON.parse(taskJson("aggregate-one", 4)),
                JSON.parse(taskJson("aggregate-two", 4)),
              ],
            }),
          }],
        }),
      });
      expect(aggregateDatasetResponse.status).toBe(201);
      expect(await aggregateDatasetResponse.json()).toMatchObject({
        fileCount: 1,
        taskCount: 2,
        roundCount: 8,
        preview: [
          { id: "aggregate-one", rounds: 4 },
          { id: "aggregate-two", rounds: 4 },
        ],
      });

      const providerResponse = await fetch(`${url}/api/providers`);
      const providers = await providerResponse.json() as Array<{ id: string; connected: boolean }>;
      expect(providers).toEqual([expect.objectContaining({ id: "vendor-a", connected: false })]);
      const accessResponse = await fetch(`${url}/api/models/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          models: [
            { id: "ready-after-login", model: "vendor-a/game-model", enabled: true, concurrency: 1 },
            { id: "missing-model", model: "vendor-a/missing", enabled: true, concurrency: 1 },
            { id: "missing-provider", model: "vendor-x/game-model", enabled: true, concurrency: 1 },
            { id: "no-tools", model: "vendor-a/text-only", enabled: true, concurrency: 1 },
            { id: "bad-effort", model: "vendor-a/game-model", enabled: true, concurrency: 1, reasoningEffort: "xhigh" },
          ],
        }),
      });
      const access = await accessResponse.json() as { checks: Array<{ id: string; status: string }> };
      expect(access.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "ready-after-login", status: "credential_missing" }),
        expect.objectContaining({ id: "missing-model", status: "model_missing" }),
        expect.objectContaining({ id: "missing-provider", status: "provider_missing" }),
        expect.objectContaining({ id: "no-tools", status: "tools_unsupported" }),
        expect.objectContaining({ id: "bad-effort", status: "reasoning_effort_unsupported" }),
      ]));
      const credentialResponse = await fetch(`${url}/api/auth/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "vendor-a", key: "test-secret" }),
      });
      expect(credentialResponse.status).toBe(200);
      expect(credentialWrites).toEqual([{ providerId: "vendor-a", key: "test-secret" }]);

      const emptyPackyResponse = await fetch(`${url}/api/providers/packy`);
      expect(await emptyPackyResponse.json()).toEqual([]);
      const catalogResponse = await fetch(`${url}/api/providers/packy/catalog?refresh=1`);
      expect(await catalogResponse.json()).toMatchObject({
        source: "https://www.packyapi.ai/api/pricing",
        models: expect.arrayContaining([
          expect.objectContaining({ id: "deepseek-v4-pro", sourceGeneration: true }),
        ]),
      });
      const packyResponse = await fetch(`${url}/api/providers/packy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "packy-codex",
          protocol: "openai",
          baseUrl: "https://www.packyapi.com/v1",
          apiKey: "packy-test-secret",
          models: [
            { id: "gpt-5.2-codex", name: "GPT 5.2 Codex" },
            { id: "gpt-5.2", name: "GPT 5.2" },
          ],
        }),
      });
      expect(packyResponse.status).toBe(201);
      const configuredPacky = await packyResponse.json() as PackyProviderSummary;
      expect(configuredPacky).toMatchObject({
        providerId: "packy-codex",
        protocol: "openai",
        connected: true,
      });
      expect(JSON.stringify(configuredPacky)).not.toContain("packy-test-secret");
      expect(packyWrites).toEqual([expect.objectContaining({
        providerId: "packy-codex",
        apiKey: "packy-test-secret",
        name: "PackyAPI · GPT / Codex",
      })]);
      const connectPackyGroupResponse = await fetch(`${url}/api/providers/packy/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group: "deepseek-officially",
          apiKey: "packy-deepseek-secret",
        }),
      });
      expect(connectPackyGroupResponse.status).toBe(201);
      expect(await connectPackyGroupResponse.json()).toMatchObject({
        providerId: "packy-deepseek-officially",
        group: "deepseek-officially",
        protocol: "openai",
        connected: true,
        models: [
          expect.objectContaining({ id: "deepseek-v4-flash" }),
          expect.objectContaining({ id: "deepseek-v4-pro" }),
        ],
      });
      expect(packyWrites[1]).toMatchObject({
        providerId: "packy-deepseek-officially",
        name: "PackyAPI · DeepSeek Officially",
        protocol: "openai",
        group: "deepseek-officially",
        apiKey: "packy-deepseek-secret",
      });
      const targetPackyResponse = await fetch(`${url}/api/providers/packy/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group: "azure-officially",
          targetModelId: "gpt-5.2",
          apiKey: "packy-codex-target-secret",
        }),
      });
      expect(targetPackyResponse.status).toBe(201);
      expect(await targetPackyResponse.json()).toMatchObject({
        providerId: "packy-codex",
        group: "codex",
        models: expect.arrayContaining([
          expect.objectContaining({ id: "gpt-5.2" }),
          expect.objectContaining({ id: "gpt-5.2-codex" }),
        ]),
      });
      expect(packyWrites[2]).toMatchObject({
        providerId: "packy-codex",
        group: "codex",
        apiKey: "packy-codex-target-secret",
      });
      const wrongTargetResponse = await fetch(`${url}/api/providers/packy/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group: "azure-officially",
          targetModelId: "gpt-5.2",
          apiKey: "packy-wrong-target-secret",
        }),
      });
      expect(wrongTargetResponse.status).toBe(400);
      expect(await wrongTargetResponse.json()).toMatchObject({
        error: expect.stringContaining("/v1/models 未返回 gpt-5.2"),
      });
      expect(packyKeyChecks).toEqual([
        "packy-deepseek-secret",
        "packy-codex-target-secret",
        "packy-wrong-target-secret",
      ]);
      const duplicateProviderResponse = await fetch(`${url}/api/providers/packy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "vendor-a",
          protocol: "openai",
          baseUrl: "https://www.packyapi.com/v1",
          apiKey: "unused",
          models: [{ id: "gpt-5.2", name: "GPT 5.2" }],
        }),
      });
      expect(duplicateProviderResponse.status).toBe(400);
      expect(await duplicateProviderResponse.json()).toMatchObject({
        error: expect.stringContaining("已被其他 OpenCode 供应商使用"),
      });
      const readyResponse = await fetch(`${url}/api/models/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          models: [{ id: "ready", model: "vendor-a/game-model", enabled: true, concurrency: 1 }],
        }),
      });
      expect(await readyResponse.json()).toMatchObject({
        checks: [expect.objectContaining({ id: "ready", status: "ready", ready: true })],
      });

      const invalidRealResponse = await fetch(`${url}/api/experiments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Invalid real run",
          datasetId: dataset.id,
          harness: "opencode",
          models: [{ id: "bad-model", model: "vendor-a/missing", enabled: true, concurrency: 1 }],
          globalConcurrency: 1,
        }),
      });
      expect(invalidRealResponse.status).toBe(400);
      expect(await invalidRealResponse.json()).toMatchObject({
        error: expect.stringContaining("模型接入检查未通过"),
      });

      const experimentResponse = await fetch(`${url}/api/experiments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "UI mock run",
          datasetId: dataset.id,
          harness: "mock",
          models: [
            { id: "model-a", model: "vendor-a/game-model", enabled: true, concurrency: 2, reasoningEffort: "high" },
            { id: "model-b", model: "vendor-b/game-model", enabled: true, concurrency: 2 },
          ],
          globalConcurrency: 2,
          providerConcurrency: { "vendor-a": 1, "vendor-b": 1 },
          maxAttempts: 2,
          roundTimeoutMs: 60_000,
          retryBackoffMs: 10,
        }),
      });
      expect(experimentResponse.status).toBe(201);
      const experiment = await experimentResponse.json() as {
        id: string;
        outputDir: string;
        manifestPath: string;
        settings: { globalConcurrency: number };
      };
      expect(experiment.settings.globalConcurrency).toBe(2);
      expect(experiment).toMatchObject({
        settings: {
          models: expect.arrayContaining([
            expect.objectContaining({ id: "model-a", reasoningEffort: "high" }),
          ]),
        },
      });
      expect(experiment.outputDir).toBe(path.join(directory, "runs", experiment.id));
      expect(db.getExperiment(experiment.id)?.config.runtime.roundTimeoutMs).toBe(0);
      expect(JSON.stringify(db.getExperiment(experiment.id)?.config)).not.toContain("test-secret");

      await waitFor(() => db.getExperiment(experiment.id)?.status === "completed");
      expect(db.getSummary(experiment.id)).toMatchObject({ total: 4, completed: 4, failed: 0 });
      const manifest = JSON.parse(await readFile(experiment.manifestPath, "utf8")) as {
        status: string;
        runs: unknown[];
      };
      expect(manifest).toMatchObject({ status: "completed" });
      expect(manifest.runs).toHaveLength(4);
      for (const run of db.listRuns(experiment.id)) {
        expect(run.workspacePath).not.toBeNull();
        const result = JSON.parse(
          await readFile(path.join(run.workspacePath!, ".benchmark", "result.json"), "utf8"),
        ) as { status: string; rounds: Array<{ contextFile: string }> };
        expect(result.status).toBe("completed");
        for (const round of result.rounds) {
          expect(JSON.parse(await readFile(round.contextFile, "utf8"))).toMatchObject({
            runId: run.id,
            round: { status: "completed" },
            model: {
              reasoningEffort: run.modelId === "model-a" ? "high" : null,
            },
          });
        }
        const detailResponse = await fetch(`${url}/api/runs/${run.id}`);
        const detail = await detailResponse.json() as {
          roundContextDirectory: string;
          rounds: Array<{ contextPath: string }>;
        };
        expect(detail.roundContextDirectory).toBe(
          path.join(run.workspacePath!, ".benchmark", "round-contexts"),
        );
        expect(detail.rounds.map((round) => round.contextPath)).toEqual(
          result.rounds.map((round) => round.contextFile),
        );
      }

      const setupResponse = await fetch(`${url}/api/setup`);
      const setup = await setupResponse.json() as { datasets: Array<{ id: string }>; outputDir: string };
      expect(setup.datasets.some((item) => item.id === dataset.id)).toBe(true);
      expect(setup.outputDir).toBe(path.join(directory, "runs"));
    } finally {
      await manager.shutdown();
      await dashboard.close();
      controlPlane.close();
      db.close();
    }
  });
});

function taskJson(id: string, rounds: number): string {
  return JSON.stringify({
    id,
    title: id,
    rounds: Array.from({ length: rounds }, (_, index) => ({
      id: `round-${index + 1}`,
      prompt: `prompt ${index + 1}`,
    })),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for experiment completion");
}
