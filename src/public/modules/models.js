import { createSetupSelectors } from "./setup-selectors.js";
import { clampInteger, escapeHtml, providerFromModel, validIdentifier } from "./format.js";

/** Owns this view; shared reads and mutations use setup selectors, data and store. */
export function createModels({ state, elements, store, showToast, data }) {
  const { enabledProviderIds, getProvider, getPackyProvider, activeVerification, verifiedModelOptions, getReasoningProfile, packyModelIdFromPath, getPackyCatalogModel, resolveSelectedModelPath, preferredPackyGroup, getPackyProviderByGroup, getPackyProfileForModel, automaticModelId } = createSetupSelectors(state);
  const { addCatalogModel } = data;

  function canUseDatasetStep() {
    return elements["mock-mode"].checked || verifiedModelOptions().length > 0;
  }

  function addModel() {
    if (!state.setup.datasetId) return showToast("请先导入并选择题库，再添加运行模型");
    if (!elements["mock-mode"].checked) return showToast("真实任务只能选择已完成实际调用验证的模型；手动模型仅用于演练模式");
    if (!store.addModel({ id: "", model: "", enabled: true, concurrency: 2 })) return showToast("单次任务最多选择 100 个模型");
    renderModels();
    renderProviderLimits();
    updateSetupSummary();
    queueMicrotask(() => elements["model-rows"].querySelector("tr:last-child .model-path-input")?.focus());
  }

  function handleModelInput(event) {
    const row = event.target.closest("[data-model-index]");
    if (!row) return;
    const currentModel = state.setup.models[Number(row.dataset.modelIndex)];
    if (!currentModel) return;
    const model = { ...currentModel };
    const field = event.target.dataset.field;
    if (field === "enabled") model.enabled = event.target.checked;
    if (field === "id") model.id = event.target.value;
    if (field === "model") {
      model.model = resolveSelectedModelPath(event.target.value.trim());
      const automaticId = automaticModelId(model.model, currentModel);
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
    store.updateModel(Number(row.dataset.modelIndex), model);
    if (["enabled", "model", "reasoningEffort", "concurrency"].includes(field)) {
      renderProviderLimits();
      renderCredentialSummary();
    }
    updateSetupSummary();
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
    store.replaceModels(state.setup.models.filter((model) => model.model !== option.path));
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
    store.replaceModels([]);
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

  function refreshModelAccess() {
    for (const row of elements["model-rows"].querySelectorAll("[data-model-index]")) {
      const model = state.setup.models[Number(row.dataset.modelIndex)];
      const access = row.querySelector("[data-model-access]");
      if (model && access) access.innerHTML = renderModelAccess(model);
    }
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
    if (!activeVerification(model.model, model.reasoningEffort)) {
      return { ready: true, tone: "warning", label: "档位待实测", message: "模型已验证；启动时将实测当前推理档位，通过后才会创建任务" };
    }
    return { ready: true, tone: "ready", label: "端到端可用", message: "该模型当前推理档位已通过 OpenCode 正式链路工具调用验证" };
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

  function updateSetupSummary() {
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

  function roundTimeoutDescription() {
    const hardMinutes = Number(elements["round-timeout"].value) || 0;
    const idleMinutes = Number(elements["round-idle-timeout"].value) || 0;
    const hard = hardMinutes > 0 ? `每轮最长 ${hardMinutes} 分钟` : "每轮不设硬时限";
    const idle = idleMinutes > 0 ? `连续 ${idleMinutes} 分钟无模型事件则中止` : "不设空闲时限";
    return `${hard}，${idle}`;
  }

  return { canUseDatasetStep, addModel, handleModelInput, renderVerifiedModelPicker, handleVerifiedModelSelection, selectAllVerifiedModels, clearSelectedModels, renderModels, refreshModelAccess, renderCredentialSummary, renderProviderLimits, balanceProviderConcurrency, updateSetupSummary, roundTimeoutDescription };
}
