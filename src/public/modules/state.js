export const packyVirtualProviderId = "__packyapi__";

export const packyVirtualModelPrefix = "packyapi/";

export const statusLabels = {
  queued: "排队中", preparing: "准备中", running: "运行中", retrying: "等待续跑",
  awaiting_stage: "本阶段已完成", completed: "全部完成", failed: "失败", cancelled: "已取消", paused: "已暂停",
  pending: "等待中",
};

const defaultModels = [];

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
  "result-model-filter", "status-filter", "run-matrix", "matrix-empty", "matrix-pagination", "previous-page", "page-summary", "load-more", "pause-button", "resume-button",
  "cancel-button", "run-drawer", "drawer-backdrop", "drawer-close", "drawer-title", "drawer-content",
  "credential-dialog", "credential-title", "credential-subtitle", "credential-current", "api-key-input",
  "toggle-key-button", "save-api-key-button", "oauth-section", "oauth-methods", "oauth-completion",
  "oauth-instructions", "oauth-code-field", "oauth-code-input", "complete-oauth-button", "toast",
];

export function createState() {
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
  return state;
}

export function createContext() {
  const elements = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));
  return { state: createState(), elements };
}
