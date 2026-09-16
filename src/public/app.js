import { createContext } from "./modules/state.js";
import { clampInteger, timeoutMinutesToMs } from "./modules/format.js";
import { createModels } from "./modules/models.js";
import { createDatasets } from "./modules/datasets.js";
import { createProviders } from "./modules/providers.js";
import { createConnections } from "./modules/connections.js";
import { createCredentials } from "./modules/credentials.js";
import { createMonitor } from "./modules/monitor.js";
import { createUi } from "./modules/ui.js";
import { createSetupSelectors } from "./modules/setup-selectors.js";
import { createSetupStore } from "./modules/setup-store.js";
import { createSetupData } from "./modules/setup-data.js";
import { createSetupController } from "./modules/setup-controller.js";
import { createApi } from "./modules/api.js";

// Composition root: one-way data flow from store changes to the page controller.
const { state, elements } = createContext();
const ui = createUi({ elements });
const { setConnection, showToast, copyPath } = ui;
const { api, uploadJson } = createApi({ state });
const store = createSetupStore(state);
const data = createSetupData({ state, store, api, showToast });
const models = createModels({ state, elements, store, showToast, data });
const datasets = createDatasets({ state, elements, store, api, uploadJson, showToast });
const providers = createProviders({ state, elements, store, showToast, data });
const connections = createConnections({ state, elements, store, api, showToast, data });
const credentials = createCredentials({ state, elements, api, showToast, data });
const setupPage = createSetupController({ state, store, elements, models, datasets, providers, connections, credentials, data, showToast });
const { renderSetup, updateSetupSummary, handleModelClick, handleProviderDetailClick } = setupPage;
const monitor = createMonitor({ state, api, updateSetupSummary, elements, updateLocation, showToast,
  setStatusPill: ui.setStatusPill, copyPath, setConnection });
const { enabledProviderIds } = createSetupSelectors(state);

const { canUseDatasetStep, addModel, renderVerifiedModelPicker, handleVerifiedModelSelection, selectAllVerifiedModels, clearSelectedModels, handleModelInput, balanceProviderConcurrency, renderProviderLimits, renderModels, roundTimeoutDescription } = models;
const { loadSetup, stageFiles, clearStagedFiles, uploadDataset, selectDataset } = datasets;
const { refreshProviderCatalog, openProviderDialog, renderProviderManager, handleProviderListClick, handleProviderDetailInput } = providers;
const { openAggregatorDialog, openPackyDialog, updatePackyGroupPreview, togglePackyKeyVisibility, savePackyProvider, toggleAggregatorKeyVisibility, saveAggregatorProvider, setPackyDialogFeedback, resetAggregatorDialog } = connections;
const { saveApiKey, toggleApiKeyVisibility, startOAuth, completeOAuth } = credentials;
const { loadExperiments, selectExperiment, updateElapsedLabels, refreshExperiment, openRun, performAction, advanceStage, closeDrawer, renderMonitorEmpty } = monitor;

await initialize();

