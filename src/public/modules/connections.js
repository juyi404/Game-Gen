import { createSetupSelectors } from "./setup-selectors.js";
import { validIdentifier, escapeHtml } from "./format.js";
import { packyVirtualProviderId } from "./state.js";

/** Owns this view; shared reads and mutations use setup selectors, data and store. */
export function createConnections({ state, elements, store, api, showToast, data }) {
  const { getProvider, getAggregatorProvider, activeVerification, getPackyCatalogModel, resolvePackyModelRoute, getPackyProviderByGroup, getPackyProfileForModel } = createSetupSelectors(state);
  const { loadProviders, loadPackyProviders, loadAggregatorProviders, loadModelVerifications, loadPackyCatalog, verifyModelPaths, ensureModelVerified, addCatalogModel } = data;
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
      store.selectProvider(configured.providerId);
      store.setProviderSearch("");
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
      store.selectProvider(packyVirtualProviderId);
      store.setProviderSearch("");
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
    showToast(added ? `已加入 ${added} 个 PackyAPI 模型` : "所有已接入模型都在任务列表中");
  }

  function togglePackyKeyVisibility() {
    const input = elements["packy-api-key"];
    input.type = input.type === "password" ? "text" : "password";
    elements["toggle-packy-key-button"].textContent = input.type === "password" ? "显示" : "隐藏";
  }

  return { openAggregatorDialog, saveAggregatorProvider, resetAggregatorDialog, toggleAggregatorKeyVisibility, openPackyDialog, updatePackyGroupPreview, savePackyProvider, setPackyDialogFeedback, refreshPackyCatalogFromDetail, addAllConnectedPackyModels, togglePackyKeyVisibility };
}
