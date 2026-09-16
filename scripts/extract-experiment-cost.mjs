import { DatabaseSync } from "node:sqlite";

const [databasePath, experimentId] = process.argv.slice(2);
if (!databasePath || !experimentId) {
  throw new Error("Usage: node extract-experiment-cost.mjs <database.sqlite> <experiment-id>");
}

const pricing = {
  "claude-fable-5": { label: "Claude Fable 5", unit: 20, completion: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-5": { label: "Claude Opus 5", unit: 10, completion: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gpt-6-astra": { label: "GPT-6 Astra", unit: 5, completion: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
const astraOfficial = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite: 12.5,
  longContextThreshold: 272_000,
};

const db = new DatabaseSync(databasePath, { readOnly: true });
const runs = db.prepare(`
  SELECT id, task_id, task_title, model_id, status, queued_at, started_at, completed_at
  FROM runs
  WHERE experiment_id = ?
  ORDER BY model_id, task_id
`).all(experimentId);
const eventsForRun = db.prepare(`
  SELECT type, data_json, created_at
  FROM events
  WHERE run_id = ?
  ORDER BY id
`);

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usageFrom(data) {
  const usage = data?.tokens ?? data?.usage ?? data?.result?.usage ?? data?.response?.usage ?? {};
  return {
    input: n(usage.input ?? usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens),
    output: n(usage.output ?? usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens),
    reasoning: n(usage.reasoning ?? usage.reasoningTokens ?? usage.reasoning_tokens),
    cacheRead: n(usage.cache?.read ?? usage.cacheRead ?? usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cachedTokens ?? usage.cached_tokens),
    cacheWrite: n(usage.cache?.write ?? usage.cacheWrite ?? usage.cacheWriteTokens ?? usage.cache_write_tokens),
    recordedCost: n(data?.cost ?? usage.cost),
  };
}

function blankUsage() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, recordedCost: 0 };
}

function add(target, usage) {
  for (const key of Object.keys(target)) target[key] += n(usage[key]);
}

function estimate(modelId, usage) {
  const p = pricing[modelId];
  if (!p) return null;
  const scale = p.unit / 1_000_000;
  return scale * (
    usage.input
    + usage.output * p.completion
    + usage.reasoning * p.completion
    + usage.cacheRead * p.cacheRead
    + usage.cacheWrite * p.cacheWrite
  );
}

const details = runs.map((run) => {
  const usage = blankUsage();
  let steps = 0;
  let dispatches = 0;
  let retries = 0;
  let toolErrors = 0;
  let officialStandardCostUsd = 0;
  let officialCostUsd = 0;
  let longContextSteps = 0;
  for (const event of eventsForRun.all(run.id)) {
    let data = {};
    try { data = JSON.parse(event.data_json || "{}"); } catch {}
    if (event.type === "harness.step.completed") {
      const stepUsage = usageFrom(data);
      add(usage, stepUsage);
      if (run.model_id === "gpt-6-astra") {
        const promptTokens = stepUsage.input + stepUsage.cacheRead + stepUsage.cacheWrite;
        const longContext = promptTokens > astraOfficial.longContextThreshold;
        if (longContext) longContextSteps += 1;
        const inputMultiplier = longContext ? 2 : 1;
        const outputMultiplier = longContext ? 1.5 : 1;
        officialStandardCostUsd += (
          stepUsage.input * astraOfficial.input
          + (stepUsage.output + stepUsage.reasoning) * astraOfficial.output
          + stepUsage.cacheRead * astraOfficial.cacheRead
          + stepUsage.cacheWrite * astraOfficial.cacheWrite
        ) / 1_000_000;
        officialCostUsd += (
          stepUsage.input * astraOfficial.input * inputMultiplier
          + (stepUsage.output + stepUsage.reasoning) * astraOfficial.output * outputMultiplier
          + stepUsage.cacheRead * astraOfficial.cacheRead * inputMultiplier
          + stepUsage.cacheWrite * astraOfficial.cacheWrite * inputMultiplier
        ) / 1_000_000;
      }
      steps += 1;
    }
    if (event.type === "run.dispatched") dispatches += 1;
    if (event.type.includes("retry")) retries += 1;
    if (event.type === "harness.tool.error" || event.type === "tool.error") toolErrors += 1;
  }
  const started = n(run.started_at ?? run.queued_at);
  const finished = n(run.completed_at);
  return {
    ...run,
    elapsedMs: started && finished ? Math.max(0, finished - started) : 0,
    steps,
    dispatches,
    retries,
    toolErrors,
    ...usage,
    totalTokens: usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite,
    estimatedCost: estimate(run.model_id, usage),
    officialStandardCostUsd,
    officialCostUsd,
    longContextSteps,
  };
});

const byModel = Object.fromEntries(Object.keys(pricing).map((modelId) => [modelId, {
  modelId,
  label: pricing[modelId].label,
  games: 0,
  elapsedMs: 0,
  steps: 0,
  dispatches: 0,
  retries: 0,
  toolErrors: 0,
  ...blankUsage(),
  totalTokens: 0,
  estimatedCost: 0,
  officialStandardCostUsd: 0,
  officialCostUsd: 0,
  longContextSteps: 0,
}]));

for (const run of details) {
  const summary = byModel[run.model_id];
  if (!summary) continue;
  summary.games += 1;
  for (const key of ["elapsedMs", "steps", "dispatches", "retries", "toolErrors", "input", "output", "reasoning", "cacheRead", "cacheWrite", "recordedCost", "totalTokens", "estimatedCost", "officialStandardCostUsd", "officialCostUsd", "longContextSteps"]) {
    summary[key] += n(run[key]);
  }
}

const totals = {
  games: 0,
  elapsedMs: 0,
  steps: 0,
  dispatches: 0,
  retries: 0,
  toolErrors: 0,
  ...blankUsage(),
  totalTokens: 0,
  estimatedCost: 0,
  officialStandardCostUsd: 0,
  officialCostUsd: 0,
  longContextSteps: 0,
};
for (const summary of Object.values(byModel)) {
  summary.averageElapsedMs = summary.elapsedMs / Math.max(summary.games, 1);
  summary.averageCost = summary.estimatedCost / Math.max(summary.games, 1);
  for (const key of Object.keys(totals)) totals[key] += n(summary[key]);
}

console.log(JSON.stringify({ experimentId, generatedAt: new Date().toISOString(), pricing, astraOfficial, totals, byModel, runs: details }, null, 2));