async function initialize() {
  bindEvents();
  try {
    await Promise.all([loadSetup(), loadExperiments(), refreshProviderCatalog(false)]);
    setConnection("online", "本地服务已连接");
  } catch (error) {
    setConnection("offline", "连接失败");
    showToast(error.message);
  }
  renderSetup();
  const query = new URLSearchParams(location.search);
  const queryExperiment = query.get("experiment");
  if (queryExperiment && state.experiments.some((experiment) => experiment.id === queryExperiment)) {
    await switchView("monitor", false);
    await selectExperiment(queryExperiment);
  } else {
    await switchView(query.get("view") === "monitor" ? "monitor" : "setup", false);
  }
  setInterval(updateElapsedLabels, 1000);
  setInterval(() => void refreshExperiment(false), 10_000);
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => void switchView(button.dataset.view));
  });
  elements["experiment-select"].addEventListener("change", async (event) => {
    await switchView("monitor", false);
    await selectExperiment(event.target.value);
  });
  elements["choose-files-button"].addEventListener("click", () => {
    if (canUseDatasetStep()) elements["dataset-files"].click();
  });
  elements["choose-folder-button"].addEventListener("click", () => {
    if (canUseDatasetStep()) elements["dataset-folder"].click();
  });
  elements["dataset-files"].addEventListener("change", (event) => stageFiles(event.target.files));
  elements["dataset-folder"].addEventListener("change", (event) => stageFiles(event.target.files));
  elements["upload-zone"].addEventListener("click", (event) => {
    if (!canUseDatasetStep()) return showToast("请先完成第一步，至少验证一个可调用模型");
    if (!event.target.closest("button")) elements["dataset-files"].click();
  });
  elements["upload-zone"].addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && canUseDatasetStep()) elements["dataset-files"].click();
  });
  for (const eventName of ["dragenter", "dragover"]) {
    elements["upload-zone"].addEventListener(eventName, (event) => {
      event.preventDefault();
      if (canUseDatasetStep()) elements["upload-zone"].classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements["upload-zone"].addEventListener(eventName, (event) => {
      event.preventDefault();
      elements["upload-zone"].classList.remove("dragging");
    });
  }
  elements["upload-zone"].addEventListener("drop", (event) => stageFiles(event.dataTransfer.files));
  elements["clear-upload-button"].addEventListener("click", clearStagedFiles);
  elements["upload-dataset-button"].addEventListener("click", uploadDataset);
  elements["dataset-list"].addEventListener("click", (event) => {
    const button = event.target.closest("[data-dataset-id]");
    if (!button) return;
    selectDataset(button.dataset.datasetId);
  });
  elements["provider-manager-button"].addEventListener("click", () => void openProviderDialog());
  elements["auto-detect-models-button"].addEventListener("click", () => openAggregatorDialog());
  elements["sync-models-button"].addEventListener("click", () => void refreshProviderCatalog(true).catch(() => { }));
  elements["add-model-button"].addEventListener("click", addModel);
  elements["verified-model-search"].addEventListener("input", renderVerifiedModelPicker);
  elements["verified-model-picker"].addEventListener("change", handleVerifiedModelSelection);
  elements["select-all-verified-models-button"].addEventListener("click", selectAllVerifiedModels);
  elements["clear-selected-models-button"].addEventListener("click", clearSelectedModels);
  elements["model-rows"].addEventListener("input", handleModelInput);
  elements["model-rows"].addEventListener("change", handleModelInput);
  elements["model-rows"].addEventListener("click", handleModelClick);
  elements["provider-limits"].addEventListener("input", (event) => {
    const input = event.target.closest("[data-provider-limit]");
    if (!input) return;
    state.setup.providerLimits[input.dataset.providerLimit] = clampInteger(input.value, 1, 1000, 1);
    updateSetupSummary();
  });
  elements["balance-concurrency-button"].addEventListener("click", balanceProviderConcurrency);
  for (const id of ["staged-mode", "global-concurrency", "max-attempts", "round-timeout", "round-idle-timeout", "retry-backoff", "new-experiment-name", "mock-mode", "system-prompt"]) {
    elements[id].addEventListener("input", () => {
      if (id === "global-concurrency") renderProviderLimits();
      if (id === "mock-mode") renderModels();
      updateSetupSummary();
    });
    elements[id].addEventListener("change", updateSetupSummary);
  }
  elements["start-generation-button"].addEventListener("click", startGeneration);
  elements["open-active-button"].addEventListener("click", async () => {
    if (!state.setup.activeExperimentId) return;
    await switchView("monitor", false);
    await selectExperiment(state.setup.activeExperimentId);
  });
  elements["save-api-key-button"].addEventListener("click", saveApiKey);
  elements["toggle-key-button"].addEventListener("click", toggleApiKeyVisibility);
  elements["provider-search"].addEventListener("input", renderProviderManager);
  elements["refresh-provider-dialog-button"].addEventListener("click", () => void refreshProviderCatalog(true).catch(() => { }));
  elements["add-packy-provider-button"].addEventListener("click", () => openPackyDialog());
  elements["add-aggregator-provider-button"].addEventListener("click", () => openAggregatorDialog());
  elements["provider-list"].addEventListener("click", handleProviderListClick);
  elements["provider-detail"].addEventListener("input", handleProviderDetailInput);
  elements["provider-detail"].addEventListener("click", (event) => void handleProviderDetailClick(event));
  elements["packy-group"].addEventListener("change", updatePackyGroupPreview);
  elements["toggle-packy-key-button"].addEventListener("click", togglePackyKeyVisibility);
  elements["save-packy-button"].addEventListener("click", savePackyProvider);
  elements["toggle-aggregator-key-button"].addEventListener("click", toggleAggregatorKeyVisibility);
  elements["connect-aggregator-button"].addEventListener("click", saveAggregatorProvider);
  elements["oauth-methods"].addEventListener("click", startOAuth);
  elements["complete-oauth-button"].addEventListener("click", completeOAuth);
  elements["copy-launch-output"].addEventListener("click", () => copyPath(state.setup.outputDir, "源码保存根目录已复制"));
  elements["copy-monitor-output"].addEventListener("click", () => copyPath(state.experiment?.outputDir, "本次源码目录已复制"));
  elements["credential-dialog"].addEventListener("close", () => {
    elements["api-key-input"].value = "";
    elements["api-key-input"].type = "password";
    state.setup.oauth = null;
  });
  elements["provider-dialog"].addEventListener("close", () => {
    elements["provider-search"].value = "";
    store.setProviderSearch("");
  });
  elements["packy-dialog"].addEventListener("close", () => {
    state.setup.packyTargetModelId = null;
    elements["packy-api-key"].value = "";
    elements["packy-api-key"].type = "password";
    elements["toggle-packy-key-button"].textContent = "显示";
    setPackyDialogFeedback();
  });
  elements["aggregator-dialog"].addEventListener("close", resetAggregatorDialog);
  elements["task-search"].addEventListener("input", () => {
    clearTimeout(state.matrixSearchTimer);
    state.matrixSearchTimer = setTimeout(() => {
      state.runPage.page = 1;
      void refreshExperiment(false);
    }, 250);
  });
  elements["status-filter"].addEventListener("change", () => {
    state.runPage.page = 1;
    void refreshExperiment(false);
  });
  elements["result-model-filter"].addEventListener("change", () => {
    state.runPage.page = 1;
    void refreshExperiment(false);
  });
  elements["run-matrix"].addEventListener("click", (event) => {
    const button = event.target.closest("[data-run-id]");
    if (button) openRun(button.dataset.runId);
  });
  elements["previous-page"].addEventListener("click", () => {
    if (state.runPage.page <= 1) return;
    state.runPage.page -= 1;
    void refreshExperiment(false);
  });
  elements["load-more"].addEventListener("click", () => {
    if (!state.runPage.hasNextPage) return;
    state.runPage.page += 1;
    void refreshExperiment(false);
  });
  elements["pause-button"].addEventListener("click", () => performAction("pause"));
  elements["resume-button"].addEventListener("click", () => performAction("resume"));
  elements["cancel-button"].addEventListener("click", () => performAction("cancel"));
  elements["advance-stage-button"].addEventListener("click", advanceStage);
  elements["drawer-close"].addEventListener("click", closeDrawer);
  elements["drawer-backdrop"].addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });
}

