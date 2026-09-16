import type { OpencodeClient } from "@opencode-ai/sdk";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelVerificationRecord, PackyProviderConfiguration, ProviderCatalogItem } from "../src/providers/contracts.js";
import { PACKY_CATALOG_CACHE_MS } from "../src/providers/contracts.js";
import { ManagedProviderStore } from "../src/providers/managed-provider-store.js";
import { ModelVerifier } from "../src/providers/model-verifier.js";
import { PackyCatalogService } from "../src/providers/packy-catalog.js";
import { createPackyProviderConfig } from "../src/providers/packy.js";

const temporaryDirectories: string[] = [];
async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebench-provider-modules-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const provider: ProviderCatalogItem = {
  id: "aggregate-test", name: "Test", connected: true, env: [], authMethods: [],
  models: [{ id: "model", name: "Model", toolCall: true, reasoning: false, reasoningEfforts: [], status: "active" }],
};

describe("provider state modules", () => {
  it("round-trips managed configuration independently without persisting credentials", async () => {
    const directory = await stateDirectory();
    const store = new ManagedProviderStore(directory);
    await Promise.all([store.load(), store.load()]);
    const input: PackyProviderConfiguration = {
      providerId: "aggregate-test", apiKey: "secret-that-must-stay-in-auth-store",
      name: "Test", protocol: "openai", baseUrl: "https://gateway.example/v1",
      models: [{ id: "model", name: "Model" }],
    };
    const config = createPackyProviderConfig(input);
    store.set("aggregator", "aggregate-test", config);
    store.set("packy", "packy-test", config);
    await Promise.all([store.persist("aggregator"), store.persist("packy")]);
    const raw = await readFile(path.join(directory, "aggregator-providers.json"), "utf8");
    expect(raw).not.toContain("secret-that-must-stay-in-auth-store");
    const reloaded = new ManagedProviderStore(directory);
    await reloaded.load();
    expect(reloaded.get("aggregator")).toEqual({ "aggregate-test": config });
    expect(reloaded.get("packy")).toEqual({ "packy-test": config });
  });

  it("does not accept unrelated provider ids from the aggregator state file", async () => {
    const directory = await stateDirectory();
    await writeFile(path.join(directory, "aggregator-providers.json"), JSON.stringify({
      providers: { "aggregate-valid": { name: "valid" }, "unrelated": { name: "ignore" }, "aggregate-invalid": [] },
    }));
    const store = new ManagedProviderStore(directory);
    await store.load();
    expect(Object.keys(store.get("aggregator"))).toEqual(["aggregate-valid"]);
  });

  it("retries state loading after a malformed file has been repaired", async () => {
    const directory = await stateDirectory();
    const file = path.join(directory, "model-verifications.json");
    await writeFile(file, "invalid-json");
    const verifier = new ModelVerifier(() => null, async () => [], "build", directory);
    await expect(verifier.listModelVerifications()).rejects.toThrow();
    await writeFile(file, JSON.stringify({ records: [] }));
    await expect(verifier.listModelVerifications()).resolves.toEqual([]);
  });

  it("retains persisted OpenCode verification but never treats a direct probe as an OpenCode probe", async () => {
    const directory = await stateDirectory();
    const record: ModelVerificationRecord = {
      providerId: provider.id, modelId: "model", method: "opencode",
      verifiedAt: Date.now(), expiresAt: Date.now() + 60_000, latencyMs: 15,
    };
    await writeFile(path.join(directory, "model-verifications.json"), JSON.stringify({ version: 2, records: [record] }));
    const getClient = vi.fn(() => null);
    const verifier = new ModelVerifier(getClient, async () => [provider], "build", directory);
    await expect(verifier.verifyModels([{ providerId: provider.id, modelId: "model" }]))
      .resolves.toMatchObject([{ ready: true, cached: true, record }]);
    expect(getClient).not.toHaveBeenCalled();
    await verifier.recordDirectVerifications(provider.id, [{ id: "model", name: "Model" }]);
    await expect(verifier.verifyModels([{ providerId: provider.id, modelId: "model" }]))
      .resolves.toMatchObject([{ ready: false, cached: false }]);
    expect(getClient).toHaveBeenCalled();
    const reloaded = new ModelVerifier(() => null, async () => [], "build", directory);
    expect(await reloaded.listModelVerifications()).toEqual([]);
  });

  it("forces verification and aborts a failed probe before deleting its session", async () => {
    const directory = await stateDirectory();
    const calls: string[] = [];
    const client = {
      session: {
        create: vi.fn(async () => ({ data: { id: "probe-session" } })),
        prompt: vi.fn(async () => { throw new Error("probe-failure"); }),
        abort: vi.fn(async () => { calls.push("abort"); }),
        delete: vi.fn(async () => { calls.push("delete"); }),
      },
      instance: { dispose: vi.fn(async () => { calls.push("dispose"); }) },
    };
    await writeFile(path.join(directory, "model-verifications.json"), JSON.stringify({ version: 2, records: [{
      providerId: provider.id, modelId: "model", method: "opencode",
      verifiedAt: Date.now(), expiresAt: Date.now() + 60_000, latencyMs: 15,
    }] }));
    const verifier = new ModelVerifier(() => client as unknown as OpencodeClient, async () => [provider], "build", directory);
    const results = await verifier.verifyModels([{ providerId: provider.id, modelId: "model" }], true);
    expect(results).toMatchObject([{ ready: false, cached: false, error: expect.stringContaining("probe-failure") }]);
    expect(calls).toEqual(["abort", "delete", "dispose"]);
    expect(await verifier.listModelVerifications()).toEqual([]);
  });

  it("persists a successful real marker probe and reuses it after restarting the verifier", async () => {
    const directory = await stateDirectory();
    const prompt = vi.fn(async (request: {
      query: { directory: string };
      body: { variant?: string; parts: Array<{ text: string }> };
    }) => {
      const text = request.body.parts[0]!.text;
      const marker = text.slice(text.lastIndexOf(": ") + 2);
      await writeFile(path.join(request.query.directory, "gamebench-model-probe.txt"), marker);
    });
    const client = {
      session: {
        create: async () => ({ data: { id: "probe-success" } }), prompt,
        abort: async () => undefined, delete: async () => undefined,
      },
      instance: { dispose: async () => undefined },
    };
    const verifier = new ModelVerifier(() => client as unknown as OpencodeClient, async () => [provider], "build", directory);
    const request = { providerId: provider.id, modelId: "model", reasoningEffort: "high" };
    const [result] = await verifier.verifyModels([request]);
    expect(result).toMatchObject({ ready: true, cached: false, record: { method: "opencode" } });
    expect(prompt.mock.calls[0]![0].body.variant).toBe("high");
    const restarted = new ModelVerifier(() => { throw new Error("Cached model must not create a session"); }, async () => [provider], "build", directory);
    await expect(restarted.verifyModels([request])).resolves.toMatchObject([{ ready: true, cached: true }]);
    // A new variant must call the provider; its failure must not evict the high result.
    prompt.mockRejectedValueOnce(new Error("low variant rejected"));
    await expect(verifier.verifyModels([{ ...request, reasoningEffort: "low" }]))
      .resolves.toMatchObject([{ ready: false, cached: false }]);
    expect(prompt.mock.calls[1]![0].body.variant).toBe("low");
    await expect(verifier.verifyModels([request])).resolves.toMatchObject([{ ready: true, cached: true }]);
    await expect(verifier.verifyModels([{ providerId: provider.id, modelId: "model" }]))
      .resolves.toMatchObject([{ ready: true, cached: false }]);
    const records = await new ModelVerifier(() => null, async () => [provider], "build", directory).listModelVerifications();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.reasoningEffort)).toEqual(expect.arrayContaining(["high", undefined]));
  });

  it("requires a fresh probe for legacy caches whose reasoning variant is unknown", async () => {
    const directory = await stateDirectory();
    await writeFile(path.join(directory, "model-verifications.json"), JSON.stringify({ version: 1, records: [{
      providerId: provider.id, modelId: "model", method: "opencode",
      verifiedAt: Date.now(), expiresAt: Date.now() + 60_000, latencyMs: 1,
    }] }));
    const getClient = vi.fn(() => null);
    const verifier = new ModelVerifier(getClient, async () => [provider], "build", directory);
    expect(await verifier.listModelVerifications()).toEqual([]);
    await expect(verifier.verifyModels([{ providerId: provider.id, modelId: "model" }]))
      .resolves.toMatchObject([{ ready: false, cached: false }]);
    expect(getClient).toHaveBeenCalled();
  });
});

describe("Packy catalog cache", () => {
  it("coalesces concurrent refreshes, honors TTL and retains the last catalog on failure", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const catalog = new PackyCatalogService();
    const first = catalog.listPackyCatalog();
    const second = catalog.listPackyCatalog(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse(new Response(JSON.stringify({ success: true, data: [] })));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(await catalog.listPackyCatalog()).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(10_000 + PACKY_CATALOG_CACHE_MS + 1);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await catalog.listPackyCatalog()).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(new PackyCatalogService().listPackyCatalog()).rejects.toThrow("offline");
  });
});
