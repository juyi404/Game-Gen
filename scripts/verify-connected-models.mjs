import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { OpenCodeHarness } from "../dist/src/harness/opencode.js";

const dashboardUrl = (process.env.GAMEBENCH_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/u, "");
const openCodeUrl = (process.env.GAMEBENCH_OPENCODE_URL ?? "http://127.0.0.1:4096").replace(/\/+$/u, "");
const globalConcurrency = positiveInteger(process.env.GAMEBENCH_VERIFY_CONCURRENCY, 12);
const providerConcurrency = positiveInteger(process.env.GAMEBENCH_VERIFY_PROVIDER_CONCURRENCY, 3);
const timeoutMs = positiveInteger(process.env.GAMEBENCH_VERIFY_TIMEOUT_MS, 5 * 60 * 1000);
const forcedReasoningEffort = process.env.GAMEBENCH_VERIFY_REASONING_EFFORT?.trim() || "";
const providerPattern = optionalPattern(process.env.GAMEBENCH_VERIFY_PROVIDERS);
const modelPattern = optionalPattern(process.env.GAMEBENCH_VERIFY_MODELS);
const excludedPattern = optionalPattern(process.env.GAMEBENCH_VERIFY_EXCLUDE);
const maximumModels = positiveInteger(process.env.GAMEBENCH_VERIFY_LIMIT, Number.MAX_SAFE_INTEGER);
const runStamp = new Date().toISOString().replace(/[:.]/gu, "-");
const reportDirectory = path.resolve(
  process.env.GAMEBENCH_VERIFY_DIR
    ?? path.join(".gamebench", "verification", `connected-models-${runStamp}`),
);
const workspacesDirectory = path.join(reportDirectory, "workspaces");
const reportPath = path.join(reportDirectory, "report.json");
const startedAt = Date.now();
const marker = "MODEL_CONNECTIVITY_OK";
const report = {
  schemaVersion: 1,
  type: "gamebench-connected-model-verification",
  status: "running",
  startedAt: new Date(startedAt).toISOString(),
  completedAt: null,
  dashboardUrl,
  openCodeUrl,
  settings: {
    globalConcurrency,
    providerConcurrency,
    timeoutMs,
    forcedReasoningEffort: forcedReasoningEffort || null,
    providerPattern: providerPattern?.source ?? null,
    modelPattern: modelPattern?.source ?? null,
    excludedPattern: excludedPattern?.source ?? null,
    maximumModels: Number.isSafeInteger(maximumModels) ? maximumModels : null,
  },
  inventory: { providers: 0, models: 0 },
  summary: emptySummary(),
  results: [],
};

await mkdir(workspacesDirectory, { recursive: true });
await saveReport();

const harness = new OpenCodeHarness(
  {
    serverUrl: openCodeUrl,
    hostname: "127.0.0.1",
    port: 4096,
    startupTimeoutMs: 15_000,
    agent: "build",
    config: {},
  },
  "You are performing a model connectivity smoke test. Use the editing tool in the workspace and finish promptly.",
  { pollIntervalMs: 1_000, maxPollErrors: 6 },
);

try {
  const providers = await api("/api/providers");
  const connectedProviders = providers.filter((provider) => provider.connected);
  const models = roundRobin(
    connectedProviders
      .filter((provider) => matches(providerPattern, provider.id))
      .flatMap((provider) => provider.models
        .filter((model) => model.toolCall && model.status !== "deprecated")
        .filter((model) => matches(modelPattern, `${provider.id}/${model.id}`))
        .filter((model) => !excludedPattern || !excludedPattern.test(`${provider.id}/${model.id}`))
        .map((model) => ({
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          modelName: model.name,
          reasoningEfforts: model.reasoningEfforts ?? [],
        }))),
  ).slice(0, maximumModels);

  report.inventory = {
    providers: new Set(models.map((model) => model.providerId)).size,
    models: models.length,
  };
  report.summary = { ...emptySummary(), total: models.length, pending: models.length };
  await saveReport();
  console.log(`Testing ${models.length} models from ${report.inventory.providers} providers`);
  console.log(`Report: ${reportPath}`);

  await harness.start();
  await runWithLimits(models, async (model, sequence) => {
    const result = await verifyModel(model, sequence);
    report.results.push(result);
    report.results.sort((left, right) => left.sequence - right.sequence);
    report.summary = summarize(report.results, models.length);
    await saveReport();
    console.log(
      `[${report.results.length}/${models.length}] ${result.status.toUpperCase()} ${result.model} (${formatDuration(result.elapsedMs)})${result.error ? ` - ${result.error}` : ""}`,
    );
  });

  report.status = report.summary.failed === 0 ? "completed" : "completed_with_failures";
} catch (error) {
  report.status = "aborted";
  report.fatalError = sanitizeError(error);
  throw error;
} finally {
  await harness.stop();
  report.completedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - startedAt;
  report.summary = summarize(report.results, report.inventory.models);
  await saveReport();
  console.log(`Summary: ${JSON.stringify(report.summary)}`);
  console.log(`Saved: ${reportPath}`);
}

