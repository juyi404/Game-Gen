const defaultModels = [];

const packyVirtualProviderId = "__packyapi__";
const packyVirtualModelPrefix = "packyapi/";

const state = {
  view: "setup",
  setup: {
    datasets: [],
    datasetId: null,
    modelSelections: {},
    stagedFiles: [],
    models: defaultModels.map((model) => ({ ...model })),
    providers: [],
    providersLoaded: false,
    aggregatorProviders: [],
    modelVerifications: [],
    packyProviders: [],
    packyCatalog: null,
    packyCatalogError: null,
    packyTargetModelId: null,
    selectedProviderId: null,
    providerModelSearch: "",
    providerLimits: {},
    activeExperimentId: null,
    uploadBusy: false,
    credentialProviderId: null,
    oauth: null,
    outputDir: "",
  },
  experiments: [],
  experimentId: null,
  experiment: null,
  summary: null,
  roundSummary: null,
  runs: [],
  modelSummaries: [],
  runPage: { page: 1, pageSize: 50, totalTasks: 0, totalPages: 0, hasNextPage: false },
  events: [],
  selectedRunId: null,
  source: null,
  matrixSearchTimer: null,
  activityRenderTimer: null,
  refreshRequestId: 0,
  refreshTimer: null,
  refreshController: null,
  matrixRenderKey: "",
  activityRenderKey: null,
  csrfToken: "",
};

const elementIds = [
  "setup-view", "monitor-view", "active-run-badge", "experiment-picker", "experiment-select",
  "connection", "setup-readiness", "dataset-step-state", "upload-zone", "choose-files-button",
  "choose-folder-button", "dataset-files", "dataset-folder", "upload-staging", "staged-file-count",
  "staged-file-size", "dataset-name", "upload-dataset-button", "clear-upload-button", "upload-progress", "dataset-lock-note",
  "upload-progress-bar", "upload-progress-label", "dataset-list", "dataset-empty", "model-step-state",
  "provider-step-state", "credential-summary", "auto-detect-models-button", "provider-manager-button", "sync-models-button",
  "model-selection-summary", "verified-model-search", "select-all-verified-models-button",
  "clear-selected-models-button", "verified-model-picker", "add-model-button", "model-rows", "model-catalog-options",
  "provider-dialog", "provider-search", "provider-summary", "refresh-provider-dialog-button",
  "add-packy-provider-button", "add-aggregator-provider-button", "provider-list", "provider-detail",
  "aggregator-dialog", "aggregator-dialog-title", "aggregator-provider-name",
  "aggregator-provider-id", "aggregator-base-url", "aggregator-api-key",
  "toggle-aggregator-key-button", "aggregator-dialog-feedback", "connect-aggregator-button",
  "packy-dialog", "packy-dialog-title", "packy-dialog-subtitle", "packy-group",
  "packy-target-model", "packy-group-hint", "packy-model-preview", "packy-dialog-feedback",
  "packy-api-key", "toggle-packy-key-button",
  "save-packy-button",
  "policy-step-state", "staged-mode", "global-concurrency", "max-attempts", "round-timeout", "round-idle-timeout", "retry-backoff",
  "provider-limits", "balance-concurrency-button", "mock-mode", "system-prompt", "new-experiment-name",
  "launch-task-count", "launch-model-count", "launch-run-count", "launch-concurrency", "matrix-formula",
  "launch-output-dir", "copy-launch-output", "launch-checklist", "start-generation-button", "start-generation-subtitle", "open-active-button", "monitor-empty", "monitor-content",
  "experiment-status", "experiment-name", "experiment-meta", "summary-cards", "progress-number",
  "progress-bar", "progress-caption", "stage-control", "stage-control-title", "stage-control-description", "stage-context-note", "stage-control-progress", "advance-stage-button", "monitor-output-dir", "monitor-manifest-path", "copy-monitor-output", "model-list", "activity-list", "event-count", "task-search",
  "status-filter", "run-matrix", "matrix-empty", "matrix-pagination", "previous-page", "page-summary", "load-more", "pause-button", "resume-button",
  "cancel-button", "run-drawer", "drawer-backdrop", "drawer-close", "drawer-title", "drawer-content",
  "credential-dialog", "credential-title", "credential-subtitle", "credential-current", "api-key-input",
  "toggle-key-button", "save-api-key-button", "oauth-section", "oauth-methods", "oauth-completion",
  "oauth-instructions", "oauth-code-field", "oauth-code-input", "complete-oauth-button", "toast",
];
const elements = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));
const modelDraftSaveTimers = new Map();

const statusLabels = {
  queued: "排队中", preparing: "准备中", running: "运行中", retrying: "等待续跑",
  awaiting_stage: "本阶段已完成", completed: "全部完成", failed: "失败", cancelled: "已取消", paused: "已暂停",
  pending: "等待中",
};

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
  elements["sync-models-button"].addEventListener("click", () => void refreshProviderCatalog(true).catch(() => {}));
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
  elements["refresh-provider-dialog-button"].addEventListener("click", () => void refreshProviderCatalog(true).catch(() => {}));
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
    state.setup.providerModelSearch = "";
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

async function loadSetup() {
  const setup = await api("/api/setup");
  state.csrfToken = setup.csrfToken ?? "";
  state.setup.datasets = setup.datasets;
  state.setup.modelSelections = setup.modelSelections ?? {};
  state.setup.datasetId = setup.datasets[0]?.id ?? null;
  state.setup.models = selectedDatasetModels(state.setup.datasetId);
  state.setup.activeExperimentId = setup.activeExperimentId;
  state.setup.outputDir = setup.outputDir ?? "";
  elements["launch-output-dir"].textContent = state.setup.outputDir || "未配置";
  elements["copy-launch-output"].disabled = !state.setup.outputDir;
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

function stageFiles(fileList) {
  if (!canUseDatasetStep()) {
    showToast("请先完成第一步，至少验证一个可调用模型");
    return;
  }
  const files = [...(fileList ?? [])].filter((file) => file.name.toLowerCase().endsWith(".json"));
  if (files.length === 0) {
    showToast("请选择 .json 题目文件");
    return;
  }
  const seen = new Set();
  state.setup.stagedFiles = files.filter((file) => {
    const relativePath = file.webkitRelativePath || file.name;
    if (seen.has(relativePath)) return false;
    seen.add(relativePath);
    return true;
  });
  if (!elements["dataset-name"].value.trim()) {
    const firstPath = state.setup.stagedFiles[0]?.webkitRelativePath;
    const folderName = firstPath?.includes("/") ? firstPath.split("/")[0] : "";
    const singleFileName = state.setup.stagedFiles.length === 1
      ? state.setup.stagedFiles[0].name.replace(/\.json$/i, "")
      : "";
    elements["dataset-name"].value = folderName
      || singleFileName
      || `游戏题库 ${new Date().toLocaleDateString("zh-CN")}`;
  }
  renderStagedFiles();
}

function renderStagedFiles() {
  const files = state.setup.stagedFiles;
  elements["upload-staging"].classList.toggle("hidden", files.length === 0);
  elements["staged-file-count"].textContent = `${files.length.toLocaleString()} 个 JSON 已选择`;
  elements["staged-file-size"].textContent = `${formatBytes(files.reduce((total, file) => total + file.size, 0))} · 尚未上传`;
}

function clearStagedFiles() {
  state.setup.stagedFiles = [];
  elements["dataset-files"].value = "";
  elements["dataset-folder"].value = "";
  elements["dataset-name"].value = "";
  elements["upload-progress"].classList.add("hidden");
  renderStagedFiles();
}

async function uploadDataset() {
  if (!canUseDatasetStep()) return showToast("请先完成第一步，至少验证一个可调用模型");
  const files = state.setup.stagedFiles;
  const name = elements["dataset-name"].value.trim();
  if (files.length === 0 || !name) {
    showToast("请先选择 JSON 文件并填写题库名称");
    return;
  }
  setUploadBusy(true);
  try {
    const payloadFiles = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      payloadFiles.push({ path: file.webkitRelativePath || file.name, content: await file.text() });
      const progress = Math.round(((index + 1) / files.length) * 35);
      setUploadProgress(progress, `正在读取 ${index + 1} / ${files.length} 个文件`);
    }
    const dataset = await uploadJson("/api/datasets/import", { name, files: payloadFiles }, (progress) => {
      setUploadProgress(35 + Math.round(progress * 0.6), `正在上传并校验 ${files.length} 个 JSON`);
    });
    setUploadProgress(100, `导入完成：${dataset.taskCount} 道题，${dataset.roundCount} 轮 Prompt`);
    state.setup.datasets.unshift(dataset);
    state.setup.datasetId = dataset.id;
    state.setup.modelSelections[dataset.id] = { datasetId: dataset.id, models: [], updatedAt: Date.now() };
    state.setup.models = [];
    clearStagedFiles();
    renderDatasets();
    renderVerifiedModelPicker();
    updateSetupSummary();
    showToast(`题库校验通过，已导入 ${dataset.taskCount} 道题`);
  } catch (error) {
    showToast(error.message);
  } finally {
    setUploadBusy(false);
  }
}

function setUploadBusy(busy) {
  state.setup.uploadBusy = busy;
  elements["upload-progress"].classList.toggle("hidden", !busy);
  renderDatasetAvailability();
}

function setUploadProgress(value, label) {
  elements["upload-progress-bar"].style.width = `${value}%`;
  elements["upload-progress-label"].textContent = label;
}

function renderSetup() {
  renderDatasets();
  renderModelCatalogOptions();
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
}

function renderDatasets() {
  const datasets = state.setup.datasets;
  renderDatasetAvailability();
  elements["dataset-empty"].classList.toggle("hidden", datasets.length > 0);
  elements["dataset-list"].innerHTML = datasets.map((dataset) => `
    <button class="dataset-card ${dataset.id === state.setup.datasetId ? "selected" : ""}" data-dataset-id="${escapeHtml(dataset.id)}" type="button" ${canUseDatasetStep() ? "" : "disabled"}>
      <i class="dataset-radio"></i>
      <span><strong>${escapeHtml(dataset.name)}</strong><span>${dataset.taskCount.toLocaleString()} 道题 · ${dataset.roundCount.toLocaleString()} 轮 · ${formatBytes(dataset.totalBytes)}</span></span>
      <time>${formatDate(dataset.createdAt)}</time>
    </button>
  `).join("");
}

function renderDatasetAvailability() {
  const unlocked = canUseDatasetStep();
  const blocked = !unlocked || state.setup.uploadBusy;
  elements["upload-zone"].classList.toggle("locked", !unlocked);
  elements["upload-zone"].setAttribute("aria-disabled", String(!unlocked));
  elements["upload-zone"].tabIndex = unlocked ? 0 : -1;
  elements["choose-files-button"].disabled = blocked;
  elements["choose-folder-button"].disabled = blocked;
  elements["dataset-files"].disabled = blocked;
  elements["dataset-folder"].disabled = blocked;
  elements["upload-dataset-button"].disabled = blocked;
  elements["dataset-lock-note"].classList.toggle("hidden", unlocked);
  elements["dataset-list"].querySelectorAll("[data-dataset-id]").forEach((button) => {
    button.disabled = !unlocked;
  });
}

function selectedDatasetModels(datasetId) {
  return (state.setup.modelSelections[datasetId]?.models ?? []).map((model) => ({ ...model }));
}

function selectDataset(datasetId) {
  if (!canUseDatasetStep()) return showToast("请先完成第一步，至少验证一个可调用模型");
  state.setup.datasetId = datasetId;
  state.setup.models = selectedDatasetModels(datasetId);
  renderDatasets();
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
}

function scheduleModelDraftSave() {
  const datasetId = state.setup.datasetId;
  if (!datasetId) return;
  const models = state.setup.models.map((model) => ({ ...model }));
  state.setup.modelSelections[datasetId] = { datasetId, models, updatedAt: Date.now() };
  clearTimeout(modelDraftSaveTimers.get(datasetId));
  modelDraftSaveTimers.set(datasetId, setTimeout(async () => {
    modelDraftSaveTimers.delete(datasetId);
    try {
      const selection = await api(`/api/datasets/${encodeURIComponent(datasetId)}/models`, {
        method: "PUT",
        body: JSON.stringify({ models }),
      });
      state.setup.modelSelections[datasetId] = selection;
    } catch (error) {
      showToast(`题库模型选择保存失败：${error.message}`);
    }
  }, 250));
}

function canUseDatasetStep() {
  return elements["mock-mode"].checked || verifiedModelOptions().length > 0;
}

function addModel() {
  if (!state.setup.datasetId) return showToast("请先导入并选择题库，再添加运行模型");
  if (!elements["mock-mode"].checked) return showToast("真实任务只能选择已完成实际调用验证的模型；手动模型仅用于演练模式");
  state.setup.models.push({ id: "", model: "", enabled: true, concurrency: 2 });
  scheduleModelDraftSave();
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
  elements["model-rows"].querySelector("tr:last-child .model-path-input")?.focus();
}

