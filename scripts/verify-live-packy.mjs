import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.env.GAMEBENCH_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDirectory = path.resolve(
  process.env.GAMEBENCH_VERIFY_DIR ?? path.join(".gamebench", "verification", runStamp),
);
const reportPath = path.join(reportDirectory, "live-packy-report.json");
const startedAt = Date.now();
const report = {
  schemaVersion: 1,
  type: "gamebench-live-packy-verification",
  startedAt: new Date(startedAt).toISOString(),
  baseUrl,
  status: "running",
  checks: [],
};

try {
  await mkdir(reportDirectory, { recursive: true });
  const health = await api("/api/health");
  assert(health.ok === true, "操作台健康检查未通过");
  record("dashboard.health", { ok: true });

  const setup = await api("/api/setup");
  assert(typeof setup.outputDir === "string" && setup.outputDir.length > 0, "源码输出目录未配置");
  record("dashboard.setup", { outputDir: setup.outputDir });

  const catalog = await api("/api/providers/packy/catalog?refresh=1");
  const sourceModels = catalog.models.filter((model) => model.sourceGeneration);
  assert(catalog.models.length > 0, "PackyAPI 实时目录为空");
  assert(sourceModels.length > 0, "PackyAPI 目录中没有源码生成模型");
  assert(catalog.groups.length > 0, "PackyAPI 分组目录为空");
  record("packy.catalog", {
    models: catalog.models.length,
    sourceModels: sourceModels.length,
    groups: catalog.groups.length,
    vendors: catalog.vendors.length,
  });

  if (process.env.PACKY_API_KEY) {
    const group = process.env.PACKY_GROUP ?? "codex";
    await api("/api/providers/packy/connect", {
      method: "POST",
      body: { group, apiKey: process.env.PACKY_API_KEY },
    });
    record("packy.credential", { connectedGroup: group, source: "environment" });
  }

  const [packyProfiles, providers] = await Promise.all([
    api("/api/providers/packy"),
    api("/api/providers"),
  ]);
  const profile = packyProfiles.find((candidate) =>
    candidate.connected
      && candidate.models.some((model) => model.id === "gpt-5.6-sol"),
  );
  assert(profile, "没有已连接且包含 gpt-5.6-sol 的 PackyAPI 分组");
  const provider = providers.find((candidate) => candidate.id === profile.providerId);
  assert(provider?.connected, `OpenCode 中的 ${profile.providerId} 尚未连接`);

  const desiredModels = [
    { id: "sol-xhigh", modelId: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    { id: "terra-high", modelId: "gpt-5.6-terra", reasoningEffort: "high" },
    { id: "luna-low", modelId: "gpt-5.6-luna", reasoningEffort: "low" },
    { id: "sol-max", modelId: "gpt-5.6-sol", reasoningEffort: "max" },
  ];
  const allModelSettings = desiredModels.map((setting) => {
    const model = provider.models.find((candidate) => candidate.id === setting.modelId);
    assert(model?.toolCall, `${profile.providerId}/${setting.modelId} 不支持源码工具调用`);
    assert(
      model.reasoningEfforts.includes(setting.reasoningEffort),
      `${setting.modelId} 未返回推理档位 ${setting.reasoningEffort}`,
    );
    return {
      id: `verify-${setting.id}`,
      model: `${profile.providerId}/${setting.modelId}`,
      enabled: true,
      concurrency: 2,
      reasoningEffort: setting.reasoningEffort,
    };
  });
  const modelSettings = allModelSettings.filter((model) => model.reasoningEffort !== "max");
  const maxSetting = allModelSettings.find((model) => model.reasoningEffort === "max");
  assert(maxSetting, "缺少 max 推理档位配置");
  record("packy.model-variants", {
    providerId: profile.providerId,
    models: allModelSettings.map(({ id, model, reasoningEffort }) => ({ id, model, reasoningEffort })),
  });

  const validation = await api("/api/models/validate", {
    method: "POST",
    body: { models: allModelSettings },
  });
  assert(validation.checks.length === allModelSettings.length, "模型接入检查数量不完整");
  assert(validation.checks.every((check) => check.ready), `模型接入检查失败: ${formatChecks(validation.checks)}`);
  record("models.validation", { checks: validation.checks });

  const verificationId = `live-${Date.now()}`;
  const tasks = [1, 2].map((number) => createTask(verificationId, number));
  const dataset = await api("/api/datasets/import", {
    method: "POST",
    body: {
      name: `自动验收题库 ${verificationId}`,
      files: tasks.map((task) => ({
        path: `${task.id}.json`,
        content: JSON.stringify(task),
      })),
    },
  });
  assert(dataset.taskCount === tasks.length, "批量上传后的题目数量错误");
  assert(dataset.roundCount === tasks.length * 2, "批量上传后的轮次数量错误");
  record("dataset.upload", {
    datasetId: dataset.id,
    tasks: dataset.taskCount,
    rounds: dataset.roundCount,
  });

  const globalConcurrency = 4;
  const experiment = await api("/api/experiments", {
    method: "POST",
    body: {
      name: `PackyAPI 全功能自动验收 ${verificationId}`,
      datasetId: dataset.id,
      harness: "opencode",
      models: modelSettings,
      globalConcurrency,
      providerConcurrency: { [profile.providerId]: globalConcurrency },
      maxAttempts: 3,
      roundTimeoutMs: 20 * 60 * 1000,
      retryBackoffMs: 2_000,
      systemPrompt: "你是自动化游戏源码生成代理。必须使用工具直接编辑工作区文件，完成要求后再简短回复；不要询问用户。",
    },
  });
  const expectedRuns = tasks.length * modelSettings.length;
  assert(experiment.totalRuns === expectedRuns, "题目 × 模型运行矩阵数量错误");
  record("experiment.created", {
    experimentId: experiment.id,
    expectedRuns,
    outputDir: experiment.outputDir,
    manifestPath: experiment.manifestPath,
  });

  const sseController = new AbortController();
  const firstEvent = await withTimeout(
    readFirstGenerationEvent(experiment.id, sseController.signal),
    30_000,
    "实时监控 SSE 在 30 秒内没有收到生成事件",
  );
  assert(firstEvent.experimentId === experiment.id, "SSE 返回了其他实验的事件");
  record("monitor.sse", { firstEventType: firstEvent.type });

  let observed = await waitForExperiment(experiment.id, 45 * 60 * 1000);
  observed = await recoverFailedRuns(experiment.id, observed, 3);
  sseController.abort();
  assert(observed.detail.experiment.status === "completed", summarizeFailure(observed.detail));
  assert(observed.detail.summary.total === expectedRuns, "最终运行总数错误");
  assert(observed.detail.summary.completed === expectedRuns, "不是所有真实运行都已完成");
  assert(observed.detail.summary.failed === 0, "真实运行中存在失败项");
  assert(observed.maximumActive >= 2, "真实矩阵没有观测到至少 2 个并发运行");
  record("experiment.completed", {
    status: observed.detail.experiment.status,
    summary: observed.detail.summary,
    maximumActive: observed.maximumActive,
    manualRetries: observed.manualRetries,
    elapsedMs: Date.now() - startedAt,
  });

  const expectedByModel = new Map(modelSettings.map((model) => [model.id, model]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const runChecks = [];
  for (const run of observed.detail.runs) {
    const setting = expectedByModel.get(run.modelId);
    const task = taskById.get(run.taskId);
    assert(setting, `运行 ${run.id} 的模型配置不存在`);
    assert(task, `运行 ${run.id} 的题目配置不存在`);
    const detail = await api(`/api/runs/${run.id}`);
    assert(detail.run.status === "completed", `运行 ${run.id} 未完成`);
    assert(detail.rounds.length === 2, `运行 ${run.id} 的轮次数量错误`);
    assert(detail.rounds.every((round) => round.status === "completed"), `运行 ${run.id} 存在失败轮次`);
    assert(detail.rounds.every((round) => typeof round.contextPath === "string"), `运行 ${run.id} 缺少轮次上下文路径`);

    const [generation, result, firstContext, secondContext, indexHtml] = await Promise.all([
      readJson(path.join(detail.run.workspacePath, ".benchmark", "generation.json")),
      readJson(detail.resultPath),
      readJson(detail.rounds[0].contextPath),
      readJson(detail.rounds[1].contextPath),
      readFile(path.join(detail.run.workspacePath, "index.html"), "utf8"),
    ]);
    assert(generation.reasoningEffort === setting.reasoningEffort, `运行 ${run.id} 的生成元信息档位错误`);
    assert(result.reasoningEffort === setting.reasoningEffort, `运行 ${run.id} 的结果档位错误`);
    assert(result.status === "completed", `运行 ${run.id} 的 result.json 状态错误`);
    assert(result.rounds.length === 2, `运行 ${run.id} 的 result.json 轮次数量错误`);
    assert(firstContext.model.reasoningEffort === setting.reasoningEffort, `运行 ${run.id} 第一轮档位错误`);
    assert(secondContext.model.reasoningEffort === setting.reasoningEffort, `运行 ${run.id} 第二轮档位错误`);
    assert(firstContext.session.id === secondContext.session.id, `运行 ${run.id} 多轮没有复用同一 Session`);
    assert(firstContext.contextBeforeRound.length === 0, `运行 ${run.id} 第一轮意外包含历史上下文`);
    assert(secondContext.contextBeforeRound.some((entry) => entry.role === "user" && entry.roundIndex === 0), `运行 ${run.id} 第二轮缺少上一轮用户上下文`);
    assert(secondContext.contextBeforeRound.some((entry) => entry.role === "assistant" && entry.roundIndex === 0), `运行 ${run.id} 第二轮缺少上一轮助手上下文`);
    assert(snapshotHasVariant(firstContext.session.snapshotAfterRound, setting.reasoningEffort), `运行 ${run.id} 第一轮 OpenCode 快照缺少真实 variant`);
    assert(snapshotHasVariant(secondContext.session.snapshotAfterRound, setting.reasoningEffort), `运行 ${run.id} 第二轮 OpenCode 快照缺少真实 variant`);
    assert(indexHtml.includes(task.markers.roundOne), `运行 ${run.id} 的游戏源码缺少第一轮标记`);
    assert(indexHtml.includes(task.markers.roundTwo), `运行 ${run.id} 的游戏源码缺少第二轮标记`);
    const artifact = await fetch(`${baseUrl}/artifacts/${run.id}/`);
    assert(artifact.status === 200, `运行 ${run.id} 的游戏预览接口失败`);
    assert((await artifact.text()).includes(task.markers.roundTwo), `运行 ${run.id} 的预览内容不是最终版本`);
    const protectedArtifact = await fetch(
      `${baseUrl}/artifacts/${run.id}/.benchmark/result.json`,
    );
    assert(protectedArtifact.status === 403, `运行 ${run.id} 暴露了内部 .benchmark 文件`);
    const failedAttempts = await verifyFailedAttempts(detail.run.workspacePath, detail.run.attempt);
    runChecks.push({
      runId: run.id,
      taskId: run.taskId,
      modelId: run.modelId,
      model: setting.model,
      reasoningEffort: setting.reasoningEffort,
      sessionId: firstContext.session.id,
      workspacePath: detail.run.workspacePath,
      contextFiles: detail.rounds.map((round) => round.contextPath),
      failedAttempts,
    });
  }
  record("runs.artifacts-and-context", { runs: runChecks });

  const manifest = await readJson(experiment.manifestPath);
  assert(manifest.status === "completed", "总清单状态不是 completed");
  assert(manifest.runs.length === expectedRuns, "总清单运行数量错误");
  assert(manifest.runs.every((run) => run.status === "completed"), "总清单包含未完成运行");
  record("manifest", {
    path: experiment.manifestPath,
    status: manifest.status,
    runs: manifest.runs.length,
  });

  const maxSmoke = await runMaxSmoke(maxSetting, verificationId);
  record("max.smoke", maxSmoke);

  report.status = "passed";
  report.completedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - startedAt;
  report.experimentId = experiment.id;
  report.maxExperimentId = maxSmoke.experimentId;
  report.outputDir = experiment.outputDir;
  report.manifestPath = experiment.manifestPath;
  await saveReport();
  console.log(`PackyAPI 全功能真实验收通过: ${experiment.id}`);
  console.log(`真实运行: ${expectedRuns}，最大观测并发: ${observed.maximumActive}`);
  console.log(`Max 专用实验: ${maxSmoke.experimentId}`);
  console.log(`源码目录: ${experiment.outputDir}`);
  console.log(`验收报告: ${reportPath}`);
} catch (error) {
  report.status = "failed";
  report.completedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - startedAt;
  report.error = error instanceof Error ? error.message : String(error);
  await saveReport().catch(() => undefined);
  console.error(`PackyAPI 全功能真实验收失败: ${report.error}`);
  console.error(`验收报告: ${reportPath}`);
  process.exitCode = 1;
}

function createTask(verificationId, number) {
  const roundOne = `${verificationId}-GAME-${number}-ROUND-ONE`;
  const roundTwo = `${verificationId}-GAME-${number}-ROUND-TWO`;
  return {
    id: `${verificationId}-game-${number}`,
    title: `自动验收游戏 ${number}`,
    markers: { roundOne, roundTwo },
    rounds: [{
      id: "create",
      prompt: `使用工具直接创建一个可玩的单文件 HTML 键盘小游戏，必须覆盖 index.html。页面可见文字和源码中都必须原样包含标记 ${roundOne}。同时创建 audit-round-1.txt，内容只写该标记。完成文件后再回复。`,
    }, {
      id: "improve",
      prompt: `继续上一轮的同一个游戏，使用工具增加操作反馈、得分与重新开始功能。保留上一轮标记，并让 index.html 的可见文字和源码新增标记 ${roundTwo}。创建 audit-round-2.txt，第一行写上一轮给你的标记，第二行写本轮标记。必须直接修改文件。`,
    }],
  };
}

async function runMaxSmoke(modelSetting, verificationId) {
  const roundOne = `${verificationId}-MAX-ROUND-ONE`;
  const roundTwo = `${verificationId}-MAX-ROUND-TWO`;
  const task = {
    id: `${verificationId}-max-smoke`,
    title: "Max 推理强度最小游戏",
    rounds: [{
      id: "create",
      prompt: `不要读取或检查现有文件。只调用一次 apply_patch，把 index.html 替换为一个最小可玩的点击计数 HTML，源码和可见文字包含 ${roundOne}。随后立即回复 DONE，不再调用其他工具。`,
    }, {
      id: "improve",
      prompt: `只调用一次 apply_patch，为现有点击游戏加入重置按钮，保留第一轮标记并新增 ${roundTwo}。随后立即回复 DONE，不再调用其他工具。`,
    }],
  };
  const dataset = await api("/api/datasets/import", {
    method: "POST",
    body: {
      name: `Max 专用验收题库 ${verificationId}`,
      files: [{ path: `${task.id}.json`, content: JSON.stringify(task) }],
    },
  });
  const experiment = await api("/api/experiments", {
    method: "POST",
    body: {
      name: `PackyAPI max 专用自动验收 ${verificationId}`,
      datasetId: dataset.id,
      harness: "opencode",
      models: [modelSetting],
      globalConcurrency: 1,
      providerConcurrency: { [modelSetting.model.split("/", 1)[0]]: 1 },
      maxAttempts: 3,
      roundTimeoutMs: 20 * 60 * 1000,
      retryBackoffMs: 2_000,
      systemPrompt: "必须使用工具直接编辑工作区。严格限制工具次数，完成指定文件后立即结束。",
    },
  });
  let observed = await waitForExperiment(experiment.id, 45 * 60 * 1000);
  observed = await recoverFailedRuns(experiment.id, observed, 3);
  assert(observed.detail.experiment.status === "completed", summarizeFailure(observed.detail));
  assert(observed.detail.summary.completed === 1, "Max 专用运行未完成");
  const run = observed.detail.runs[0];
  const detail = await api(`/api/runs/${run.id}`);
  const [generation, result, firstContext, secondContext, indexHtml] = await Promise.all([
    readJson(path.join(detail.run.workspacePath, ".benchmark", "generation.json")),
    readJson(detail.resultPath),
    readJson(detail.rounds[0].contextPath),
    readJson(detail.rounds[1].contextPath),
    readFile(path.join(detail.run.workspacePath, "index.html"), "utf8"),
  ]);
  assert(generation.reasoningEffort === "max", "Max 生成元信息档位错误");
  assert(result.reasoningEffort === "max", "Max 结果档位错误");
  assert(firstContext.model.reasoningEffort === "max", "Max 第一轮上下文档位错误");
  assert(secondContext.model.reasoningEffort === "max", "Max 第二轮上下文档位错误");
  assert(firstContext.session.id === secondContext.session.id, "Max 两轮没有复用同一 Session");
  assert(secondContext.contextBeforeRound.some((entry) => entry.role === "user" && entry.roundIndex === 0), "Max 第二轮缺少上一轮用户上下文");
  assert(secondContext.contextBeforeRound.some((entry) => entry.role === "assistant" && entry.roundIndex === 0), "Max 第二轮缺少上一轮助手上下文");
  assert(snapshotHasVariant(firstContext.session.snapshotAfterRound, "max"), "Max 第一轮快照缺少真实 variant");
  assert(snapshotHasVariant(secondContext.session.snapshotAfterRound, "max"), "Max 第二轮快照缺少真实 variant");
  assert(indexHtml.includes(roundOne), "Max 游戏源码缺少第一轮标记");
  assert(indexHtml.includes(roundTwo), "Max 游戏源码缺少第二轮标记");
  const artifact = await fetch(`${baseUrl}/artifacts/${run.id}/`);
  assert(artifact.status === 200, "Max 游戏预览接口失败");
  assert((await artifact.text()).includes(roundTwo), "Max 游戏预览不是最终版本");
  const failedAttempts = await verifyFailedAttempts(detail.run.workspacePath, detail.run.attempt);
  const manifest = await readJson(experiment.manifestPath);
  assert(manifest.status === "completed", "Max 总清单状态错误");
  return {
    experimentId: experiment.id,
    runId: run.id,
    status: observed.detail.experiment.status,
    attempt: detail.run.attempt,
    manualRetries: observed.manualRetries,
    failedAttempts,
    sessionId: firstContext.session.id,
    reasoningEffort: "max",
    outputDir: experiment.outputDir,
    manifestPath: experiment.manifestPath,
  };
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? body.error
      : `${response.status} ${response.statusText}`;
    throw new Error(`${pathname}: ${message}`);
  }
  return body;
}

async function waitForExperiment(experimentId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let maximumActive = 0;
  while (Date.now() < deadline) {
    const detail = await api(`/api/experiments/${experimentId}`);
    maximumActive = Math.max(
      maximumActive,
      detail.summary.preparing + detail.summary.running,
    );
    if (["completed", "failed", "cancelled"].includes(detail.experiment.status)) {
      return { detail, maximumActive, manualRetries: [] };
    }
    await delay(500);
  }
  throw new Error(`真实实验 ${experimentId} 在 ${Math.round(timeoutMs / 60_000)} 分钟内未结束`);
}

async function recoverFailedRuns(experimentId, initial, maximumCycles) {
  let current = initial;
  const manualRetries = [];
  for (let cycle = 1; cycle <= maximumCycles; cycle += 1) {
    const failedRuns = current.detail.runs.filter((run) => run.status === "failed");
    if (failedRuns.length === 0) break;
    for (const run of failedRuns) {
      await api(`/api/runs/${run.id}/retry`, { method: "POST", body: {} });
      manualRetries.push({ cycle, runId: run.id, taskId: run.taskId, modelId: run.modelId });
    }
    const next = await waitForExperiment(experimentId, 45 * 60 * 1000);
    current = {
      detail: next.detail,
      maximumActive: Math.max(current.maximumActive, next.maximumActive),
      manualRetries,
    };
  }
  return { ...current, manualRetries };
}

async function readFirstGenerationEvent(experimentId, signal) {
  const response = await fetch(
    `${baseUrl}/api/stream?experimentId=${encodeURIComponent(experimentId)}`,
    { signal },
  );
  assert(response.ok, "SSE 监控接口连接失败");
  assert(response.headers.get("content-type")?.includes("text/event-stream"), "SSE Content-Type 错误");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event.split("\n").find((line) => line.startsWith("data: "));
      if (data) return JSON.parse(data.slice(6));
    }
  }
  throw new Error("SSE 监控流在生成事件到达前关闭");
}

