import { createSetupSelectors } from "./setup-selectors.js";
import { formatBytes, escapeHtml, formatDate } from "./format.js";

/** Owns this view; shared reads and mutations use setup selectors, data and store. */
export function createDatasets({ state, elements, store, api, uploadJson, showToast }) {
  const { verifiedModelOptions } = createSetupSelectors(state);
  async function loadSetup() {
    const setup = await api("/api/setup");
    state.csrfToken = setup.csrfToken ?? "";
    store.restore(setup);
    state.setup.activeExperimentId = setup.activeExperimentId;
    state.setup.outputDir = setup.outputDir ?? "";
    elements["launch-output-dir"].textContent = state.setup.outputDir || "未配置";
    elements["copy-launch-output"].disabled = !state.setup.outputDir;
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
      store.importDataset(dataset);
      clearStagedFiles();
      renderDatasets();
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

  function selectDataset(datasetId) {
    if (!canUseDatasetStep()) return showToast("请先完成第一步，至少验证一个可调用模型");
    store.selectDataset(datasetId);
    renderDatasets();
  }

  function canUseDatasetStep() { return elements["mock-mode"].checked || verifiedModelOptions().length > 0; }

  return { loadSetup, stageFiles, clearStagedFiles, uploadDataset, renderDatasets, renderDatasetAvailability, selectDataset };
}
