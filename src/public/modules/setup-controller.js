import { createSetupSelectors } from "./setup-selectors.js";

/** Coordinates page effects. Features do not receive other features' renderers. */
export function createSetupController({ state, store, elements, models, datasets, providers, connections, credentials, data, showToast }) {
  const { getProvider } = createSetupSelectors(state);
  const { ensureModelVerified, addCatalogModel } = data;
  const { openPackyDialog, openAggregatorDialog, refreshPackyCatalogFromDetail, addAllConnectedPackyModels } = connections;
  const { openCredentialDialog } = credentials;
  const changes = new Set();
  let scheduled = false;
  let disposed = false;
  const unsubscribe = store.subscribe(({ type }) => {
    changes.add(type);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  });

  function flush() {
    scheduled = false;
    if (disposed || changes.size === 0) return;
    const pending = new Set(changes);
    changes.clear();
    if (pending.has("catalog") || pending.has("dataset") || pending.has("models")) renderSetup();
    else if (pending.has("verification") || pending.has("model-edit")) {
      if (pending.has("verification")) models.refreshModelAccess();
      datasets.renderDatasets();
      models.renderVerifiedModelPicker();
      models.renderProviderLimits();
      updateSetupSummary();
    }
    // Editing a selected model's name/concurrency must not replace its focused row.
    providers.renderProviderManager();
    if (pending.has("catalog") && state.setup.credentialProviderId) credentials.renderCredentialDialog();
  }

  function renderSetup() {
    datasets.renderDatasets();
    providers.renderModelCatalogOptions();
    models.renderModels();
    models.renderProviderLimits();
    updateSetupSummary();
  }

  function updateSetupSummary() {
    datasets.renderDatasetAvailability();
    models.updateSetupSummary();
  }

  function handleModelClick(event) {
    const row = event.target.closest("[data-model-index]");
    if (!row) return;
    const index = Number(row.dataset.modelIndex);
    if (event.target.closest("[data-remove-model]")) {
      store.removeModel(index);

      models.renderModels();
      models.renderProviderLimits();
      updateSetupSummary();
      return;
    }
    const connectPackyButton = event.target.closest("[data-connect-packy-group]");
    if (connectPackyButton) {
      openPackyDialog(
        connectPackyButton.dataset.connectPackyGroup || null,
        connectPackyButton.dataset.packyModelId || null,
      );
      return;
    }
    if (event.target.closest("[data-credential-provider]")) {
      const providerId = event.target.closest("[data-credential-provider]").dataset.credentialProvider;
      if (!providerId) return showToast("请先填写 provider/model 模型标识");
      void openCredentialDialog(providerId);
    }
  }

  async function handleProviderDetailClick(event) {
    const authButton = event.target.closest("[data-provider-auth]");
    if (authButton) return void openCredentialDialog(authButton.dataset.providerAuth);
    const rescanAggregatorButton = event.target.closest("[data-rescan-aggregator]");
    if (rescanAggregatorButton) {
      return openAggregatorDialog(rescanAggregatorButton.dataset.rescanAggregator);
    }
    const addAllProviderButton = event.target.closest("[data-add-all-provider]");
    if (addAllProviderButton) {
      return providers.addAllProviderModels(addAllProviderButton.dataset.addAllProvider);
    }
    const refreshPackyButton = event.target.closest("[data-refresh-packy]");
    if (refreshPackyButton) return void refreshPackyCatalogFromDetail();
    const connectPackyButton = event.target.closest("[data-connect-packy-group]");
    if (connectPackyButton) {
      return openPackyDialog(
        connectPackyButton.dataset.connectPackyGroup || null,
        connectPackyButton.dataset.packyModelId || null,
      );
    }
    const addAllPackyButton = event.target.closest("[data-add-all-packy]");
    if (addAllPackyButton) return addAllConnectedPackyModels();
    const packyModelButton = event.target.closest("[data-add-packy-model]");
    if (packyModelButton) {
      const path = packyModelButton.dataset.addPackyModel;
      if (!await ensureModelVerified(path)) return;
      if (!state.setup.datasetId) return showToast("模型已验证，第二步题库导入现已解锁");
      const slash = path.indexOf("/");
      const provider = getProvider(path.slice(0, slash));
      const model = provider?.models.find((item) => item.id === path.slice(slash + 1));
      if (!provider || !model || !model.toolCall) return showToast("该 PackyAPI 模型当前不能用于源码生成");
      if (!addCatalogModel(provider, model)) return showToast("该模型已经在任务列表中");
      providers.renderProviderDetail();
      return showToast(`已加入 PackyAPI · ${model.name}`);
    }
    const modelButton = event.target.closest("[data-add-provider-model]");
    if (!modelButton) return;
    const path = modelButton.dataset.addProviderModel;
    if (!await ensureModelVerified(path)) return;
    if (!state.setup.datasetId) return showToast("模型已验证，第二步题库导入现已解锁");
    const slash = path.indexOf("/");
    const provider = getProvider(path.slice(0, slash));
    const model = provider?.models.find((item) => item.id === path.slice(slash + 1));
    if (!provider || !model || !model.toolCall) return showToast("该模型当前不能用于源码生成");
    if (!addCatalogModel(provider, model)) return showToast("该模型已经在任务列表中");
    providers.renderProviderDetail();
    showToast(`已加入 ${provider.name} · ${model.name}`);
  }

  return { renderSetup, updateSetupSummary, handleModelClick, handleProviderDetailClick, flush,
    dispose() { disposed = true; unsubscribe(); changes.clear(); },
  };
}