async function verifyModel(model, sequence) {
  const started = Date.now();
  const modelPath = `${model.providerId}/${model.modelId}`;
  const workspacePath = path.join(
    workspacesDirectory,
    `${String(sequence + 1).padStart(3, "0")}-${safeSegment(model.providerId)}--${safeSegment(model.modelId)}`,
  );
  const contextPath = path.join(workspacePath, "session-context.json");
  const eventsPath = path.join(workspacePath, "events.json");
  const events = [];
  let sessionId = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const task = {
    id: `connectivity-${String(sequence + 1).padStart(3, "0")}`,
    title: `Connectivity test for ${modelPath}`,
    sourcePath: reportPath,
    rounds: [],
    metadata: { verification: true },
  };
  const modelConfig = {
    id: safeSegment(`${model.providerId}-${model.modelId}`).slice(0, 120),
    model: modelPath,
    provider: model.providerId,
    modelName: model.modelId,
    enabled: true,
    concurrency: 1,
    ...(selectReasoningEffort(model.reasoningEfforts).length > 0
      ? { reasoningEffort: selectReasoningEffort(model.reasoningEfforts) }
      : {}),
  };
  const run = {
    id: `verify-${sequence + 1}`,
    experimentId: `connected-models-${runStamp}`,
    taskId: task.id,
    taskTitle: task.title,
    modelId: modelConfig.id,
    providerId: model.providerId,
    modelName: model.modelId,
    status: "running",
    currentRound: 0,
    totalRounds: 1,
    attempt: 1,
    maxAttempts: 1,
    availableAt: started,
    workspacePath,
    sessionId: null,
    error: null,
    queuedAt: started,
    startedAt: started,
    completedAt: null,
    updatedAt: started,
  };
  const context = {
    run,
    model: modelConfig,
    task,
    workspacePath,
    signal: controller.signal,
    emit: (type, level, message, data = {}) => {
      events.push({ at: new Date().toISOString(), type, level, message, data: sanitizeValue(data) });
    },
  };
  const round = {
    id: "connectivity",
    prompt: [
      "Do not inspect existing files.",
      "Use apply_patch exactly once to replace index.html with a complete self-contained playable click-counter game.",
      `The visible page and HTML source must contain the exact marker ${marker}.`,
      "Include an inline <script> that increments a visible score when the player clicks a button.",
      "After the patch succeeds, reply only DONE.",
    ].join(" "),
    timeoutMs,
  };

  try {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      path.join(workspacePath, "index.html"),
      "<!doctype html><html><body>CONNECTIVITY_PENDING</body></html>\n",
      "utf8",
    );
    sessionId = await harness.beginRun(context);
    run.sessionId = sessionId;
    const generation = await harness.executeRound(context, sessionId, round, 0);
    const html = await readFile(path.join(workspacePath, "index.html"), "utf8");
    if (!html.includes(marker)) throw new Error(`Generated index.html is missing ${marker}`);
    if (!/<script\b/iu.test(html)) throw new Error("Generated index.html is missing an inline script");
    const capturedContext = await harness.captureRoundContext(context, sessionId, round, 0);
    await writeFile(contextPath, `${JSON.stringify(sanitizeValue(capturedContext), null, 2)}\n`, "utf8");
    return {
      sequence,
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.modelId,
      modelName: model.modelName,
      model: modelPath,
      reasoningEffort: modelConfig.reasoningEffort ?? null,
      status: "passed",
      category: "ready",
      elapsedMs: Date.now() - started,
      usage: generation.usage ?? null,
      response: generation.response.slice(0, 4_000),
      sessionId,
      workspacePath,
      contextPath,
      eventsPath,
      error: null,
    };
  } catch (error) {
    if (sessionId) await harness.abortRun(sessionId, workspacePath);
    const message = sanitizeError(error);
    return {
      sequence,
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.modelId,
      modelName: model.modelName,
      model: modelPath,
      reasoningEffort: modelConfig.reasoningEffort ?? null,
      status: "failed",
      category: classifyError(message, model.providerId),
      elapsedMs: Date.now() - started,
      usage: null,
      response: null,
      sessionId,
      workspacePath,
      contextPath: null,
      eventsPath,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
    await writeFile(eventsPath, `${JSON.stringify(events, null, 2)}\n`, "utf8");
  }
}