async function switchView(view, updateHistory = true) {
  state.view = view === "monitor" ? "monitor" : "setup";
  elements["setup-view"].classList.toggle("hidden", state.view !== "setup");
  elements["monitor-view"].classList.toggle("hidden", state.view !== "monitor");
  elements["experiment-picker"].classList.toggle("hidden", state.view !== "monitor" || state.experiments.length === 0);
  document.querySelectorAll(".nav-button[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
  if (state.view === "monitor" && !state.experimentId) {
    const selected = state.setup.activeExperimentId ?? state.experiments[0]?.id;
    if (selected) await selectExperiment(selected, false);
    else renderMonitorEmpty();
  }
  if (updateHistory) updateLocation();
}

async function startGeneration() {
  const dataset = state.setup.datasets.find((item) => item.id === state.setup.datasetId);
  if (!dataset) return;
  const realRun = !elements["mock-mode"].checked;
  const stagedMode = elements["staged-mode"].checked;
  const enabledModels = state.setup.models.filter((model) => model.enabled);
  const totalRuns = dataset.taskCount * enabledModels.length;
  const timeoutDescription = roundTimeoutDescription();
  const stageDescription = stagedMode
    ? `本次只生成第 1 阶段；完成后由你手动启动后续阶段。${timeoutDescription}。`
    : `本次会连续执行每个游戏的全部 Prompt。${timeoutDescription}。`;
  if (realRun && !confirm(`即将启动 ${totalRuns.toLocaleString()} 个真实模型生成运行，并把源码保存到\n${state.setup.outputDir}\n\n${stageDescription}\n该操作可能产生 API 费用，确定继续吗？`)) return;
  const providerConcurrency = Object.fromEntries(enabledProviderIds().map((providerId) => [providerId, state.setup.providerLimits[providerId]]));
  const payload = {
    name: elements["new-experiment-name"].value.trim(),
    datasetId: dataset.id,
    harness: realRun ? "opencode" : "mock",
    stageMode: stagedMode ? "manual" : "all",
    models: enabledModels.map((model) => ({ ...model })),
    globalConcurrency: clampInteger(elements["global-concurrency"].value, 1, 1000, 16),
    providerConcurrency,
    maxAttempts: clampInteger(elements["max-attempts"].value, 1, 10, 3),
    roundTimeoutMs: timeoutMinutesToMs(elements["round-timeout"].value),
    roundIdleTimeoutMs: timeoutMinutesToMs(elements["round-idle-timeout"].value),
    retryBackoffMs: clampInteger(elements["retry-backoff"].value, 0, 3600, 15) * 1000,
    ...(elements["system-prompt"].value.trim() ? { systemPrompt: elements["system-prompt"].value.trim() } : {}),
  };
  const button = elements["start-generation-button"];
  button.disabled = true;
  button.querySelector("span").textContent = realRun ? "正在复核模型并创建任务…" : "正在创建演练任务…";
  try {
    const experiment = await api("/api/experiments", { method: "POST", body: JSON.stringify(payload) });
    state.setup.activeExperimentId = experiment.id;
    await loadExperiments();
    await switchView("monitor", false);
    await selectExperiment(experiment.id);
    showToast(stagedMode
      ? `已启动 ${totalRuns.toLocaleString()} 个运行的第 1 阶段`
      : `已启动 ${totalRuns.toLocaleString()} 个生成运行，源码目录已创建`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.querySelector("span").textContent = "开始批量生成";
    updateSetupSummary();
  }
}

function updateLocation() {
  const query = new URLSearchParams();
  query.set("view", state.view);
  if (state.view === "monitor" && state.experimentId) query.set("experiment", state.experimentId);
  history.replaceState(null, "", `?${query.toString()}`);
}
