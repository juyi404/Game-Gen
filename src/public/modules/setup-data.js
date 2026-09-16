import { createSetupSelectors } from "./setup-selectors.js";

/** API workflows write through the store; they never render or call a view. */
export function createSetupData({ state, store, api, showToast }) {
  const queries = createSetupSelectors(state);
  const pendingSaves = new Map();
  const saveQueues = new Map();
  const unsubscribe = store.subscribe((change) => {
    if (!["models", "model-edit"].includes(change.type) || !change.datasetId) return;
    const { datasetId, revision } = change;
    const models = state.setup.modelSelections[datasetId].models;
    clearTimeout(pendingSaves.get(datasetId));
    pendingSaves.set(datasetId, setTimeout(() => {
      pendingSaves.delete(datasetId);
      // Serialize per-dataset writes: a slow older request must not overwrite a
      // later edit on the server. Other datasets can still save concurrently.
      const save = (saveQueues.get(datasetId) ?? Promise.resolve()).then(async () => {
        try {
          const selection = await api(`/api/datasets/${encodeURIComponent(datasetId)}/models`, {
            method: "PUT", body: JSON.stringify({ models }),
          });
          store.acceptSavedSelection(datasetId, revision, selection);
        } catch (error) {
          showToast(`题库模型选择保存失败：${error.message}`);
        }
      });
      saveQueues.set(datasetId, save);
      void save.finally(() => { if (saveQueues.get(datasetId) === save) saveQueues.delete(datasetId); });
    }, 250));
  });

  async function loadProviders(showSuccess = false) {
    try {
      store.setProviders(await api("/api/providers"));
      store.resolveModelPaths(queries.resolveSelectedModelPath);
      if (showSuccess) showToast(`已检查 ${state.setup.providers.length} 个供应商`);
    } catch (error) {
      if (showSuccess) showToast(`OpenCode 连接失败：${error.message}`);
      throw error;
    }
  }

  async function loadPackyProviders() {
    store.setPackyProviders(await api("/api/providers/packy"));
    store.resolveModelPaths(queries.resolveSelectedModelPath);
  }

  async function loadAggregatorProviders() {
    store.setAggregatorProviders(await api("/api/providers/aggregators"));
  }

  async function loadModelVerifications() {
    store.setVerifications(await api("/api/models/verifications"));
  }

  async function loadPackyCatalog(force = false) {
    try {
      store.setPackyCatalog(await api(`/api/providers/packy/catalog${force ? "?refresh=1" : ""}`));
    } catch (error) {
      store.setPackyCatalogError(error.message);
    }
    store.resolveModelPaths(queries.resolveSelectedModelPath);
  }

  async function verifyModelPaths(paths, force = false) {
    const unique = [...new Set(paths)].slice(0, 100);
    if (unique.length === 0) return [];
    const models = unique.map((model, index) => ({ id: `probe-${index + 1}`, model, enabled: true, concurrency: 1 }));
    const response = await api("/api/models/verify", {
      method: "POST", body: JSON.stringify({ models, force }),
    });
    await loadModelVerifications();
    return response.results;
  }

  async function ensureModelVerified(path) {
    if (queries.activeVerification(path)) return true;
    showToast(`正在通过 OpenCode 端到端验证 ${path}…`);
    try {
      const [result] = await verifyModelPaths([path], true);
      if (!result?.ready) {
        showToast(`${path} 验证失败：${result?.error ?? "未知错误"}`);
        return false;
      }
      showToast(`${path} 已通过 OpenCode 端到端工具调用验证`);
      return true;
    } catch (error) {
      showToast(`${path} 验证失败：${error.message}`);
      return false;
    }
  }

  function addCatalogModel(provider, model) {
    const modelPath = `${provider.id}/${model.id}`;
    if (!state.setup.datasetId || state.setup.models.some((item) => item.model === modelPath)) return false;
    const models = state.setup.models.filter((item) => item.model.trim());
    if (models.length >= 100) return false;
    store.replaceModels([...models, {
      id: queries.uniqueModelId(model.id), model: modelPath, enabled: true, concurrency: 4,
    }]);
    return true;
  }

  return { loadProviders, loadPackyProviders, loadAggregatorProviders, loadModelVerifications,
    loadPackyCatalog, verifyModelPaths, ensureModelVerified, addCatalogModel,
    dispose() { unsubscribe(); for (const timer of pendingSaves.values()) clearTimeout(timer); pendingSaves.clear(); },
  };
}