function snapshotHasVariant(snapshot, effort) {
  return Array.isArray(snapshot?.messages)
    && snapshot.messages.some((message) => message?.info?.variant === effort);
}

async function verifyFailedAttempts(workspacePath, finalAttempt) {
  if (finalAttempt <= 1) return [];
  const runRoot = path.dirname(workspacePath);
  const attempts = [];
  for (let attempt = 1; attempt < finalAttempt; attempt += 1) {
    const resultPath = path.join(runRoot, `attempt-${attempt}`, ".benchmark", "result.json");
    const result = await readJson(resultPath);
    assert(result.status === "failed", `${resultPath} 没有保留失败状态`);
    assert(typeof result.willRetry === "boolean", `${resultPath} 缺少重试状态`);
    assert(result.rounds.some((round) => round.contextFile), `${resultPath} 没有失败轮次上下文`);
    const contextFiles = [];
    for (const round of result.rounds.filter((round) => round.contextFile)) {
      const context = await readJson(round.contextFile);
      assert(context.round.status === "failed", `${round.contextFile} 没有记录失败轮次`);
      contextFiles.push(round.contextFile);
    }
    attempts.push({ attempt, resultPath, willRetry: result.willRetry, contextFiles });
  }
  return attempts;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function formatChecks(checks) {
  return checks.filter((check) => !check.ready)
    .map((check) => `${check.model}: ${check.message}`)
    .join("; ");
}

function summarizeFailure(detail) {
  const failed = detail.runs.filter((run) => run.status === "failed");
  return `真实实验状态 ${detail.experiment.status}; ${failed.map((run) => `${run.taskId}/${run.modelId}: ${run.error}`).join("; ")}`;
}

function record(name, details) {
  report.checks.push({ name, status: "passed", details });
  console.log(`通过: ${name}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function saveReport() {
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
