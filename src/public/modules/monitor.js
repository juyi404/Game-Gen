import { escapeHtml, formatDate, percentage, formatTime, formatShortId, formatDuration } from "./format.js";
import { statusLabels } from "./state.js";

/** Dependencies are supplied by app.js; feature modules never import one another. */
export function createMonitor({ state, api, updateSetupSummary, elements, updateLocation, showToast, setStatusPill, copyPath, setConnection }) {
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
    elements["result-model-filter"].innerHTML = '<option value="">全部模型</option>';
    delete elements["result-model-filter"].dataset.optionsKey;
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
      const modelId = elements["result-model-filter"].value;
      if (search) query.set("search", search);
      if (status) query.set("status", status);
      if (modelId) query.set("modelId", modelId);
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
    const availableModels = state.experiment?.settings.models.filter((model) => model.enabled).map((model) => model.id)
      ?? [...new Set(state.runs.map((run) => run.modelId))];
    const picker = elements["result-model-filter"];
    const selectedModel = availableModels.includes(picker.value) ? picker.value : "";
    const optionsKey = JSON.stringify(availableModels);
    if (picker.dataset.optionsKey !== optionsKey) {
      picker.innerHTML = '<option value="">全部模型</option>' + availableModels.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("");
      picker.dataset.optionsKey = optionsKey;
    }
    picker.value = selectedModel;
    const models = selectedModel ? [selectedModel] : availableModels;
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

  return { loadExperiments, selectExperiment, refreshExperiment, renderMonitorEmpty, openRun, closeDrawer, advanceStage, performAction, updateElapsedLabels };
}