function handleModelInput(event) {
  const row = event.target.closest("[data-model-index]");
  if (!row) return;
  const model = state.setup.models[Number(row.dataset.modelIndex)];
  if (!model) return;
  const field = event.target.dataset.field;
  if (field === "enabled") model.enabled = event.target.checked;
  if (field === "id") model.id = event.target.value;
  if (field === "model") {
    model.model = resolveSelectedModelPath(event.target.value.trim());
    const automaticId = automaticModelId(model.model, model);
    if (automaticId) {
      model.id = automaticId;
      row.querySelector('[data-field="id"]').value = automaticId;
    }
    delete model.reasoningEffort;
    event.target.value = model.model;
    row.querySelector("[data-model-reasoning]").innerHTML = renderReasoningControl(model);
    row.querySelector("[data-model-access]").innerHTML = renderModelAccess(model);
  }
  if (field === "reasoningEffort") {
    if (event.target.value) model.reasoningEffort = event.target.value;
    else delete model.reasoningEffort;
    row.querySelector("[data-model-access]").innerHTML = renderModelAccess(model);
  }
  if (field === "concurrency") model.concurrency = clampInteger(event.target.value, 1, 1000, 1);
  if (["enabled", "model", "reasoningEffort", "concurrency"].includes(field)) {
    renderProviderLimits();
    renderCredentialSummary();
  }
  scheduleModelDraftSave();
  updateSetupSummary();
}

