import { afterEach, describe, expect, it, vi } from "vitest";

// Browser source stays JavaScript; load its actual modules without a DOM shim.
const { createState } = await import(new URL("../src/public/modules/state.js", import.meta.url).href);
const { createSetupStore } = await import(new URL("../src/public/modules/setup-store.js", import.meta.url).href);
const { createSetupData } = await import(new URL("../src/public/modules/setup-data.js", import.meta.url).href);
const { createSetupSelectors } = await import(new URL("../src/public/modules/setup-selectors.js", import.meta.url).href);
const { createSetupController } = await import(new URL("../src/public/modules/setup-controller.js", import.meta.url).href);
const { createModels } = await import(new URL("../src/public/modules/models.js", import.meta.url).href);

const model = (id: string) => ({ id, model: `provider/${id}`, concurrency: 2, enabled: true });

function fixture() {
  const state = createState();
  const store = createSetupStore(state);
  store.restore({ datasets: [{ id: "a" }, { id: "b" }], modelSelections: {} });
  return { state, store };
}

afterEach(() => { vi.useRealTimers(); });

describe("setup state ownership", () => {
  it("prevents views from mutating selection and catalog snapshots", () => {
    const { state, store } = fixture();
    store.addModel(model("one"));
    store.setProviders([{ id: "provider", models: [{ id: "one" }] }]);
    expect(() => { state.setup.models[0].id = "changed"; }).toThrow(TypeError);
    expect(() => { state.setup.models.push(model("two")); }).toThrow(TypeError);
    expect(() => { state.setup.models = []; }).toThrow(TypeError);
    expect(() => { state.setup.providers[0].models[0].id = "changed"; }).toThrow(TypeError);
    expect(state.setup.models[0].id).toBe("one");
  });

  it("keeps each dataset's draft when switching before autosave, and rejects unknown selections", () => {
    const { state, store } = fixture();
    store.addModel(model("one"));
    store.selectDataset("b");
    expect(state.setup.models).toEqual([]);
    store.addModel(model("two"));
    store.selectDataset("a");
    expect(state.setup.models.map((item: { id: string }) => item.id)).toEqual(["one"]);
    expect(store.selectDataset("missing")).toBe(false);
    expect(state.setup.datasetId).toBe("a");
    store.updateModel(0, { ...state.setup.models[0], concurrency: 7 });
    expect(state.setup.modelSelections.b.models[0].concurrency).toBe(2);
  });

  it("serializes in-flight autosaves and ignores stale responses after further edits", async () => {
    vi.useFakeTimers();
    const { state, store } = fixture();
    const writes: { path: string; models: { id: string }[]; resolve: (value: unknown) => void }[] = [];
    const api = vi.fn((path: string, options: { body: string }) => new Promise((resolve) => {
      writes.push({ path, models: JSON.parse(options.body).models, resolve });
    }));
    const data = createSetupData({ state, store, api, showToast: vi.fn() });
    store.addModel(model("one"));
    await vi.advanceTimersByTimeAsync(250);
    store.updateModel(0, model("newer"));
    await vi.advanceTimersByTimeAsync(250);
    expect(writes).toHaveLength(1);
    writes[0]!.resolve({ datasetId: "a", models: [model("one")], updatedAt: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.models[0]!.id).toBe("newer");
    expect(state.setup.modelSelections.a.models[0].id).toBe("newer");
    store.selectDataset("b");
    store.addModel(model("other"));
    await vi.advanceTimersByTimeAsync(250);
    expect(writes).toHaveLength(3);
    expect(writes[2]!.path).toBe("/api/datasets/b/models");
    writes[1]!.resolve({ datasetId: "a", models: [model("newer")], updatedAt: 2 });
    writes[2]!.resolve({ datasetId: "b", models: [model("other")], updatedAt: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.setup.models[0].id).toBe("other");
    data.dispose();
  });

  it("resolves virtual Packy paths after catalog updates without letting the catalog view mutate models", async () => {
    const { state, store } = fixture();
    store.addModel({ ...model("one"), model: "packyapi/one" });
    const api = vi.fn(async (path: string) => path === "/api/providers"
      ? [{ id: "packy-group", connected: true, models: [{ id: "one", toolCall: true }] }]
      : [{ providerId: "packy-group", connected: true, group: "group", models: [{ id: "one" }] }]);
    const data = createSetupData({ state, store, api, showToast: vi.fn() });
    await data.loadProviders();
    expect(state.setup.models[0].model).toBe("packyapi/one");
    await data.loadPackyProviders();
    expect(state.setup.models[0].model).toBe("packy-group/one");
    expect(state.setup.modelSelections.a.models[0].model).toBe("packy-group/one");
    data.dispose();
  });

  it("enforces the model limit for every catalog entry point", () => {
    const { state, store } = fixture();
    store.replaceModels(Array.from({ length: 100 }, (_, index) => model(`m${index}`)));
    const data = createSetupData({ state, store, api: vi.fn(), showToast: vi.fn() });
    expect(data.addCatalogModel({ id: "provider" }, { id: "extra" })).toBe(false);
    expect(store.addModel(model("extra"))).toBe(false);
    expect(state.setup.models).toHaveLength(100);
    data.dispose();
  });
});

describe("setup page coordination", () => {
  it("constructs feature views without circular callbacks or DOM access", async () => {
    const { state, store } = fixture();
    const api = vi.fn();
    const showToast = vi.fn();
    const data = createSetupData({ state, store, api, showToast });
    for (const [file, factory] of [["models", "createModels"], ["providers", "createProviders"],
      ["connections", "createConnections"], ["datasets", "createDatasets"], ["credentials", "createCredentials"]]) {
      const module = await import(new URL(`../src/public/modules/${file}.js`, import.meta.url).href);
      const view = module[factory!]({ state, store, api, showToast, data, elements: {}, uploadJson: vi.fn() });
      expect(Object.values(view).every((value) => typeof value === "function")).toBe(true);
    }
    data.dispose();
  });

  function pageFixture() {
    const { state, store } = fixture();
    const models = { renderModels: vi.fn(), refreshModelAccess: vi.fn(), renderVerifiedModelPicker: vi.fn(), renderProviderLimits: vi.fn(), updateSetupSummary: vi.fn() };
    const datasets = { renderDatasets: vi.fn(), renderDatasetAvailability: vi.fn() };
    const providers = { renderModelCatalogOptions: vi.fn(), renderProviderManager: vi.fn() };
    const credentials = { renderCredentialDialog: vi.fn() };
    const controller = createSetupController({ state, store, elements: {}, models, datasets, providers,
      credentials, connections: {}, data: {}, showToast: vi.fn() });
    return { state, store, models, datasets, providers, controller };
  }

  it("coalesces provider updates and refreshes all affected views once", async () => {
    const { store, models, datasets, providers, controller } = pageFixture();
    store.setProviders([]);
    store.setPackyProviders([]);
    store.setVerifications([]);
    await Promise.resolve();
    expect(models.renderModels).toHaveBeenCalledTimes(1);
    expect(models.updateSetupSummary).toHaveBeenCalledTimes(1);
    expect(datasets.renderDatasets).toHaveBeenCalledTimes(1);
    expect(providers.renderProviderManager).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("does not replace focused model rows on input edits, and unlocks datasets after verification", async () => {
    const { state, store, models, datasets, controller } = pageFixture();
    store.addModel(model("one"));
    await Promise.resolve();
    vi.clearAllMocks();
    store.updateModel(0, { ...state.setup.models[0], concurrency: 9 });
    store.setVerifications([{ providerId: "provider", modelId: "one", method: "opencode", expiresAt: Date.now() + 60_000 }]);
    await Promise.resolve();
    expect(models.renderModels).not.toHaveBeenCalled();
    expect(models.refreshModelAccess).toHaveBeenCalledTimes(1);
    expect(models.renderVerifiedModelPicker).toHaveBeenCalledTimes(1);
    expect(datasets.renderDatasetAvailability).toHaveBeenCalledTimes(1);
    controller.dispose();
    vi.clearAllMocks();
    store.addModel(model("two"));
    await Promise.resolve();
    expect(models.renderModels).not.toHaveBeenCalled();
  });

  it("uses the same verification predicate in every view", () => {
    const { state, store } = fixture();
    store.setProviders([{ id: "provider", name: "Provider", connected: true,
      models: [{ id: "one", name: "One", toolCall: true }, { id: "two", name: "Two", toolCall: true }] }]);
    store.setVerifications([
      { providerId: "provider", modelId: "one", method: "opencode", expiresAt: Date.now() + 60_000 },
      { providerId: "provider", modelId: "two", method: "opencode", expiresAt: Date.now() - 1 },
    ]);
    const queries = createSetupSelectors(state);
    expect(queries.verifiedModelOptions().map((option: { path: string }) => option.path)).toEqual(["provider/one"]);
    expect(queries.activeVerification("provider/two")).toBeUndefined();
    store.setProviders([{ id: "provider", name: "Provider", connected: false, models: [{ id: "one", name: "One", toolCall: true }] }]);
    expect(queries.verifiedModelOptions()).toEqual([]);
  });

  it("refreshes success and failure badges without replacing the model row or its input", () => {
    const { state, store } = fixture();
    store.addModel(model("one"));
    store.setProviders([{ id: "provider", name: "Provider", connected: true,
      models: [{ id: "one", name: "One", toolCall: true }] }]);
    const badge = { innerHTML: "" };
    const input = { value: "still typing", selectionStart: 5 };
    const row = { dataset: { modelIndex: "0" }, querySelector: vi.fn(() => badge), input };
    const elements = {
      "mock-mode": { checked: false },
      "model-rows": { querySelectorAll: () => [row], set innerHTML(_value: string) { throw new Error("Do not replace focused rows"); } },
    };
    const view = createModels({ state, store, elements, data: {}, showToast: vi.fn() });
    view.refreshModelAccess();
    expect(badge.innerHTML).toContain("尚未实测");
    store.setVerifications([{ providerId: "provider", modelId: "one", method: "opencode", expiresAt: Date.now() + 60_000 }]);
    view.refreshModelAccess();
    expect(badge.innerHTML).toContain("端到端可用");
    store.setProviders([{ id: "provider", name: "Provider", connected: true,
      models: [{ id: "one", name: "One", toolCall: true, reasoningEfforts: ["high"] }] }]);
    store.updateModel(0, { ...state.setup.models[0], reasoningEffort: "high" });
    view.refreshModelAccess();
    expect(badge.innerHTML).toContain("档位待实测");
    store.setVerifications([{ providerId: "provider", modelId: "one", reasoningEffort: "high", method: "opencode", expiresAt: Date.now() + 60_000 }]);
    view.refreshModelAccess();
    expect(badge.innerHTML).toContain("端到端可用");
    store.setVerifications([]);
    view.refreshModelAccess();
    expect(badge.innerHTML).toContain("尚未实测");
    expect(row.input).toBe(input);
    expect(input).toEqual({ value: "still typing", selectionStart: 5 });
  });
});