async function runWithLimits(models, worker) {
  const queue = models.map((model, sequence) => ({ model, sequence }));
  const activeByProvider = new Map();
  const active = new Set();
  while (queue.length > 0 || active.size > 0) {
    let launched = false;
    for (let index = 0; index < queue.length && active.size < globalConcurrency;) {
      const item = queue[index];
      const providerActive = activeByProvider.get(item.model.providerId) ?? 0;
      if (providerActive >= providerLimit(item.model.providerId)) {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      launched = true;
      activeByProvider.set(item.model.providerId, providerActive + 1);
      const promise = worker(item.model, item.sequence)
        .finally(() => {
          active.delete(promise);
          const remaining = (activeByProvider.get(item.model.providerId) ?? 1) - 1;
          if (remaining > 0) activeByProvider.set(item.model.providerId, remaining);
          else activeByProvider.delete(item.model.providerId);
        });
      active.add(promise);
    }
    if (active.size === 0) throw new Error("No verification task can be scheduled");
    if (!launched || active.size >= globalConcurrency || queue.length === 0) {
      await Promise.race(active);
    }
  }
}

function providerLimit(providerId) {
  if (providerId === "alibaba-cn") return Math.max(providerConcurrency, 8);
  return providerConcurrency;
}

function roundRobin(models) {
  const groups = new Map();
  for (const model of models) {
    const group = groups.get(model.providerId) ?? [];
    group.push(model);
    groups.set(model.providerId, group);
  }
  for (const group of groups.values()) group.sort((left, right) => left.modelId.localeCompare(right.modelId));
  const result = [];
  while ([...groups.values()].some((group) => group.length > 0)) {
    for (const group of groups.values()) {
      const model = group.shift();
      if (model) result.push(model);
    }
  }
  return result;
}

function summarize(results, total) {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const categories = {};
  const providers = {};
  for (const result of results) {
    categories[result.category] = (categories[result.category] ?? 0) + 1;
    const provider = providers[result.providerId] ?? { total: 0, passed: 0, failed: 0 };
    provider.total += 1;
    provider[result.status] += 1;
    providers[result.providerId] = provider;
  }
  return { total, pending: Math.max(0, total - results.length), passed, failed, categories, providers };
}

function emptySummary() {
  return { total: 0, pending: 0, passed: 0, failed: 0, categories: {}, providers: {} };
}

function classifyError(message, providerId) {
  if (providerId === "packy-claude-sale" && /(?:official|官方) Claude CLI|403|forbidden/iu.test(message)) return "protocol_restricted";
  if (/429|rate.?limit|too many requests|quota/iu.test(message)) return "rate_limited";
  if (/401|unauthorized|(?:invalid|incorrect).*?(?:key|token)|authentication/iu.test(message)) return "authentication";
  if (/未覆盖供应商|token.*does not cover|not covered by.*token/iu.test(message)) return "permission_or_entitlement";
  if (/无可用渠道|no available (?:channel|distributor)/iu.test(message)) return "provider_unavailable";
  if (/不支持.*协议|protocol.*not supported|not implemented/iu.test(message)) return "protocol_unsupported";
  if (/403|forbidden|permission|not allowed|access denied/iu.test(message)) return "permission_or_entitlement";
  if (/404|model.*not found|unknown model|does not exist/iu.test(message)) return "model_not_found";
  if (/timed out|timeout|abort/iu.test(message)) return "timeout";
  if (/fetch failed|ECONN|ENOTFOUND|socket|network/iu.test(message)) return "network";
  if (/empty|空结果|没有模型消息|0 Token/iu.test(message)) return "empty_response";
  if (/index\.html|artifact|生成结果无效|marker|inline script/iu.test(message)) return "invalid_artifact";
  return "model_error";
}

function selectReasoningEffort(efforts) {
  if (forcedReasoningEffort && efforts.includes(forcedReasoningEffort)) return forcedReasoningEffort;
  const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  return order.find((effort) => efforts.includes(effort)) ?? "";
}

async function api(pathname) {
  const response = await fetch(`${dashboardUrl}${pathname}`, { signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error : text;
    throw new Error(`${pathname}: ${response.status} ${message}`);
  }
  return body;
}

async function saveReport() {
  const temporaryPath = `${reportPath}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(temporaryPath, reportPath);
}

function sanitizeError(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/giu, "[REDACTED]")
    .slice(0, 4_000);
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeError(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /api.?key|authorization|token|secret/iu.test(key) ? "[REDACTED]" : sanitizeValue(item),
    ]),
  );
}

function optionalPattern(value) {
  return value?.trim() ? new RegExp(value.trim(), "iu") : null;
}

function matches(pattern, value) {
  return !pattern || pattern.test(value);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeSegment(value) {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return safe || "item";
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}