function handleModelClick(event) {
  const row = event.target.closest("[data-model-index]");
  if (!row) return;
  const index = Number(row.dataset.modelIndex);
  if (event.target.closest("[data-remove-model]")) {
    state.setup.models.splice(index, 1);
    scheduleModelDraftSave();
    renderModels();
    renderProviderLimits();
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

function activeVerification(path) {
  return state.setup.modelVerifications.find((record) =>
    `${record.providerId}/${record.modelId}` === path
    && record.method === "opencode"
    && record.expiresAt > Date.now());
}

async function verifyModelPaths(paths, force = false) {
  const unique = [...new Set(paths)].slice(0, 100);
  if (unique.length === 0) return [];
  const models = unique.map((model, index) => ({
    id: `probe-${index + 1}`,
    model,
    enabled: true,
    concurrency: 1,
  }));
  const response = await api("/api/models/verify", {
    method: "POST",
    body: JSON.stringify({ models, force }),
  });
  await loadModelVerifications();
  renderDatasets();
  renderProviderManager();
  return response.results;
}

async function ensureModelVerified(path) {
  if (activeVerification(path)) return true;
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

async function reverifyKnownModels() {
  const paths = state.setup.modelVerifications
    .map((record) => `${record.providerId}/${record.modelId}`)
    .filter((path) => {
      const slash = path.indexOf("/");
      const provider = getProvider(path.slice(0, slash));
      return provider?.models.some((model) => model.id === path.slice(slash + 1) && model.toolCall);
    })
    .slice(0, 100);
  if (paths.length === 0) return;
  elements["sync-models-button"].textContent = `正在端到端复测 ${paths.length} 个模型…`;
  const results = await verifyModelPaths(paths, true);
  const ready = results.filter((result) => result.ready).length;
  showToast(`端到端复测完成：${ready} / ${results.length} 个模型可用`);
}

function verifiedModelOptions() {
  const records = new Map(state.setup.modelVerifications
    .filter((record) => record.method === "opencode" && record.expiresAt > Date.now())
    .map((record) => [`${record.providerId}/${record.modelId}`, record]));
  return state.setup.providers
    .filter((provider) => provider.connected)
    .flatMap((provider) => provider.models
      .filter((model) => model.toolCall && records.has(`${provider.id}/${model.id}`))
      .map((model) => ({
        provider,
        model,
        path: `${provider.id}/${model.id}`,
        verification: records.get(`${provider.id}/${model.id}`),
      })))
    .sort((left, right) => left.provider.name.localeCompare(right.provider.name)
      || left.model.name.localeCompare(right.model.name));
}

function renderVerifiedModelPicker() {
  const dataset = state.setup.datasets.find((item) => item.id === state.setup.datasetId);
  const options = verifiedModelOptions();
  const query = elements["verified-model-search"].value.trim().toLowerCase();
  const filtered = options.filter((option) => !query
    || option.model.name.toLowerCase().includes(query)
    || option.model.id.toLowerCase().includes(query)
    || option.provider.name.toLowerCase().includes(query)
    || option.provider.id.toLowerCase().includes(query));
  const selectedPaths = new Set(state.setup.models.map((model) => model.model));
  const selectedVerified = options.filter((option) => selectedPaths.has(option.path)).length;
  elements["model-selection-summary"].textContent = !dataset
    ? "请先导入并选择题库"
    : options.length === 0
      ? "当前没有通过真实调用验证的模型"
      : `${dataset.name} · 已选择 ${selectedVerified} / ${options.length} 个已验证模型`;
  elements["select-all-verified-models-button"].disabled = !dataset || options.length === 0;
  elements["clear-selected-models-button"].disabled = state.setup.models.length === 0;
  if (!dataset) {
    elements["verified-model-picker"].innerHTML = '<div class="empty-state">完成第二步并选择一个题库后，即可在这里多选模型。</div>';
    return;
  }
  if (options.length === 0) {
    elements["verified-model-picker"].innerHTML = '<div class="empty-state">尚无实测可用模型，请返回第一步填写 API 并完成验证。</div>';
    return;
  }
  elements["verified-model-picker"].innerHTML = filtered.length
    ? filtered.map((option) => {
      const selected = selectedPaths.has(option.path);
      const efforts = option.model.reasoningEfforts?.length
        ? option.model.reasoningEfforts.join(" · ")
        : option.model.reasoning ? "固定推理" : "供应商默认";
      return `<label class="verified-model-option ${selected ? "selected" : ""}">
        <input data-verified-model-path="${escapeHtml(option.path)}" type="checkbox" ${selected ? "checked" : ""} />
        <span><strong>${escapeHtml(option.model.name)}</strong><code>${escapeHtml(option.path)}</code><small>${escapeHtml(option.provider.name)} · ${escapeHtml(efforts)}</small></span>
        <i>端到端可用</i>
      </label>`;
    }).join("")
    : '<div class="empty-state">没有匹配的已验证模型。</div>';
}

function handleVerifiedModelSelection(event) {
  const input = event.target.closest("[data-verified-model-path]");
  if (!input) return;
  const option = verifiedModelOptions().find((item) => item.path === input.dataset.verifiedModelPath);
  if (!option) return renderVerifiedModelPicker();
  if (input.checked) {
    if (state.setup.models.length >= 100) {
      input.checked = false;
      return showToast("单次任务最多选择 100 个模型");
    }
    addCatalogModel(option.provider, option.model);
    showToast(`已为当前题库选择 ${option.model.name}`);
    return;
  }
  state.setup.models = state.setup.models.filter((model) => model.model !== option.path);
  scheduleModelDraftSave();
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
}

function selectAllVerifiedModels() {
  if (!state.setup.datasetId) return showToast("请先导入并选择题库");
  const options = verifiedModelOptions();
  let added = 0;
  for (const option of options) {
    if (state.setup.models.length >= 100) break;
    if (addCatalogModel(option.provider, option.model, false)) added += 1;
  }
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
  showToast(added
    ? `已选择 ${added} 个模型${options.length > 100 ? "；单次任务最多 100 个" : ""}`
    : "全部可用模型都已选择");
}

function clearSelectedModels() {
  state.setup.models = [];
  scheduleModelDraftSave();
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
  showToast("已清空当前题库的模型选择");
}

function renderModels() {
  elements["add-model-button"].disabled = !elements["mock-mode"].checked || !state.setup.datasetId;
  elements["add-model-button"].title = elements["mock-mode"].checked
    ? "为演练任务手动添加 provider/model"
    : "真实任务只能从已验证模型池中选择";
  const rows = state.setup.models.map((model, index) => {
    return `<tr data-model-index="${index}">
      <td><input data-field="enabled" type="checkbox" ${model.enabled ? "checked" : ""} aria-label="启用 ${escapeHtml(model.id)}" /></td>
      <td><input data-field="id" type="text" value="${escapeHtml(model.id)}" maxlength="120" placeholder="选择模型后自动填写" aria-label="运行名称" /></td>
      <td><input data-field="model" class="model-path-input" type="text" list="model-catalog-options" value="${escapeHtml(model.model)}" placeholder="搜索或选择模型" aria-label="模型选择" /></td>
      <td data-model-reasoning>${renderReasoningControl(model)}</td>
      <td><input data-field="concurrency" type="number" min="1" max="1000" value="${model.concurrency}" aria-label="单模型并发" /></td>
      <td data-model-access>${renderModelAccess(model)}</td>
      <td><button class="remove-model" data-remove-model type="button" aria-label="移除模型">×</button></td>
    </tr>`;
  }).join("");
  elements["model-rows"].innerHTML = rows
    || '<tr><td class="model-table-empty" colspan="7">请从上方已验证模型池中勾选一个或多个模型。</td></tr>';
  renderVerifiedModelPicker();
  renderCredentialSummary();
}

function renderReasoningControl(model) {
  const profile = getReasoningProfile(model.model);
  const efforts = profile?.reasoningEfforts ?? [];
  const selected = model.reasoningEffort ?? "";
  const note = reasoningModeNote(model.model, efforts);
  if (efforts.length === 0 && !selected) {
    const label = profile?.reasoning ? "固定推理（不可调）" : "供应商默认";
    return renderReasoningSelect(
      `<select data-field="reasoningEffort" disabled aria-label="推理强度"><option>${label}</option></select>`,
      note,
    );
  }
  const options = [
    '<option value="">供应商默认</option>',
    ...efforts.map((effort) => `<option value="${escapeHtml(effort)}" ${selected === effort ? "selected" : ""}>${escapeHtml(reasoningEffortLabel(effort))}</option>`),
  ];
  if (selected && !efforts.includes(selected)) {
    options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}（当前模型不支持）</option>`);
  }
  return renderReasoningSelect(
    `<select data-field="reasoningEffort" aria-label="推理强度" title="只显示 OpenCode 为该模型返回的真实档位">${options.join("")}</select>`,
    note,
  );
}

function renderReasoningSelect(select, note) {
  return `<div class="reasoning-control">${select}${note ? `<small>${escapeHtml(note)}</small>` : ""}</div>`;
}

function reasoningModeNote(modelPath, efforts) {
  if (efforts.includes("ultra")) return "";
  const slash = modelPath.indexOf("/");
  const modelId = slash >= 0 ? modelPath.slice(slash + 1) : modelPath;
  return /^gpt-5\.6(?:-sol|-terra)?$/i.test(modelId)
    ? "Ultra：Codex 多代理模式，非 API 推理档位"
    : "";
}

function getReasoningProfile(modelPath) {
  const packyModelId = packyModelIdFromPath(modelPath);
  if (packyModelId !== null) {
    return state.setup.providers
      .flatMap((provider) => provider.models.filter((model) => model.id === packyModelId))
      .sort((left, right) => (right.reasoningEfforts?.length ?? 0) - (left.reasoningEfforts?.length ?? 0))[0] ?? null;
  }
  const slash = modelPath.indexOf("/");
  if (slash <= 0 || slash === modelPath.length - 1) return null;
  return getProvider(modelPath.slice(0, slash))?.models
    .find((model) => model.id === modelPath.slice(slash + 1)) ?? null;
}

function reasoningEffortLabel(effort) {
  const labels = {
    none: "none（关闭推理）",
    minimal: "minimal（极低）",
    low: "low（低）",
    medium: "medium（中）",
    high: "high（高）",
    xhigh: "xhigh（超高）",
    max: "max（最高）",
    ultra: "ultra（极限）",
    thinking: "thinking（开启推理）",
  };
  return labels[effort] ?? effort;
}

function renderModelAccess(model) {
  const access = getModelAccess(model);
  const providerId = providerFromModel(model.model);
  const provider = getProvider(providerId);
  const packyModelId = packyModelIdFromPath(model.model);
  const packyModel = packyModelId === null ? null : getPackyCatalogModel(packyModelId);
  const configuredPackyProfile = packyModelId === null
    ? getPackyProvider(providerId)
    : getPackyProfileForModel(packyModelId);
  const packyGroup = configuredPackyProfile?.group
    ? state.setup.packyCatalog?.groups.find((group) => group.id === configuredPackyProfile.group)
    : packyModel?.sourceGeneration ? preferredPackyGroup(packyModel) : null;
  let credentialButton = "";
  if (packyGroup) {
    const targetModelId = packyModelId ?? model.model.slice(model.model.indexOf("/") + 1);
    credentialButton = `<button class="credential-button" data-connect-packy-group="${escapeHtml(packyGroup.id)}" data-packy-model-id="${escapeHtml(targetModelId)}" type="button">${configuredPackyProfile ? "管理 PackyAPI Key" : "连接此模型"}</button>`;
  } else if (provider) {
    credentialButton = `<button class="credential-button ${provider.connected ? "connected" : ""}" data-credential-provider="${escapeHtml(providerId)}" type="button">${provider.connected ? "管理登录" : "连接 / 登录"}</button>`;
  }
  return `<div class="model-access"><span class="model-check ${access.tone}" title="${escapeHtml(access.message)}"><i></i>${escapeHtml(access.label)}</span>${credentialButton}</div>`;
}

function getModelAccess(model) {
  const slash = model.model.indexOf("/");
  if (slash <= 0 || slash === model.model.length - 1) {
    return { ready: false, tone: "error", label: "标识不完整", message: "请选择 provider/model 格式的模型" };
  }
  if (elements["mock-mode"].checked) {
    return { ready: true, tone: "ready", label: "演练可用", message: "流程演练模式不会调用该模型" };
  }
  if (!state.setup.providersLoaded) {
    return { ready: false, tone: "pending", label: "尚未检查", message: "点击“刷新并复测”" };
  }
  const providerId = model.model.slice(0, slash);
  const modelId = model.model.slice(slash + 1);
  if (providerId === "packyapi") {
    const catalogModel = getPackyCatalogModel(modelId);
    if (!state.setup.packyCatalog) {
      return { ready: false, tone: "pending", label: "目录读取中", message: state.setup.packyCatalogError ?? "正在读取 PackyAPI 官方模型目录" };
    }
    if (!catalogModel) {
      return { ready: false, tone: "error", label: "模型不存在", message: `PackyAPI 当前目录中找不到 ${modelId}` };
    }
    if (!catalogModel.sourceGeneration) {
      return { ready: false, tone: "error", label: "不能生成源码", message: "该 PackyAPI 模型属于图像、审核或其他非源码类型" };
    }
    const group = preferredPackyGroup(catalogModel);
    if (!group) {
      return { ready: false, tone: "warning", label: "暂无可用分组", message: "PackyAPI 当前没有可供 OpenCode 接入的模型分组" };
    }
    const configuredForModel = getPackyProfileForModel(modelId);
    if (configuredForModel) {
      return {
        ready: false,
        tone: "pending",
        label: configuredForModel.connected ? "等待 OpenCode 同步" : "分组 Key 未生效",
        message: configuredForModel.connected
          ? `${configuredForModel.name} 已包含该模型，正在等待 OpenCode 刷新模型路径`
          : `${configuredForModel.name} 已保存，但 OpenCode 尚未识别该 Key`,
      };
    }
    const configuredGroup = getPackyProviderByGroup(group.id);
    return {
      ready: false,
      tone: "warning",
      label: configuredGroup ? "Key 不含此模型" : "需连接 PackyAPI",
      message: configuredGroup
        ? `${group.name} 分组已连接，但这把 Key 的 /v1/models 未返回 ${modelId}`
        : `请连接 ${group.name} 分组 Key，平台会自动创建 OpenCode 模型路径`,
    };
  }
  const provider = getProvider(providerId);
  if (!provider) {
    return { ready: false, tone: "error", label: "供应商不存在", message: `OpenCode 中找不到供应商 ${providerId}` };
  }
  const catalogModel = provider.models.find((item) => item.id === modelId);
  if (!catalogModel) {
    return { ready: false, tone: "error", label: "模型不存在", message: `OpenCode 的 ${providerId} 供应商中找不到 ${modelId}` };
  }
  if (!catalogModel.toolCall) {
    return { ready: false, tone: "error", label: "不能生成源码", message: "该模型不支持工具调用" };
  }
  if (model.reasoningEffort
    && !(catalogModel.reasoningEfforts ?? []).includes(model.reasoningEffort)) {
    const available = catalogModel.reasoningEfforts?.length
      ? catalogModel.reasoningEfforts.join("、")
      : "无可调档位";
    return {
      ready: false,
      tone: "error",
      label: "推理档位无效",
      message: `该模型不支持 ${model.reasoningEffort}；当前可选：${available}`,
    };
  }
  if (!provider.connected) {
    return { ready: false, tone: "warning", label: "尚未登录", message: "请连接 API Key 或完成 OAuth 登录" };
  }
  const verified = verifiedModelOptions().find((option) => option.path === model.model);
  if (!verified) {
    return {
      ready: false,
      tone: "warning",
      label: "尚未实测",
      message: "真实任务只接受第一步中已完成实际工具调用验证的模型",
    };
  }
  return { ready: true, tone: "ready", label: "端到端可用", message: "该模型已通过 OpenCode 正式链路工具调用验证" };
}

async function loadProviders(showSuccess = false) {
  try {
    state.setup.providers = await api("/api/providers");
    state.setup.providersLoaded = true;
    resolvePendingPackyModelRoutes();
    renderModelCatalogOptions();
    renderModels();
    renderProviderLimits();
    renderProviderManager();
    updateSetupSummary();
    if (state.setup.credentialProviderId) renderCredentialDialog();
    if (showSuccess) showToast(`已检查 ${state.setup.providers.length} 个供应商`);
  } catch (error) {
    if (showSuccess) showToast(`OpenCode 连接失败：${error.message}`);
    throw error;
  }
}

async function refreshProviderCatalog(showSuccess = false) {
  const buttons = [elements["sync-models-button"], elements["refresh-provider-dialog-button"]];
  buttons.forEach((button) => { button.disabled = true; });
  elements["sync-models-button"].textContent = "正在读取 OpenCode…";
  elements["refresh-provider-dialog-button"].textContent = "刷新中…";
  try {
    await Promise.all([
      loadProviders(false),
      loadPackyProviders(),
      loadAggregatorProviders(),
      loadModelVerifications(),
      loadPackyCatalog(showSuccess),
    ]);
    renderSetup();
    if (showSuccess) await reverifyKnownModels();
    renderProviderManager();
    if (showSuccess) {
      const connected = state.setup.providers.filter((provider) => provider.connected).length;
      const modelCount = state.setup.packyCatalog?.models.length ?? 0;
      showToast(`已刷新供应商与 PackyAPI 目录${modelCount ? `（${modelCount} 个模型）` : ""}，${connected} 个底层渠道已连接`);
    }
  } catch (error) {
    elements["provider-summary"].textContent = "读取 OpenCode 失败";
    if (showSuccess) showToast(`OpenCode 连接失败：${error.message}`);
    throw error;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    elements["sync-models-button"].textContent = "刷新并复测";
    elements["refresh-provider-dialog-button"].textContent = "刷新并复测";
  }
}

async function openProviderDialog() {
  if (!elements["provider-dialog"].open) elements["provider-dialog"].showModal();
  if (state.setup.providersLoaded) renderProviderManager();
  else {
    elements["provider-summary"].textContent = "正在读取 OpenCode…";
    elements["provider-list"].innerHTML = '<div class="empty-state">正在读取 OpenCode 供应商…</div>';
    elements["provider-detail"].innerHTML = '<div class="empty-state">供应商加载后可在这里选择模型。</div>';
  }
  try {
    await refreshProviderCatalog(false);
  } catch {
    elements["provider-list"].innerHTML = '<div class="empty-state">读取失败，请点击“刷新”重试。</div>';
  }
}

async function loadPackyProviders() {
  state.setup.packyProviders = await api("/api/providers/packy");
  resolvePendingPackyModelRoutes();
  renderModelCatalogOptions();
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
  renderProviderManager();
}

async function loadAggregatorProviders() {
  state.setup.aggregatorProviders = await api("/api/providers/aggregators");
  renderModelCatalogOptions();
  renderVerifiedModelPicker();
  renderCredentialSummary();
  updateSetupSummary();
  renderProviderManager();
}

async function loadModelVerifications() {
  state.setup.modelVerifications = await api("/api/models/verifications");
  renderVerifiedModelPicker();
  renderCredentialSummary();
  updateSetupSummary();
}

async function loadPackyCatalog(force = false) {
  try {
    state.setup.packyCatalog = await api(`/api/providers/packy/catalog${force ? "?refresh=1" : ""}`);
    state.setup.packyCatalogError = null;
  } catch (error) {
    state.setup.packyCatalogError = error.message;
  }
  resolvePendingPackyModelRoutes();
  renderModelCatalogOptions();
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
  renderProviderManager();
}

function renderModelCatalogOptions() {
  const options = [];
  const seenPaths = new Set();
  const addOption = (path, label) => {
    if (!path || seenPaths.has(path)) return;
    seenPaths.add(path);
    options.push(`<option value="${escapeHtml(path)}">${escapeHtml(label)}</option>`);
  };

  const packyModels = [...(state.setup.packyCatalog?.models ?? [])].sort((left, right) =>
    Number(right.sourceGeneration) - Number(left.sourceGeneration)
      || left.vendor.localeCompare(right.vendor)
      || left.name.localeCompare(right.name),
  );
  for (const model of packyModels) {
    const route = resolvePackyModelRoute(model.id);
    const group = preferredPackyGroup(model);
    const configuredForModel = getPackyProfileForModel(model.id);
    const configuredGroup = group ? getPackyProviderByGroup(group.id) : null;
    const status = !model.sourceGeneration
      ? "非源码模型"
      : route
        ? "已连接"
        : configuredForModel
          ? configuredForModel.connected ? "等待 OpenCode 同步" : "分组 Key 未生效"
        : group
          ? configuredGroup ? "Key 不含此模型" : `需连接 ${group.name}`
          : "暂无可用分组";
    addOption(
      route?.path ?? `${packyVirtualModelPrefix}${model.id}`,
      `PackyAPI · ${model.vendor || "其他"} · ${model.name} · ${status}`,
    );
  }

  const packyProviderIds = new Set(state.setup.packyProviders.map((provider) => provider.providerId));
  const nativeProviders = state.setup.providers
    .filter((provider) => !packyProviderIds.has(provider.id))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const provider of nativeProviders) {
    const models = provider.models
      .filter((model) => model.toolCall)
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const model of models) {
      addOption(`${provider.id}/${model.id}`, `${provider.name} · ${model.name}`);
    }
  }
  elements["model-catalog-options"].innerHTML = options.join("");
}

function packyModelIdFromPath(path) {
  return path.startsWith(packyVirtualModelPrefix) && path.length > packyVirtualModelPrefix.length
    ? path.slice(packyVirtualModelPrefix.length)
    : null;
}

function getPackyCatalogModel(modelId) {
  return state.setup.packyCatalog?.models.find((model) => model.id === modelId) ?? null;
}

function resolveSelectedModelPath(path) {
  const packyModelId = packyModelIdFromPath(path);
  if (packyModelId === null) return path;
  return resolvePackyModelRoute(packyModelId)?.path ?? path;
}

function resolvePendingPackyModelRoutes() {
  let changed = false;
  for (const model of state.setup.models) {
    const resolvedPath = resolveSelectedModelPath(model.model);
    if (resolvedPath === model.model) continue;
    model.model = resolvedPath;
    changed = true;
  }
  return changed;
}

function renderProviderManager() {
  const packyProviderIds = new Set(state.setup.packyProviders.map((provider) => provider.providerId));
  const aggregatorProviderIds = new Set(
    state.setup.aggregatorProviders.map((provider) => provider.providerId),
  );
  const providers = state.setup.providers
    .filter((provider) => !packyProviderIds.has(provider.id))
    .sort((left, right) =>
      Number(right.connected) - Number(left.connected) || left.name.localeCompare(right.name),
    );
  const packyCatalog = state.setup.packyCatalog;
  const packySourceModels = packyCatalog?.models.filter((model) => model.sourceGeneration).length ?? 0;
  const packyConnected = state.setup.packyProviders.some((provider) => provider.connected);
  const items = [{
    id: packyVirtualProviderId,
    name: "PackyAPI",
    connected: packyConnected,
    virtualPacky: true,
    aggregator: false,
    modelCount: packySourceModels,
  }, ...providers.map((provider) => ({
    ...provider,
    virtualPacky: false,
    aggregator: aggregatorProviderIds.has(provider.id),
    modelCount: provider.models.filter((model) => model.toolCall).length,
  }))];
  const query = elements["provider-search"].value.trim().toLowerCase();
  const filtered = items.filter((provider) => {
    if (!query) return true;
    if (provider.virtualPacky) {
      return "packyapi packy api".includes(query)
        || (packyCatalog?.models.some((model) =>
          model.id.toLowerCase().includes(query)
          || model.vendor.toLowerCase().includes(query)
          || model.groups.some((group) => group.toLowerCase().includes(query)),
        ) ?? false);
    }
    return provider.name.toLowerCase().includes(query)
      || provider.id.toLowerCase().includes(query)
      || provider.models.some((model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query));
  });
  const connected = items.filter((provider) => provider.connected).length;
  elements["provider-summary"].textContent = state.setup.providersLoaded
    ? `${items.length} 个供应商 · ${connected} 个已连接`
    : "尚未读取 OpenCode";

  if (packyProviderIds.has(state.setup.selectedProviderId)) {
    state.setup.selectedProviderId = packyVirtualProviderId;
  }
  if (!items.some((provider) => provider.id === state.setup.selectedProviderId)) {
    state.setup.selectedProviderId = packyVirtualProviderId;
  }
  if (filtered.length > 0 && !filtered.some((provider) => provider.id === state.setup.selectedProviderId)) {
    state.setup.selectedProviderId = filtered[0].id;
  }

  elements["provider-list"].innerHTML = filtered.length ? filtered.map((provider) => {
    return `<button class="provider-catalog-row ${provider.id === state.setup.selectedProviderId ? "selected" : ""}" data-select-provider="${escapeHtml(provider.id)}" type="button">
      <span class="provider-catalog-heading"><strong>${escapeHtml(provider.name)}</strong>${provider.virtualPacky ? '<span class="provider-kind">实时目录</span>' : provider.aggregator ? '<span class="provider-kind">Key 发现</span>' : ""}</span>
      <code>${provider.virtualPacky ? "packyapi.ai" : escapeHtml(provider.id)}</code>
      <span class="provider-catalog-meta"><i class="${provider.connected ? "connected" : ""}"></i>${provider.connected ? "已连接" : "未连接"} · ${provider.modelCount} 个可生成模型</span>
    </button>`;
  }).join("") : '<div class="empty-state">没有匹配的供应商。</div>';
  renderProviderDetail();
}

function renderProviderDetail() {
  if (state.setup.selectedProviderId === packyVirtualProviderId) {
    renderPackyProviderDetail();
    return;
  }
  const provider = getProvider(state.setup.selectedProviderId);
  if (!provider) {
    elements["provider-detail"].innerHTML = '<div class="empty-state">从左侧选择一个供应商。</div>';
    return;
  }
  const query = state.setup.providerModelSearch.toLowerCase();
  const toolModels = provider.models.filter((model) => model.toolCall);
  const models = toolModels.filter((model) => !query
    || model.id.toLowerCase().includes(query)
    || model.name.toLowerCase().includes(query));
  const unsupported = provider.models.length - toolModels.length;
  const aggregator = getAggregatorProvider(provider.id);
  elements["provider-detail"].innerHTML = `
    <header class="provider-detail-heading">
      <div><span class="provider-detail-kicker">${aggregator ? "聚合供应商 · Key 自动发现" : "OpenCode 原生供应商"}</span><h3>${escapeHtml(provider.name)}</h3><code>${escapeHtml(provider.id)}</code></div>
      <div class="provider-detail-actions">
        ${aggregator ? `<button class="button secondary" data-rescan-aggregator="${escapeHtml(provider.id)}" type="button">重新扫描模型</button>` : ""}
        <button class="button ${provider.connected ? "secondary" : "primary"}" data-provider-auth="${escapeHtml(provider.id)}" type="button">${provider.connected ? "管理登录" : "连接 / 登录"}</button>
      </div>
    </header>
    <div class="provider-connection-line ${provider.connected ? "connected" : ""}"><i></i><strong>${provider.connected ? "凭据已连接" : "尚未连接凭据"}</strong><span>${toolModels.length} 个模型支持源码工具${unsupported ? ` · ${unsupported} 个不可用于生成` : ""}${aggregator ? ` · ${escapeHtml(aggregator.baseUrl)}` : ""}</span></div>
    <div class="provider-model-toolbar"><label><span class="visually-hidden">搜索当前供应商模型</span><input data-provider-model-search type="search" value="${escapeHtml(state.setup.providerModelSearch)}" placeholder="搜索 ${escapeHtml(provider.name)} 的模型" autocomplete="off" /></label><span>${models.length} / ${toolModels.length}</span>${aggregator ? `<button class="button secondary" data-add-all-provider="${escapeHtml(provider.id)}" type="button" ${toolModels.length ? "" : "disabled"}>${state.setup.datasetId ? "验证并选择全部" : "验证全部模型"}</button>` : ""}</div>
    <div class="provider-model-list">${models.length ? models.map((model) => {
      const path = `${provider.id}/${model.id}`;
      const added = state.setup.models.some((item) => item.model === path);
      const verified = Boolean(activeVerification(path));
      const efforts = model.reasoningEfforts?.length ? model.reasoningEfforts.join(" · ") : model.reasoning ? "固定推理" : "默认";
      const action = added ? "已选择" : verified ? (state.setup.datasetId ? "选择模型" : "已验证") : (state.setup.datasetId ? "验证并选择" : "验证模型");
      return `<div class="provider-model-row"><div><strong>${escapeHtml(model.name)}</strong><code>${escapeHtml(path)}</code></div><span title="推理强度：${escapeHtml(efforts)}">${escapeHtml(efforts)} · ${verified ? "实测通过" : "等待实测"}</span><button class="button secondary" data-add-provider-model="${escapeHtml(path)}" type="button" ${added || (verified && !state.setup.datasetId) ? "disabled" : ""}>${action}</button></div>`;
    }).join("") : '<div class="empty-state">没有匹配的可生成模型。</div>'}</div>`;
}

function renderPackyProviderDetail() {
  const catalog = state.setup.packyCatalog;
  const profiles = state.setup.packyProviders;
  if (!catalog) {
    elements["provider-detail"].innerHTML = `
      <header class="provider-detail-heading"><div><span class="provider-detail-kicker">独立供应商</span><h3>PackyAPI</h3><code>packyapi.ai</code></div><div class="provider-detail-actions"><button class="button primary" data-refresh-packy type="button">重新读取目录</button></div></header>
      <div class="error-box">${escapeHtml(state.setup.packyCatalogError ?? "正在读取 PackyAPI 官方模型目录…")}</div>`;
    return;
  }

  const query = state.setup.providerModelSearch.toLowerCase();
  const sourceModels = catalog.models.filter((model) => model.sourceGeneration);
  const models = catalog.models.filter((model) => !query
    || model.id.toLowerCase().includes(query)
    || model.vendor.toLowerCase().includes(query)
    || model.groups.some((group) => group.toLowerCase().includes(query)));
  const connectedModels = sourceModels.filter((model) => Boolean(resolvePackyModelRoute(model.id)));
  const connectedProfiles = profiles.filter((profile) => profile.connected).length;
  const profileCards = profiles.length ? profiles.map((profile) => {
    const group = catalog.groups.find((item) => item.id === profile.group);
    return `<div class="packy-profile-card"><div><strong>${escapeHtml(group?.name ?? profile.group ?? profile.name)}</strong><span>${escapeHtml(group?.description ?? profile.providerId)} · ${profile.models.length} 个模型</span></div><i class="${profile.connected ? "connected" : ""}">${profile.connected ? "已连接" : "需更新 Key"}</i><button class="text-button" data-provider-auth="${escapeHtml(profile.providerId)}" type="button">管理 Key</button></div>`;
  }).join("") : '<div class="compact-empty">还没有连接任何分组 Key。模型目录可以浏览，连接分组后即可加入生成任务。</div>';

  elements["provider-detail"].innerHTML = `
    <header class="provider-detail-heading">
      <div><span class="provider-detail-kicker">独立供应商 · 官方实时目录</span><h3>PackyAPI</h3><code>packyapi.ai</code></div>
      <div class="provider-detail-actions"><button class="button secondary" data-refresh-packy type="button">刷新目录</button><button class="button primary" data-connect-packy-group="" type="button">连接分组 Key</button></div>
    </header>
    <div class="provider-connection-line ${connectedProfiles ? "connected" : ""}"><i></i><strong>${connectedProfiles ? `${connectedProfiles} 个分组已连接` : "等待连接分组 Key"}</strong><span>${catalog.models.length} 个全部模型 · ${sourceModels.length} 个适合源码生成 · ${connectedModels.length} 个当前可用</span></div>
    <div class="packy-profile-list">${profileCards}</div>
    <div class="provider-model-toolbar"><label><span class="visually-hidden">搜索 PackyAPI 模型</span><input data-provider-model-search type="search" value="${escapeHtml(state.setup.providerModelSearch)}" placeholder="搜索模型、厂商或分组" autocomplete="off" /></label><span>${models.length} / ${catalog.models.length}</span><button class="button secondary" data-add-all-packy type="button" ${connectedModels.length ? "" : "disabled"}>${state.setup.datasetId ? "验证并选择全部" : "验证全部已接入模型"}</button></div>
    <div class="provider-model-list packy-catalog-models">${models.length ? models.map(renderPackyCatalogModel).join("") : '<div class="empty-state">没有匹配的 PackyAPI 模型。</div>'}</div>
    <p class="packy-catalog-footnote">目录更新于 ${formatDate(catalog.fetchedAt)}。图像、审核等非源码模型仍会展示，但不能加入游戏生成任务。</p>`;
}

function renderPackyCatalogModel(model) {
  const route = resolvePackyModelRoute(model.id);
  const configured = state.setup.packyProviders.find((profile) =>
    profile.models.some((item) => item.id === model.id),
  );
  const preferredGroup = preferredPackyGroup(model);
  const added = route && state.setup.models.some((item) => item.model === route.path);
  const verified = route ? Boolean(activeVerification(route.path)) : false;
  let action;
  if (!model.sourceGeneration) {
    action = '<button class="button secondary" type="button" disabled>非源码模型</button>';
  } else if (route) {
    const label = added ? "已选择" : verified ? (state.setup.datasetId ? "选择模型" : "已验证") : (state.setup.datasetId ? "验证并选择" : "验证模型");
    action = `<button class="button secondary" data-add-packy-model="${escapeHtml(route.path)}" type="button" ${added || (verified && !state.setup.datasetId) ? "disabled" : ""}>${label}</button>`;
  } else if (preferredGroup) {
    action = `<button class="button secondary" data-connect-packy-group="${escapeHtml(preferredGroup.id)}" data-packy-model-id="${escapeHtml(model.id)}" type="button">${configured ? "更新此模型 Key" : "连接此模型"}</button>`;
  } else {
    action = '<button class="button secondary" type="button" disabled>暂无可用分组</button>';
  }
  const profile = getReasoningProfile(`${packyVirtualModelPrefix}${model.id}`);
  const effortText = profile?.reasoningEfforts?.length
    ? profile.reasoningEfforts.join(" · ")
    : profile?.reasoning ? "固定推理" : "供应商默认";
  return `<div class="provider-model-row packy-catalog-model-row"><div><strong>${escapeHtml(model.name)}</strong><code>PackyAPI · ${escapeHtml(model.vendor)}</code></div><span title="分组：${escapeHtml(model.groups.join(", "))}；推理强度：${escapeHtml(effortText)}">${escapeHtml(effortText)}</span>${action}</div>`;
}

function handleProviderListClick(event) {
  const button = event.target.closest("[data-select-provider]");
  if (!button) return;
  state.setup.selectedProviderId = button.dataset.selectProvider;
  state.setup.providerModelSearch = "";
  renderProviderManager();
}

function handleProviderDetailInput(event) {
  if (!event.target.matches("[data-provider-model-search]")) return;
  state.setup.providerModelSearch = event.target.value;
  renderProviderDetail();
  const input = elements["provider-detail"].querySelector("[data-provider-model-search]");
  input?.focus();
  input?.setSelectionRange(state.setup.providerModelSearch.length, state.setup.providerModelSearch.length);
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
    return addAllProviderModels(addAllProviderButton.dataset.addAllProvider);
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
    renderProviderDetail();
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
  renderProviderDetail();
  showToast(`已加入 ${provider.name} · ${model.name}`);
}

function addCatalogModel(provider, model, render = true) {
  const modelPath = `${provider.id}/${model.id}`;
  if (state.setup.models.some((item) => item.model === modelPath)) return false;
  state.setup.models = state.setup.models.filter((item) => item.model.trim());
  state.setup.models.push({
    id: uniqueModelId(model.id),
    model: modelPath,
    enabled: true,
    concurrency: 4,
  });
  scheduleModelDraftSave();
  if (render) {
    renderModels();
    renderProviderLimits();
    updateSetupSummary();
  }
  return true;
}

async function addAllProviderModels(providerId, announce = true) {
  const provider = getProvider(providerId);
  if (!provider) return { added: 0, remaining: 0, total: 0 };
  const toolModels = provider.models.filter((item) => item.toolCall);
  const paths = toolModels.map((model) => `${provider.id}/${model.id}`);
  const missing = paths.filter((modelPath) => !activeVerification(modelPath));
  if (missing.length > 0) {
    if (announce) showToast(`正在端到端验证 ${missing.length} 个 ${provider.name} 模型…`);
    await verifyModelPaths(missing, true);
  }
  if (!state.setup.datasetId) {
    if (announce) showToast("模型验证完成，请继续导入并选择题库");
    return { added: 0, remaining: toolModels.length, total: toolModels.length };
  }
  const initialCount = state.setup.models.filter((model) => model.model.trim()).length;
  if (initialCount >= 100) {
    if (announce) showToast("单次任务最多选择 100 个模型");
    return { added: 0, remaining: toolModels.length, total: toolModels.length };
  }
  let added = 0;
  for (const model of toolModels) {
    if (!activeVerification(`${provider.id}/${model.id}`)) continue;
    if (addCatalogModel(provider, model, false)) added += 1;
    if (initialCount + added >= 100) break;
  }
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
  renderProviderDetail();
  const remaining = provider.models.filter((model) => model.toolCall
    && !state.setup.models.some((item) => item.model === `${provider.id}/${model.id}`)).length;
  if (announce) {
    showToast(added
      ? `已加入 ${added} 个 ${provider.name} 模型${remaining ? "；单次任务最多选择 100 个" : ""}`
      : "该供应商的模型都已在任务列表中");
  }
  return { added, remaining, total: toolModels.length };
}

function openAggregatorDialog(providerId = null) {
  const aggregator = providerId ? getAggregatorProvider(providerId) : null;
  if (providerId && !aggregator) return showToast("找不到该聚合供应商配置");
  elements["aggregator-dialog-title"].textContent = aggregator
    ? `重新扫描 ${aggregator.name}`
    : "根据 Key 自动发现模型";
  elements["aggregator-provider-name"].value = aggregator?.name ?? "";
  elements["aggregator-provider-id"].value = aggregator?.providerId ?? "";
  elements["aggregator-provider-id"].readOnly = Boolean(aggregator);
  elements["aggregator-base-url"].value = aggregator?.baseUrl ?? "";
  elements["aggregator-api-key"].value = "";
  setAggregatorDialogFeedback();
  elements["aggregator-dialog"].showModal();
}

async function saveAggregatorProvider() {
  const name = elements["aggregator-provider-name"].value.trim();
  const providerId = elements["aggregator-provider-id"].value.trim();
  const baseUrl = elements["aggregator-base-url"].value.trim();
  const apiKey = elements["aggregator-api-key"].value.trim();
  if (providerId && (!validIdentifier(providerId) || !providerId.startsWith("aggregate-"))) {
    return showToast("Provider ID 必须以 aggregate- 开头，且只能使用字母、数字、点、下划线和短横线");
  }
  if (!baseUrl) return showToast("请输入聚合供应商的 API Base URL");
  if (!apiKey) return showToast("请输入该聚合供应商的 API Key");

  const button = elements["connect-aggregator-button"];
  button.disabled = true;
  button.textContent = "正在读取目录并逐个实测模型…";
  setAggregatorDialogFeedback(
    "正在读取 /models，并以最多 4 路并发对每个模型执行真实工具调用。只有调用成功的模型才会进入后续可选模型池，请稍候…",
    "pending",
  );
  try {
    const configured = await api("/api/providers/aggregators/connect", {
      method: "POST",
      body: JSON.stringify({
        baseUrl,
        apiKey,
        ...(name ? { name } : {}),
        ...(providerId ? { providerId } : {}),
      }),
    });
    await Promise.all([loadProviders(false), loadAggregatorProviders(), loadModelVerifications()]);
    const probePaths = configured.models
      .filter((model) => model.toolCall)
      .map((model) => `${configured.providerId}/${model.id}`);
    setAggregatorDialogFeedback(
      `API 直连筛选完成，正在通过 OpenCode 正式链路复核 ${probePaths.length} 个候选模型…`,
      "pending",
    );
    button.textContent = `正在端到端复核 ${probePaths.length} 个模型…`;
    const probeResults = await verifyModelPaths(probePaths, true);
    const readyCount = probeResults.filter((result) => result.ready).length;
    if (readyCount === 0) {
      throw new Error("供应商配置已保存，但没有模型通过 OpenCode 端到端工具调用验证；请查看供应商模型并逐个重试");
    }
    state.setup.selectedProviderId = configured.providerId;
    state.setup.providerModelSearch = "";
    renderProviderManager();
    renderVerifiedModelPicker();
    updateSetupSummary();
    elements["aggregator-dialog"].close();
    const discoveredCount = configured.discoveredModelCount ?? configured.models.length;
    const rejectedCount = configured.rejectedModelCount
      ?? Math.max(0, discoveredCount - configured.models.length);
    const validationText = rejectedCount
      ? `，${rejectedCount} 个调用失败已过滤`
      : "";
    showToast(`${configured.name} 已连接：目录 ${discoveredCount} 个，API 候选 ${configured.models.length} 个，端到端可用 ${readyCount} 个${validationText}；现在可以导入题库`);
  } catch (error) {
    setAggregatorDialogFeedback(error.message, "error");
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "验证 API 并导入可选模型";
  }
}

function resetAggregatorDialog() {
  for (const id of [
    "aggregator-provider-name",
    "aggregator-provider-id",
    "aggregator-base-url",
    "aggregator-api-key",
  ]) elements[id].value = "";
  elements["aggregator-provider-id"].readOnly = false;
  elements["aggregator-api-key"].type = "password";
  elements["toggle-aggregator-key-button"].textContent = "显示";
  setAggregatorDialogFeedback();
}

function setAggregatorDialogFeedback(message = "", tone = "") {
  const feedback = elements["aggregator-dialog-feedback"];
  feedback.textContent = message;
  feedback.className = `packy-dialog-feedback${tone ? ` ${tone}` : ""}${message ? "" : " hidden"}`;
}

function toggleAggregatorKeyVisibility() {
  const input = elements["aggregator-api-key"];
  input.type = input.type === "password" ? "text" : "password";
  elements["toggle-aggregator-key-button"].textContent = input.type === "password" ? "显示" : "隐藏";
}

function openPackyDialog(groupId = null, targetModelId = null) {
  const catalog = state.setup.packyCatalog;
  if (!catalog) return showToast("PackyAPI 模型目录尚未加载，请先刷新");
  const targetModel = targetModelId ? getPackyCatalogModel(targetModelId) : null;
  if (targetModelId && !targetModel) return showToast(`PackyAPI 当前目录中找不到 ${targetModelId}`);
  const groups = catalog.groups.filter((group) => group.sourceModelCount > 0
    && group.defaultProtocol
    && (!targetModel || (targetModel.groups.includes(group.id) && targetModel.protocols.includes(group.defaultProtocol))));
  if (groups.length === 0) return showToast("PackyAPI 当前没有可接入的源码模型分组");
  state.setup.packyTargetModelId = targetModel?.id ?? null;
  elements["packy-group"].innerHTML = groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)} · ${group.sourceModelCount} 个模型</option>`).join("");
  const configuredForTarget = targetModel ? getPackyProfileForModel(targetModel.id) : null;
  const selectedGroup = groups.find((group) => group.id === groupId)
    ?? groups.find((group) => group.id === configuredForTarget?.group)
    ?? groups.find((group) => !getPackyProviderByGroup(group.id))
    ?? groups[0];
  elements["packy-group"].value = selectedGroup.id;
  elements["packy-api-key"].value = "";
  elements["packy-target-model"].classList.toggle("hidden", !targetModel);
  elements["packy-target-model"].textContent = targetModel
    ? `本次必须接入：${targetModel.name}。Key 权限检查未通过时不会显示为可用。`
    : "";
  setPackyDialogFeedback();
  updatePackyGroupPreview();
  elements["packy-dialog"].showModal();
}

function updatePackyGroupPreview() {
  const catalog = state.setup.packyCatalog;
  const group = catalog?.groups.find((item) => item.id === elements["packy-group"].value);
  if (!catalog || !group) return;
  const targetModel = state.setup.packyTargetModelId ? getPackyCatalogModel(state.setup.packyTargetModelId) : null;
  const models = catalog.models.filter((model) => model.sourceGeneration
    && model.groups.includes(group.id)
    && model.protocols.includes(group.defaultProtocol))
    .sort((left, right) => Number(right.id === targetModel?.id) - Number(left.id === targetModel?.id));
  const existing = targetModel ? getPackyProfileForModel(targetModel.id) ?? getPackyProviderByGroup(group.id) : getPackyProviderByGroup(group.id);
  const protocolLabel = { openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini" }[group.defaultProtocol] ?? group.defaultProtocol;
  elements["packy-dialog-title"].textContent = targetModel
    ? `${existing ? "更新" : "接入"} ${targetModel.name}`
    : existing ? `更新 ${group.name} 分组` : `连接 ${group.name} 分组`;
  elements["packy-dialog-subtitle"].textContent = targetModel
    ? "平台会检查这把 Key 是否包含目标模型；计费分组以你为这把 Key 选择的分组为准。"
    : existing ? "保存新 Key 后会同步该分组当前全部模型。" : "保存后仍统一显示在 PackyAPI 供应商下。";
  elements["packy-group-hint"].textContent = `${group.description}。平台将使用 ${protocolLabel} 协议；模型可用性无法证明 Key 的计费分组，请确认这里选择的就是创建该 Key 时的分组。`;
  elements["packy-model-preview"].innerHTML = `<div><strong>Key 校验通过后最多同步 ${models.length} 个游戏生成模型</strong><span>${models.slice(0, 10).map((model) => `<code>${escapeHtml(model.id)}</code>`).join("")}${models.length > 10 ? `<em>另有 ${models.length - 10} 个</em>` : ""}</span></div>`;
  elements["save-packy-button"].textContent = targetModel
    ? `验证 Key 并接入 ${targetModel.name}`
    : existing ? "更新 Key 并重新同步模型" : "连接分组并同步全部模型";
}

async function savePackyProvider() {
  const group = elements["packy-group"].value;
  const apiKey = elements["packy-api-key"].value.trim();
  const targetModelId = state.setup.packyTargetModelId;
  if (!group) return showToast("请选择 PackyAPI 模型分组");
  if (!apiKey) return showToast("请输入 PackyAPI Key");

  const button = elements["save-packy-button"];
  button.disabled = true;
  button.textContent = targetModelId ? `正在验证 ${targetModelId} 权限…` : "正在连接并同步模型…";
  setPackyDialogFeedback(
    targetModelId
      ? `正在通过 PackyAPI /v1/models 检查这把 Key 是否包含 ${targetModelId}…`
      : "正在检查 Key 权限并同步模型…",
    "pending",
  );
  try {
    const configured = await api("/api/providers/packy/connect", {
      method: "POST",
      body: JSON.stringify({ group, apiKey, ...(targetModelId ? { targetModelId } : {}) }),
    });
    await refreshPackyConnectionState(targetModelId);
    const route = targetModelId ? resolvePackyModelRoute(targetModelId) : null;
    if (targetModelId && !route) {
      const profile = getPackyProfileForModel(targetModelId);
      throw new Error(profile
        ? `${targetModelId} 已通过 Key 权限检查，但 OpenCode 尚未加载该模型路径。配置已保留，请稍后点击“刷新并复测”。`
        : `${targetModelId} 权限检查通过，但模型配置没有同步到 OpenCode。`);
    }
    elements["packy-api-key"].value = "";
    state.setup.selectedProviderId = packyVirtualProviderId;
    state.setup.providerModelSearch = "";
    renderProviderManager();
    if (targetModelId && route) {
      setPackyDialogFeedback(`Key 权限通过，正在通过 OpenCode 正式链路验证 ${targetModelId}…`, "pending");
      button.textContent = `正在端到端验证 ${targetModelId}…`;
      if (!await ensureModelVerified(route.path)) {
        throw new Error(`${targetModelId} 已接入，但没有通过 OpenCode 端到端工具调用验证`);
      }
    }
    elements["packy-dialog"].close();
    showToast(targetModelId
      ? `${targetModelId} 已通过 Key 权限和 OpenCode 端到端验证`
      : `${configured.name} 已连接，${configured.models.length} 个模型等待逐个实测`);
  } catch (error) {
    setPackyDialogFeedback(error.message, "error");
    showToast(error.message);
  } finally {
    button.disabled = false;
    updatePackyGroupPreview();
  }
}

async function refreshPackyConnectionState(targetModelId) {
  const attempts = targetModelId ? 5 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await Promise.all([loadProviders(false), loadPackyProviders()]);
    if (!targetModelId || resolvePackyModelRoute(targetModelId)) return;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

function setPackyDialogFeedback(message = "", tone = "") {
  const feedback = elements["packy-dialog-feedback"];
  feedback.textContent = message;
  feedback.className = `packy-dialog-feedback${tone ? ` ${tone}` : ""}${message ? "" : " hidden"}`;
}

async function refreshPackyCatalogFromDetail() {
  await loadPackyCatalog(true);
  renderProviderManager();
  showToast(state.setup.packyCatalogError
    ? `PackyAPI 目录刷新失败：${state.setup.packyCatalogError}`
    : `PackyAPI 目录已刷新，共 ${state.setup.packyCatalog.models.length} 个模型`);
}

async function addAllConnectedPackyModels() {
  const catalog = state.setup.packyCatalog;
  if (!catalog) return;
  const paths = catalog.models.filter((model) => model.sourceGeneration)
    .map((model) => resolvePackyModelRoute(model.id)?.path)
    .filter(Boolean);
  const missing = paths.filter((modelPath) => !activeVerification(modelPath));
  if (missing.length > 0) {
    showToast(`正在端到端验证 ${missing.length} 个 PackyAPI 模型…`);
    await verifyModelPaths(missing, true);
  }
  if (!state.setup.datasetId) return showToast("模型验证完成，请继续导入并选择题库");
  let added = 0;
  for (const catalogModel of catalog.models.filter((model) => model.sourceGeneration)) {
    const route = resolvePackyModelRoute(catalogModel.id);
    if (!route) continue;
    const provider = getProvider(route.providerId);
    const model = provider?.models.find((item) => item.id === catalogModel.id);
    if (provider && model && activeVerification(route.path) && addCatalogModel(provider, model, false)) added += 1;
  }
  renderModels();
  renderProviderLimits();
  updateSetupSummary();
  renderProviderDetail();
  showToast(added ? `已加入 ${added} 个 PackyAPI 模型` : "所有已接入模型都在任务列表中");
}

function resolvePackyModelRoute(modelId) {
  const profiles = state.setup.packyProviders
    .filter((profile) => profile.connected && profile.models.some((model) => model.id === modelId))
    .sort((left, right) => Number(Boolean(right.group)) - Number(Boolean(left.group)));
  for (const profile of profiles) {
    const provider = getProvider(profile.providerId);
    const model = provider?.models.find((item) => item.id === modelId && item.toolCall);
    if (provider?.connected && model) {
      return { providerId: provider.id, path: `${provider.id}/${modelId}` };
    }
  }
  return null;
}

function preferredPackyGroup(model) {
  const groups = state.setup.packyCatalog?.groups ?? [];
  return model.groups
    .map((groupId) => groups.find((group) => group.id === groupId))
    .find((group) => group?.sourceModelCount > 0 && group.defaultProtocol) ?? null;
}

function getPackyProviderByGroup(groupId) {
  return state.setup.packyProviders.find((provider) =>
    provider.group === groupId || provider.providerId === `packy-${groupId}`,
  );
}

function getPackyProfileForModel(modelId) {
  return state.setup.packyProviders.find((provider) =>
    provider.models.some((model) => model.id === modelId),
  );
}

function automaticModelId(modelPath, currentModel) {
  const slash = modelPath.indexOf("/");
  if (slash <= 0 || slash === modelPath.length - 1) return "";
  return uniqueModelId(modelPath.slice(slash + 1), currentModel);
}

function uniqueModelId(value, currentModel = null) {
  let base = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 120) || "packy-model";
  let candidate = base;
  let suffix = 2;
  while (state.setup.models.some((model) => model !== currentModel && model.id === candidate)) {
    const tail = `-${suffix++}`;
    candidate = `${base.slice(0, 120 - tail.length)}${tail}`;
  }
  return candidate;
}

function togglePackyKeyVisibility() {
  const input = elements["packy-api-key"];
  input.type = input.type === "password" ? "text" : "password";
  elements["toggle-packy-key-button"].textContent = input.type === "password" ? "显示" : "隐藏";
}

function renderCredentialSummary() {
  const verifiedModels = verifiedModelOptions();
  const verifiedProviders = new Set(verifiedModels.map((option) => option.provider.id));
  const summary = elements["credential-summary"];
  const mockMode = elements["mock-mode"].checked;
  summary.classList.toggle("ready", mockMode || verifiedModels.length > 0);
  if (mockMode) summary.querySelector("span").textContent = "流程演练模式，不调用真实模型";
  else if (!state.setup.providersLoaded) summary.querySelector("span").textContent = "尚未检查本机模型与登录状态";
  else if (verifiedModels.length > 0) {
    summary.querySelector("span").textContent = `${verifiedProviders.size} 个供应商 · ${verifiedModels.length} 个模型已通过真实调用验证`;
  } else if (state.setup.aggregatorProviders.length > 0) {
    summary.querySelector("span").textContent = "已保存聚合 API，但当前没有通过真实调用验证的模型";
  } else summary.querySelector("span").textContent = "尚未填写 API 并验证模型";
}

function renderProviderLimits() {
  const providers = enabledProviderIds();
  const globalConcurrency = clampInteger(elements["global-concurrency"].value, 1, 1000, 16);
  for (const providerId of providers) {
    if (!state.setup.providerLimits[providerId]) {
      const modelCapacity = state.setup.models
        .filter((model) => model.enabled && providerFromModel(model.model) === providerId)
        .reduce((total, model) => total + model.concurrency, 0);
      state.setup.providerLimits[providerId] = Math.max(1, Math.min(globalConcurrency, modelCapacity || globalConcurrency));
    }
  }
  elements["provider-limits"].innerHTML = providers.length ? providers.map((providerId) => `
    <label class="provider-limit"><span title="${escapeHtml(providerId)}">${escapeHtml(getProvider(providerId)?.name ?? providerId)}</span><input data-provider-limit="${escapeHtml(providerId)}" type="number" min="1" max="1000" value="${state.setup.providerLimits[providerId]}" /></label>
  `).join("") : '<div class="empty-state">启用并填写模型后自动显示供应商。</div>';
}

function balanceProviderConcurrency() {
  const providers = enabledProviderIds();
  if (providers.length === 0) return;
  const globalConcurrency = clampInteger(elements["global-concurrency"].value, 1, 1000, 16);
  const base = Math.max(1, Math.floor(globalConcurrency / providers.length));
  let remainder = Math.max(0, globalConcurrency - base * providers.length);
  for (const providerId of providers) {
    state.setup.providerLimits[providerId] = base + (remainder-- > 0 ? 1 : 0);
  }
  renderProviderLimits();
  updateSetupSummary();
}

async function openCredentialDialog(providerId) {
  state.setup.credentialProviderId = providerId;
  state.setup.oauth = null;
  elements["api-key-input"].value = "";
  renderCredentialDialog();
  elements["credential-dialog"].showModal();
  if (!state.setup.providersLoaded) {
    try {
      await loadProviders(false);
    } catch {
      renderCredentialDialog();
    }
  }
}

function renderCredentialDialog() {
  const providerId = state.setup.credentialProviderId;
  const provider = getProvider(providerId);
  elements["credential-title"].textContent = provider?.name ?? providerId ?? "连接供应商";
  elements["credential-subtitle"].textContent = providerId ? `Provider ID: ${providerId}` : "凭据由 OpenCode 保存在本机。";
  elements["credential-current"].innerHTML = provider?.connected
    ? '<span class="status-pill status-running">已连接</span> OpenCode 已识别该供应商的本地凭据。'
    : '<span class="status-pill status-pending">未连接</span> 保存 API Key 或完成 OAuth 登录后再同步状态。';
  const oauthMethods = provider?.authMethods.filter((method) => method.type === "oauth") ?? [];
  elements["oauth-section"].classList.toggle("hidden", oauthMethods.length === 0);
  elements["oauth-methods"].innerHTML = oauthMethods.map((method) => `<button class="oauth-method" data-oauth-method="${method.index}" type="button">${escapeHtml(method.label)}</button>`).join("");
  elements["oauth-completion"].classList.toggle("hidden", !state.setup.oauth);
  if (state.setup.oauth) {
    elements["oauth-instructions"].textContent = state.setup.oauth.instructions || "请在新窗口完成授权，然后返回这里确认。";
    elements["oauth-code-field"].classList.toggle("hidden", state.setup.oauth.method !== "code");
  }
}

async function saveApiKey() {
  const providerId = state.setup.credentialProviderId;
  const key = elements["api-key-input"].value.trim();
  if (!providerId || !key) return showToast("请输入 API Key");
  const button = elements["save-api-key-button"];
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    await api("/api/auth/api-key", { method: "POST", body: JSON.stringify({ providerId, key }) });
    elements["api-key-input"].value = "";
    await loadProviders(false);
    renderCredentialDialog();
    showToast(`${providerId} 凭据已保存到 OpenCode`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "保存到 OpenCode";
  }
}

function toggleApiKeyVisibility() {
  const input = elements["api-key-input"];
  input.type = input.type === "password" ? "text" : "password";
  elements["toggle-key-button"].textContent = input.type === "password" ? "显示" : "隐藏";
}

async function startOAuth(event) {
  const button = event.target.closest("[data-oauth-method]");
  if (!button || !state.setup.credentialProviderId) return;
  const popup = window.open("about:blank", "opencode-auth", "width=760,height=780");
  button.disabled = true;
  try {
    const method = Number(button.dataset.oauthMethod);
    const authorization = await api("/api/auth/oauth/start", {
      method: "POST",
      body: JSON.stringify({ providerId: state.setup.credentialProviderId, method }),
    });
    state.setup.oauth = { ...authorization, index: method };
    if (popup) popup.location.href = authorization.url;
    else window.open(authorization.url, "_blank", "noopener");
    renderCredentialDialog();
  } catch (error) {
    popup?.close();
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function completeOAuth() {
  const providerId = state.setup.credentialProviderId;
  const oauth = state.setup.oauth;
  if (!providerId || !oauth) return;
  const code = elements["oauth-code-input"].value.trim();
  if (oauth.method === "code" && !code) return showToast("请输入授权码");
  try {
    await api("/api/auth/oauth/complete", {
      method: "POST",
      body: JSON.stringify({ providerId, method: oauth.index, ...(code ? { code } : {}) }),
    });
    state.setup.oauth = null;
    await loadProviders(false);
    renderCredentialDialog();
    showToast(`${providerId} 登录完成`);
  } catch (error) {
    showToast(error.message);
  }
}

function updateSetupSummary() {
  renderDatasetAvailability();
  const selectedDataset = state.setup.datasets.find((dataset) => dataset.id === state.setup.datasetId);
  const verifiedModels = verifiedModelOptions();
  const enabledModels = state.setup.models.filter((model) => model.enabled);
  const validModels = enabledModels.filter((model) => validIdentifier(model.id) && /^[^/]+\/.+/.test(model.model));
  const uniqueIds = new Set(validModels.map((model) => model.id));
  const modelSyntaxValid = enabledModels.length > 0 && validModels.length === enabledModels.length && uniqueIds.size === enabledModels.length;
  const mockMode = elements["mock-mode"].checked;
  const accessChecks = enabledModels.map((model) => getModelAccess(model));
  const modelAccessReady = enabledModels.length > 0
    && (mockMode || (state.setup.providersLoaded && accessChecks.every((check) => check.ready)));
  const modelConfigurationValid = modelSyntaxValid && modelAccessReady;
  const stagedMode = elements["staged-mode"].checked;
  const globalConcurrency = clampInteger(elements["global-concurrency"].value, 1, 1000, 16);
  const policyValid = ["global-concurrency", "max-attempts", "round-timeout", "round-idle-timeout", "retry-backoff"].every((id) => Number(elements[id].value) >= Number(elements[id].min));
  const activeExperiment = state.setup.activeExperimentId;
  const ready = Boolean(selectedDataset && modelConfigurationValid && policyValid && state.setup.outputDir && !activeExperiment && elements["new-experiment-name"].value.trim());

  setStepState(
    elements["provider-step-state"],
    mockMode ? "演练模式" : verifiedModels.length ? `${verifiedModels.length} 个实测可用` : "未验证",
    mockMode || verifiedModels.length ? "ready" : "pending",
  );
  const datasetStepAvailable = mockMode || verifiedModels.length > 0;
  setStepState(
    elements["dataset-step-state"],
    datasetStepAvailable ? (selectedDataset ? `${selectedDataset.taskCount} 道题` : "未选择") : "等待第一步",
    datasetStepAvailable && selectedDataset ? "ready" : "pending",
  );
  setStepState(elements["model-step-state"], enabledModels.length ? `已选 ${enabledModels.length} 个` : "未选择", modelConfigurationValid ? "ready" : modelSyntaxValid ? "warning" : "pending");
  setStepState(elements["policy-step-state"], policyValid ? (stagedMode ? "分阶段" : "一次完成") : "请检查", policyValid ? "ready" : "warning");
  elements["launch-task-count"].textContent = (selectedDataset?.taskCount ?? 0).toLocaleString();
  elements["launch-model-count"].textContent = enabledModels.length.toLocaleString();
  elements["launch-run-count"].textContent = ((selectedDataset?.taskCount ?? 0) * enabledModels.length).toLocaleString();
  elements["launch-concurrency"].textContent = globalConcurrency.toLocaleString();
  elements["matrix-formula"].textContent = `${(selectedDataset?.taskCount ?? 0).toLocaleString()} 道题 × ${enabledModels.length} 个模型`;
  elements["launch-output-dir"].textContent = state.setup.outputDir || "未配置";

  const checklist = [
    mockMode
      ? { state: "ok", text: "流程演练模式：跳过真实 API 调用" }
      : verifiedModels.length
        ? { state: "ok", text: `${verifiedModels.length} 个模型已通过真实工具调用验证` }
        : { state: "bad", text: "请填写供应商 API，并至少验证出 1 个可调用模型" },
    { state: selectedDataset ? "ok" : "bad", text: selectedDataset ? `题库已校验：${selectedDataset.name}` : "请导入并选择一个题库" },
    { state: modelSyntaxValid ? "ok" : "bad", text: modelSyntaxValid ? `当前题库已选择 ${enabledModels.length} 个模型` : "请为题库选择至少 1 个模型，且显示名称需唯一" },
    modelAccessReady
      ? { state: "ok", text: `${enabledModels.length} 个已选模型均可用于本次运行` }
      : { state: state.setup.providersLoaded ? "bad" : "warn", text: state.setup.providersLoaded ? "已选模型中仍有模型未经实测、不可用或尚未登录" : "请先刷新并复测" },
    { state: policyValid ? "ok" : "bad", text: `全局并发 ${globalConcurrency}，最多尝试 ${elements["max-attempts"].value} 次；${roundTimeoutDescription()}` },
    { state: "ok", text: stagedMode ? "分阶段生成：首次只跑第 1 轮，后续由监控页手动推进" : "一次性生成：每个游戏将连续执行全部 Prompt" },
    { state: state.setup.outputDir ? "ok" : "bad", text: state.setup.outputDir ? `源码将保存到：${state.setup.outputDir}` : "源码保存目录未配置" },
  ];
  if (activeExperiment) checklist.push({ state: "bad", text: "当前已有任务运行；完成或取消后可新建" });
  elements["launch-checklist"].innerHTML = checklist.map((item) => `<div class="check-item ${item.state}"><i>${item.state === "ok" ? "✓" : item.state === "warn" ? "!" : "×"}</i><span>${escapeHtml(item.text)}</span></div>`).join("");
  elements["start-generation-button"].disabled = !ready;
  elements["start-generation-subtitle"].textContent = stagedMode
    ? "先生成第 1 阶段，后续手动续跑"
    : "连续执行每个游戏的全部 Prompt";
  elements["open-active-button"].classList.toggle("hidden", !activeExperiment);
  elements["setup-readiness"].className = `readiness-pill ${ready ? "ready" : "blocked"}`;
  elements["setup-readiness"].querySelector("span").textContent = ready ? "配置完成，可以启动" : activeExperiment ? "已有任务正在运行" : "还需要完成配置";
  renderCredentialSummary();
}

function setStepState(element, text, className) {
  element.textContent = text;
  element.className = `step-state ${className}`;
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

async function loadExperiments() {
  state.experiments = await api("/api/experiments");
  const active = state.experiments.find((item) => ["queued", "running", "paused"].includes(item.status));
  state.setup.activeExperimentId = active?.id ?? null;
  renderExperimentSelect();
  renderActiveBadge();
  updateSetupSummary();
}

function renderExperimentSelect() {
  elements["experiment-picker"].classList.toggle("hidden", state.view !== "monitor" || state.experiments.length === 0);
  elements["experiment-select"].innerHTML = state.experiments.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${statusLabels[item.status] ?? item.status} · ${formatDate(item.createdAt)}</option>`).join("");
  if (state.experimentId) elements["experiment-select"].value = state.experimentId;
}

function renderActiveBadge() {
  const active = state.experiments.find((item) => ["queued", "running", "paused"].includes(item.status));
  elements["active-run-badge"].classList.toggle("hidden", !active);
  elements["active-run-badge"].textContent = active ? String(active.summary?.running + active.summary?.preparing || 1) : "";
}

async function selectExperiment(experimentId, updateHistory = true) {
  if (!experimentId) return renderMonitorEmpty();
  state.source?.close();
  state.source = null;
  state.events = [];
  state.experimentId = experimentId;
  state.runPage = { page: 1, pageSize: 50, totalTasks: 0, totalPages: 0, hasNextPage: false };
  state.matrixRenderKey = "";
  state.activityRenderKey = null;
  elements["experiment-select"].value = experimentId;
  await refreshExperiment(true);
  connectEventStream();
  if (updateHistory) updateLocation();
}

async function refreshExperiment(showError) {
  if (!state.experimentId) return;
  const experimentId = state.experimentId;
  const requestId = ++state.refreshRequestId;
  state.refreshController?.abort();
  const controller = new AbortController();
  state.refreshController = controller;
  try {
    const query = new URLSearchParams({
      page: String(state.runPage.page),
      pageSize: String(state.runPage.pageSize),
    });
    const search = elements["task-search"].value.trim();
    const status = elements["status-filter"].value;
    if (search) query.set("search", search);
    if (status) query.set("status", status);
    const data = await api(`/api/experiments/${encodeURIComponent(experimentId)}?${query}`, { signal: controller.signal });
    if (requestId !== state.refreshRequestId || experimentId !== state.experimentId) return;
    state.experiment = data.experiment;
    state.summary = data.summary;
    state.roundSummary = data.roundSummary;
    state.runs = data.runs;
    state.modelSummaries = data.modelSummaries ?? [];
    state.runPage = data.runPage ?? {
      page: 1,
      pageSize: Math.max(data.runs.length, 1),
      totalTasks: new Set(data.runs.map((run) => run.taskId)).size,
      totalPages: 1,
      hasNextPage: false,
    };
    if (state.events.length === 0) state.events = data.events ?? [];
    renderMonitor();
    if (state.selectedRunId) void loadRunDetail(state.selectedRunId, false);
    if (["awaiting_stage", "completed", "failed", "cancelled"].includes(data.experiment.status) && state.setup.activeExperimentId === data.experiment.id) {
      state.setup.activeExperimentId = null;
      await loadExperiments();
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    if (showError) showToast(error.message);
  } finally {
    if (state.refreshController === controller) state.refreshController = null;
  }
}

function renderMonitor() {
  if (!state.experiment) return renderMonitorEmpty();
  elements["monitor-empty"].classList.add("hidden");
  elements["monitor-content"].classList.remove("hidden");
  renderHeader();
  renderSummary();
  renderProgress();
  renderStageControl();
  renderModelProgress();
  renderMatrix();
  renderActivity();
}

function renderMonitorEmpty() {
  elements["monitor-empty"].classList.remove("hidden");
  elements["monitor-content"].classList.add("hidden");
  elements["experiment-name"].textContent = "暂无生成任务";
  elements["experiment-meta"].textContent = "先上传题库、连接模型并启动生成。";
  elements["monitor-output-dir"].textContent = "尚未创建";
  elements["monitor-manifest-path"].textContent = "任务完成后会生成 manifest.json 结果清单。";
  elements["copy-monitor-output"].disabled = true;
}

function renderHeader() {
  const experiment = state.experiment;
  elements["experiment-name"].textContent = experiment.name;
  elements["monitor-output-dir"].textContent = experiment.outputDir ?? "尚未创建";
  elements["monitor-manifest-path"].textContent = experiment.manifestPath
    ? `整批结果清单：${experiment.manifestPath}`
    : "任务完成后会生成 manifest.json 结果清单。";
  elements["copy-monitor-output"].disabled = !experiment.outputDir;
  updateElapsedLabels();
  setStatusPill(elements["experiment-status"], experiment.status);
  const terminal = ["completed", "failed", "cancelled"].includes(experiment.status);
  const waitingForStage = experiment.status === "awaiting_stage";
  elements["pause-button"].disabled = experiment.status !== "running";
  elements["resume-button"].disabled = experiment.status !== "paused";
  elements["cancel-button"].disabled = terminal || waitingForStage;
}

function renderSummary() {
  const summary = state.summary;
  if (!summary) return;
  const stageCompletedLabel = state.experiment?.status === "cancelled" ? "取消前完成" : "本阶段完成";
  const cards = [
    ["总运行", summary.total, "题目 × 模型", ""],
    ["运行中", summary.running + summary.preparing, `${summary.queued} 个排队`, "accent"],
    [stageCompletedLabel, summary.awaitingStage, state.experiment?.status === "cancelled" ? "已完成轮次仍被保留" : "等待下一阶段", ""],
    ["全部完成", summary.completed, `${percentage(summary.completed, summary.total)}%`, ""],
    ["等待续跑", summary.retrying, "保留产物，暂不占用并发", ""],
    ["失败", summary.failed, "达到最大重试", summary.failed ? "alert" : ""],
    ["已取消", summary.cancelled, "未完成运行", summary.cancelled ? "cancelled" : ""],
  ];
  elements["summary-cards"].innerHTML = cards.map(([label, value, note, className]) => `<article class="summary-card ${className}"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");
}

function renderProgress() {
  const summary = state.summary;
  if (!summary) return;
  if (state.experiment?.stageMode === "manual" && state.roundSummary) {
    const rounds = state.roundSummary;
    const done = rounds.completed + rounds.failed;
    const reachableTotal = rounds.reachableTotal
      ?? rounds.currentStageTotal
      ?? Math.min(rounds.total, (summary.total ?? 0) * Math.max(state.experiment.targetRound, 1));
    const value = percentage(done, reachableTotal);
    elements["progress-number"].textContent = `${value}%`;
    elements["progress-bar"].style.width = `${value}%`;
    elements["progress-caption"].innerHTML = `<span>${rounds.completed} / ${reachableTotal} 个当前可达轮次已完成</span><span>当前开放到第 ${state.experiment.targetRound} / ${state.experiment.maxRounds} 阶段 · 全部 ${rounds.total} 轮</span>`;
    return;
  }
  const done = summary.completed + summary.failed + summary.cancelled;
  const value = percentage(done, summary.total);
  elements["progress-number"].textContent = `${value}%`;
  elements["progress-bar"].style.width = `${value}%`;
  elements["progress-caption"].innerHTML = `<span>${done} / ${summary.total} 个运行进入终态</span><span>${summary.running + summary.preparing} 个并发执行</span>`;
}

function renderStageControl() {
  const experiment = state.experiment;
  const manual = experiment?.stageMode === "manual";
  elements["stage-control"].classList.toggle("hidden", !manual);
  if (!manual) return;
  const current = experiment.targetRound;
  const maximum = experiment.maxRounds;
  const waiting = experiment.status === "awaiting_stage" && current < maximum;
  const finished = experiment.status === "completed" || current >= maximum && experiment.status === "awaiting_stage";
  elements["stage-control-progress"].textContent = `${Math.min(current, maximum)} / ${maximum}`;
  if (finished) {
    elements["stage-control-title"].textContent = "全部阶段已完成";
    elements["stage-control-description"].textContent = `所有 ${maximum} 个阶段均已生成并保存。`;
    elements["advance-stage-button"].textContent = "全部阶段已完成";
  } else if (waiting) {
    elements["stage-control-title"].textContent = `第 ${current} 阶段已完成`;
    elements["stage-control-description"].textContent = `整批题目与模型均已完成第 ${current} 轮，现在可以启动第 ${current + 1} 轮。`;
    elements["advance-stage-button"].textContent = `开始第 ${current + 1} 阶段`;
  } else {
    elements["stage-control-title"].textContent = `正在生成第 ${current} 阶段`;
    elements["stage-control-description"].textContent = `当前只执行第 ${current} 轮 Prompt；完成前不会自动进入下一轮。`;
    elements["advance-stage-button"].textContent = "等待本阶段完成";
  }
  elements["stage-context-note"].textContent = "下一阶段会沿用每个运行相同的源码目录、OpenCode sessionId 和全部历史上下文。";
  elements["advance-stage-button"].disabled = !waiting;
}

function renderModelProgress() {
  const stageLabel = state.experiment?.status === "cancelled" ? "取消前完成" : "本阶段完成";
  elements["model-list"].innerHTML = state.modelSummaries.map((item) => {
    const progress = percentage(item.completedRounds, item.totalRounds);
    const model = state.experiment?.settings.models.find((setting) => setting.id === item.modelId);
    const effort = model?.reasoningEffort ? ` · 推理 ${model.reasoningEffort}` : " · 推理使用默认值";
    return `<article class="model-card"><header><div class="model-name"><strong title="${escapeHtml(item.modelId)}">${escapeHtml(item.modelId)}</strong><span>${escapeHtml(item.providerId + effort)}</span></div><span class="model-percent">${progress}%</span></header><div class="mini-track"><i style="width:${progress}%"></i></div><div class="model-stats"><span>${item.awaitingStage} ${stageLabel}</span><span>${item.completed} 全部完成</span><span>${item.running + item.preparing} 运行</span><span>${item.retrying} 等待续跑</span><span class="bad">${item.failed} 失败</span><span>${item.cancelled} 取消</span></div></article>`;
  }).join("");
}

function renderMatrix() {
  const table = elements["run-matrix"];
  const models = state.experiment?.settings.models.filter((model) => model.enabled).map((model) => model.id)
    ?? [...new Set(state.runs.map((run) => run.modelId))];
  const taskGroups = new Map();
  for (const run of state.runs) {
    if (!taskGroups.has(run.taskId)) taskGroups.set(run.taskId, { id: run.taskId, title: run.taskTitle, runs: new Map() });
    taskGroups.get(run.taskId).runs.set(run.modelId, run);
  }
  const tasks = [...taskGroups.values()];
  const renderKey = [
    state.runPage.page,
    state.runPage.pageSize,
    state.runPage.totalTasks,
    models.join(","),
    ...state.runs.map((run) => [run.id, run.status, run.currentRound, run.completedRounds, run.updatedAt].join(":")),
  ].join("|");
  if (renderKey !== state.matrixRenderKey) {
    state.matrixRenderKey = renderKey;
    table.querySelector("thead").innerHTML = `<tr><th>题目</th>${models.map((model) => `<th title="${escapeHtml(model)}">${escapeHtml(model)}</th>`).join("")}</tr>`;
    table.querySelector("tbody").innerHTML = tasks.map((task) => `<tr><td><strong title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</strong><span>${escapeHtml(task.id)}</span></td>${models.map((model) => renderRunCell(task.runs.get(model))).join("")}</tr>`).join("");
  }
  elements["matrix-empty"].classList.toggle("hidden", tasks.length > 0);
  elements["matrix-pagination"].classList.toggle("hidden", state.runPage.totalTasks === 0);
  elements["previous-page"].disabled = state.runPage.page <= 1;
  elements["load-more"].disabled = !state.runPage.hasNextPage;
  elements["page-summary"].textContent = `第 ${state.runPage.page} / ${Math.max(state.runPage.totalPages, 1)} 页 · 共 ${state.runPage.totalTasks.toLocaleString()} 道题`;
}

function renderRunCell(run) {
  if (!run) return "<td>—</td>";
  const completedRounds = Math.min(run.completedRounds ?? 0, run.totalRounds);
  const cancelledBeforeStart = run.status === "cancelled" && completedRounds === 0 && !run.startedAt;
  const displayStatus = run.status === "awaiting_stage" && state.experiment?.status === "cancelled"
    ? "取消前已完成"
    : statusLabels[run.status] ?? run.status;
  const detail = run.status === "running" || run.status === "preparing"
    ? `已完成 ${completedRounds} / ${run.totalRounds} · 正在第 ${Math.max(run.currentRound, 1)} 轮`
    : run.status === "retrying" ? `已完成 ${completedRounds} / ${run.totalRounds} · 已保留产物，等待续跑`
    : run.status === "queued" ? "尚未开始"
    : cancelledBeforeStart ? "未开始即取消"
    : `实际完成 ${completedRounds} / ${run.totalRounds} 轮`;
  return `<td><button class="run-cell status-${run.status}" data-run-id="${escapeHtml(run.id)}"><strong>${escapeHtml(displayStatus)}</strong><span>${detail}</span></button></td>`;
}

function renderActivity() {
  const renderKey = state.events.map((event) => `${event.id}:${event.createdAt}`).join("|");
  if (renderKey === state.activityRenderKey) return;
  state.activityRenderKey = renderKey;
  const activity = summarizeActivityEvents(state.events);
  const visible = activity.slice(-80).reverse();
  elements["event-count"].textContent = String(activity.length);
  elements["activity-list"].innerHTML = visible.length ? visible.map((event) => `<article class="activity-item ${event.level}"><p>${escapeHtml(event.message)}</p><span>${formatTime(event.createdAt)} · ${escapeHtml(event.label)}</span></article>`).join("") : '<div class="empty-state">等待关键生成动态…</div>';
}

function summarizeActivityEvents(events) {
  const activity = [];
  const groupedPositions = new Map();
  for (const event of events) {
    const normalized = normalizeActivityEvent(event);
    if (!normalized) continue;
    const timeBucket = Math.floor(normalized.createdAt / 5_000);
    const groupKey = `${normalized.type}:${normalized.level}:${normalized.message}:${timeBucket}`;
    if (groupedPositions.has(groupKey)) {
      const position = groupedPositions.get(groupKey);
      const previous = activity[position];
      activity[position] = {
        ...previous,
        createdAt: Math.max(previous.createdAt, normalized.createdAt),
        count: previous.count + 1,
      };
    } else {
      groupedPositions.set(groupKey, activity.length);
      activity.push({ ...normalized, count: 1 });
    }
  }
  return activity.map((event) => ({
    ...event,
    message: event.count > 1 ? `${event.message} × ${event.count}` : event.message,
  }));
}

function normalizeActivityEvent(event) {
  if (event.level === "debug" || event.type === "harness.todo.updated" || event.type.startsWith("round.context.")) return null;
  if (event.type.startsWith("harness.tool.")) {
    const status = event.type.slice("harness.tool.".length);
    if (!["completed", "error"].includes(status)) return null;
    const tool = typeof event.data?.tool === "string" ? event.data.tool : "模型工具";
    const failed = status === "error";
    return {
      ...event,
      label: failed ? "工具执行失败" : "工具执行完成",
      level: failed ? "error" : "info",
      message: `${tool} ${failed ? "执行失败" : "执行完成"}`,
    };
  }
  const hidden = new Set([
    "harness.workspace.released",
    "harness.session.created",
    "harness.session.resumed",
    "harness.prompt.accepted",
  ]);
  if (hidden.has(event.type)) return null;
  const label = event.type.startsWith("experiment.") ? "批量任务"
    : event.type.startsWith("run.") ? "单项运行"
    : event.type.startsWith("round.") ? "生成轮次"
    : event.type.startsWith("harness.file.") ? "文件变更"
    : event.type.startsWith("harness.") ? "模型执行"
    : "生成动态";
  return { ...event, label };
}

async function openRun(runId) {
  state.selectedRunId = runId;
  elements["run-drawer"].classList.add("open");
  elements["run-drawer"].setAttribute("aria-hidden", "false");
  elements["drawer-content"].innerHTML = '<div class="empty-state">正在加载运行详情…</div>';
  await loadRunDetail(runId, true);
}

async function loadRunDetail(runId, showError) {
  try {
    const detail = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (state.selectedRunId !== runId) return;
    renderRunDetail(detail);
  } catch (error) {
    if (showError) showToast(error.message);
  }
}

function renderRunDetail({ run, rounds, events, eventPage, resultPath, roundContextDirectory }) {
  elements["drawer-title"].textContent = `${run.taskTitle} · ${run.modelId}`;
  const canPreview = Boolean(run.workspacePath);
  const canRetry = ["failed", "cancelled"].includes(run.status);
  const completedRounds = rounds.filter((round) => round.status === "completed").length;
  const runStatusLabel = run.status === "awaiting_stage" && state.experiment?.status === "cancelled"
    ? "取消前已完成当前阶段"
    : statusLabels[run.status] ?? run.status;
  const modelSetting = state.experiment?.settings.models.find((model) => model.id === run.modelId);
  const previewAction = canPreview
    ? `<a id="preview-run" class="button primary" href="/artifacts/${encodeURIComponent(run.id)}/" target="_blank" rel="noopener noreferrer">进入游戏</a>`
    : '<button id="preview-run" class="button primary" disabled>打开游戏</button>';
  const logTitle = eventPage?.hasMore
    ? `最近技术日志 · ${events.length} 条（更早记录未展示）`
    : `技术日志 · ${events.length} 条`;
  const roundCards = rounds.map((round) => `<details class="round-card">
    <summary><span>第 ${round.roundIndex + 1} 轮 · ${escapeHtml(round.roundId)}</span><span class="status-pill status-${round.status}">${statusLabels[round.status] ?? round.status}</span></summary>
    <div class="round-context-file"><span>本轮完整上下文</span><code>${escapeHtml(round.contextPath ?? "源码目录创建后生成")}</code><button class="text-button" data-copy-round-context="${round.roundIndex}" ${round.contextPath ? "" : "disabled"}>复制路径</button></div>
    <pre>${escapeHtml(round.prompt)}${round.response ? `\n\n--- 模型响应 ---\n${escapeHtml(round.response)}` : ""}</pre>
  </details>`).join("");
  elements["drawer-content"].innerHTML = `<div class="detail-hero">
    <span class="status-pill status-${run.status}">${escapeHtml(runStatusLabel)}</span>
    <div class="detail-row"><span>模型</span><code>${escapeHtml(`${run.providerId}/${run.modelName}`)}</code></div>
    <div class="detail-row"><span>推理强度</span><code>${escapeHtml(modelSetting?.reasoningEffort ?? "供应商默认")}</code></div>
    <div class="detail-row"><span>实际完成轮次</span><code>${completedRounds} / ${run.totalRounds}</code></div>
    <div class="detail-row"><span>当前/最后进入轮次</span><code>${run.currentRound || "—"}</code></div>
    <div class="detail-row"><span>尝试</span><code>${run.attempt} / ${run.maxAttempts}</code></div>
    <div class="detail-row"><span>同一多轮会话</span><code>${escapeHtml(run.sessionId ?? "—")}</code></div>
    <div class="detail-row"><span>本次源码目录</span><code>${escapeHtml(run.workspacePath ?? "尚未创建")}</code></div>
    <div class="detail-row"><span>本次结果清单</span><code>${escapeHtml(resultPath ?? "生成结束后写入")}</code></div>
    <div class="detail-row"><span>逐轮上下文目录</span><code>${escapeHtml(roundContextDirectory ?? "源码目录创建后生成")}</code></div>
    ${run.error ? `<div class="error-box">${escapeHtml(run.error)}</div>` : ""}
    <div class="detail-actions">${previewAction}<button id="copy-path" class="button secondary" ${canPreview ? "" : "disabled"}>复制源码目录</button><button id="copy-context-dir" class="button secondary" ${roundContextDirectory ? "" : "disabled"}>复制上下文目录</button><button id="retry-run" class="button secondary" ${canRetry ? "" : "disabled"}>重新运行</button></div>
  </div>
  <section class="drawer-section"><h3>多轮 Prompt 与上下文（严格按顺序执行）</h3><p class="round-context-note">所有轮次始终修改同一份游戏源码；这里分别保存的只是每轮上下文 JSON，不会复制游戏目录。每轮结束后会补全历史对话、响应、Token 和 OpenCode Session 快照。</p>${roundCards}</section>
  <section class="drawer-section"><details class="technical-log"><summary>${logTitle}</summary><p class="technical-log-note">按时间倒序展示最近最多 ${eventPage?.limit ?? 1000} 条底层状态、工具调用和诊断信息；监控页“实时动态”只展示归类后的关键事件。${eventPage?.hasMore ? " 该运行还有更早日志，未在本页加载。" : ""}</p><div class="event-log">${events.slice().reverse().map((event) => `<div class="event-row"><time>${formatTime(event.createdAt)}</time><div><p>${escapeHtml(event.message)}</p><small>${escapeHtml(event.type)}</small></div></div>`).join("") || '<div class="empty-state">暂无日志</div>'}</div></details></section>`;
  document.getElementById("copy-path")?.addEventListener("click", () => copyPath(run.workspacePath, "本次源码目录已复制"));
  document.getElementById("copy-context-dir")?.addEventListener("click", () => copyPath(roundContextDirectory, "逐轮上下文目录已复制"));
  document.getElementById("retry-run")?.addEventListener("click", () => retryRun(run.id));
  document.querySelectorAll("[data-copy-round-context]").forEach((button) => {
    button.addEventListener("click", () => {
      const round = rounds.find((item) => String(item.roundIndex) === button.dataset.copyRoundContext);
      if (round?.contextPath) void copyPath(round.contextPath, `第 ${round.roundIndex + 1} 轮上下文路径已复制`);
    });
  });
}

function closeDrawer() {
  state.selectedRunId = null;
  elements["run-drawer"].classList.remove("open");
  elements["run-drawer"].setAttribute("aria-hidden", "true");
}

async function retryRun(runId) {
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}/retry`, { method: "POST" });
    showToast("运行已重新入队");
    await refreshExperiment(false);
  } catch (error) {
    showToast(error.message);
  }
}

async function advanceStage() {
  const experiment = state.experiment;
  if (!experiment || experiment.status !== "awaiting_stage") return;
  const nextStage = experiment.targetRound + 1;
  const totalRuns = state.summary?.total ?? 0;
  if (!confirm(`即将为 ${totalRuns.toLocaleString()} 个“题目 × 模型”运行启动第 ${nextStage} 阶段。\n\n每个运行会继续使用原来的源码目录、OpenCode 会话和前 ${experiment.targetRound} 轮上下文，并可能产生新的 API 费用。确定继续吗？`)) return;
  const button = elements["advance-stage-button"];
  button.disabled = true;
  button.textContent = `正在启动第 ${nextStage} 阶段…`;
  try {
    await api(`/api/experiments/${encodeURIComponent(experiment.id)}/advance-stage`, { method: "POST" });
    state.setup.activeExperimentId = experiment.id;
    await loadExperiments();
    await refreshExperiment(false);
    showToast(`第 ${nextStage} 阶段已启动，将继续使用上一阶段上下文`);
  } catch (error) {
    showToast(error.message);
    renderStageControl();
  }
}

async function performAction(action) {
  if (!state.experimentId) return;
  if (action === "cancel" && !confirm("确定取消整个生成任务吗？正在运行的模型会被中止，已经生成的源码仍会保留。")) return;
  try {
    await api(`/api/experiments/${encodeURIComponent(state.experimentId)}/${action}`, { method: "POST" });
    await refreshExperiment(false);
    await loadExperiments();
  } catch (error) {
    showToast(error.message);
  }
}

function connectEventStream() {
  state.source?.close();
  const afterId = state.events.reduce((maximum, event) => Math.max(maximum, Number(event.id) || 0), 0);
  const source = new EventSource(`/api/stream?experimentId=${encodeURIComponent(state.experimentId)}&afterId=${afterId}`);
  state.source = source;
  source.onopen = () => setConnection("online", "实时连接");
  source.onerror = () => setConnection("offline", "正在重连");
  source.addEventListener("generation", (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    mergeGenerationEvent(event);
    scheduleActivityRender();
    scheduleRefresh();
    if (state.selectedRunId && event.runId === state.selectedRunId) void loadRunDetail(state.selectedRunId, false);
  });
}

function scheduleActivityRender() {
  if (state.activityRenderTimer) return;
  state.activityRenderTimer = setTimeout(() => {
    state.activityRenderTimer = null;
    if (state.view !== "monitor") return;
    const renderKey = state.events.map((event) => `${event.id}:${event.createdAt}`).join("|");
    if (renderKey !== state.activityRenderKey) renderActivity();
  }, 750);
}

function mergeGenerationEvent(event) {
  if (!event || !Number.isSafeInteger(event.id)) return;
  const existing = state.events.findIndex((item) => item.id === event.id);
  if (existing >= 0) state.events[existing] = event;
  else state.events.push(event);
  state.events.sort((left, right) => left.id - right.id);
  if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    void refreshExperiment(false);
  }, 3_000);
}

function updateElapsedLabels() {
  const experiment = state.experiment;
  if (!experiment || state.view !== "monitor") return;
  const start = experiment.startedAt ?? experiment.createdAt;
  const end = experiment.completedAt ?? Date.now();
  const concurrency = experiment.settings?.globalConcurrency;
  const stage = experiment.stageMode === "manual"
    ? ` · 阶段 ${Math.min(experiment.targetRound, experiment.maxRounds)} / ${experiment.maxRounds}`
    : "";
  elements["experiment-meta"].textContent = `任务 ${formatShortId(experiment.id)} · ${state.summary?.total ?? 0} 个生成运行${stage}${concurrency ? ` · 并发上限 ${concurrency}` : ""} · 已用时 ${formatDuration(end - start)}`;
}

function updateLocation() {
  const query = new URLSearchParams();
  query.set("view", state.view);
  if (state.view === "monitor" && state.experimentId) query.set("experiment", state.experimentId);
  history.replaceState(null, "", `?${query.toString()}`);
}

function setStatusPill(element, status) {
  element.className = `status-pill status-${status}`;
  element.textContent = statusLabels[status] ?? status;
}

function setConnection(className, text) {
  elements.connection.className = `connection ${className}`;
  elements.connection.innerHTML = `<i></i>${text}`;
}

function enabledProviderIds() {
  return [...new Set(state.setup.models.filter((model) => model.enabled).map((model) => providerFromModel(model.model)).filter(Boolean))];
}

function providerFromModel(model) {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "";
}

function getProvider(providerId) {
  return state.setup.providers.find((provider) => provider.id === providerId);
}

function getPackyProvider(providerId) {
  return state.setup.packyProviders.find((provider) => provider.providerId === providerId);
}

function getAggregatorProvider(providerId) {
  return state.setup.aggregatorProviders.find(
    (provider) => provider.providerId === providerId,
  );
}

function validIdentifier(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value);
}

async function copyPath(value, successMessage) {
  if (!value) return showToast("目录尚未创建");
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  showToast(successMessage);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (isWriteMethod(options.method) && state.csrfToken) headers["X-GameBench-CSRF"] = state.csrfToken;
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`);
  return body;
}

function uploadJson(url, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("Content-Type", "application/json");
    if (state.csrfToken) request.setRequestHeader("X-GameBench-CSRF", state.csrfToken);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      let body = {};
      try { body = JSON.parse(request.responseText); } catch {}
      if (request.status >= 200 && request.status < 300) resolve(body);
      else reject(new Error(body.error ?? `上传失败 (${request.status})`));
    };
    request.onerror = () => reject(new Error("上传连接中断"));
    request.send(JSON.stringify(payload));
  });
}

let toastTimer;
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3600);
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function timeoutMinutesToMs(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round(minutes * 60_000);
}

function roundTimeoutDescription() {
  const hardMinutes = Number(elements["round-timeout"].value) || 0;
  const idleMinutes = Number(elements["round-idle-timeout"].value) || 0;
  const hard = hardMinutes > 0 ? `每轮最长 ${hardMinutes} 分钟` : "每轮不设硬时限";
  const idle = idleMinutes > 0 ? `连续 ${idleMinutes} 分钟无模型事件则中止` : "不设空闲时限";
  return `${hard}，${idle}`;
}

function isWriteMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method ?? "GET").toUpperCase());
}

function percentage(value, total) { return total ? Math.round((value / total) * 100) : 0; }
function formatShortId(id) { return id ? id.slice(0, 8) : "—"; }
function formatTime(timestamp) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp); }
function formatDate(timestamp) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(timestamp); }
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}时 ${minutes}分` : minutes ? `${minutes}分 ${rest}秒` : `${rest}秒`;
}
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
