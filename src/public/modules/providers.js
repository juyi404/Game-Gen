import { createSetupSelectors } from "./setup-selectors.js";
import { escapeHtml, formatDate } from "./format.js";
import { packyVirtualModelPrefix, packyVirtualProviderId } from "./state.js";

/** Owns this view; shared reads and mutations use setup selectors, data and store. */
export function createProviders({ state, elements, store, showToast, data }) {
  const { getProvider, getAggregatorProvider, activeVerification, getReasoningProfile, resolvePackyModelRoute, preferredPackyGroup, getPackyProviderByGroup, getPackyProfileForModel } = createSetupSelectors(state);
  const { loadProviders, loadPackyProviders, loadAggregatorProviders, loadModelVerifications, loadPackyCatalog, verifyModelPaths, addCatalogModel } = data;

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
      store.selectProvider(packyVirtualProviderId);
    }
    if (!items.some((provider) => provider.id === state.setup.selectedProviderId)) {
      store.selectProvider(packyVirtualProviderId);
    }
    if (filtered.length > 0 && !filtered.some((provider) => provider.id === state.setup.selectedProviderId)) {
      store.selectProvider(filtered[0].id);
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
    store.selectProvider(button.dataset.selectProvider);
    store.setProviderSearch("");
    renderProviderManager();
  }

  function handleProviderDetailInput(event) {
    if (!event.target.matches("[data-provider-model-search]")) return;
    store.setProviderSearch(event.target.value);
    renderProviderDetail();
    const input = elements["provider-detail"].querySelector("[data-provider-model-search]");
    input?.focus();
    input?.setSelectionRange(state.setup.providerModelSearch.length, state.setup.providerModelSearch.length);
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

  return { refreshProviderCatalog, openProviderDialog, renderModelCatalogOptions, renderProviderManager, renderProviderDetail, handleProviderListClick, handleProviderDetailInput, addAllProviderModels };
}
