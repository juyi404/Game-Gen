import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ModelConfig, PackyBillingSnapshot, ResolvedBenchmarkConfig, RoundDefinition, TaskDefinition } from "./domain/types.js";

const MAX_ROUND_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ROUND_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const packyBillingSnapshotSchema = z.object({
  provider: z.literal("packy"),
  group: z.string().min(1).max(120),
  catalogSource: z.url(),
  catalogFetchedAt: z.number().int().nonnegative(),
  pricing: z.object({
    quotaType: z.union([z.number(), z.string()]).optional(),
    modelRatio: z.union([z.number(), z.string()]).optional(),
    modelPrice: z.union([z.number(), z.string()]).optional(),
    completionRatio: z.union([z.number(), z.string()]).optional(),
    tiers: z.unknown().optional(),
  }),
}).transform((value): PackyBillingSnapshot => ({
  provider: value.provider,
  group: value.group,
  catalogSource: value.catalogSource,
  catalogFetchedAt: value.catalogFetchedAt,
  pricing: {
    ...(value.pricing.quotaType !== undefined ? { quotaType: value.pricing.quotaType } : {}),
    ...(value.pricing.modelRatio !== undefined ? { modelRatio: value.pricing.modelRatio } : {}),
    ...(value.pricing.modelPrice !== undefined ? { modelPrice: value.pricing.modelPrice } : {}),
    ...(value.pricing.completionRatio !== undefined
      ? { completionRatio: value.pricing.completionRatio }
      : {}),
    ...(value.pricing.tiers !== undefined ? { tiers: value.pricing.tiers } : {}),
  },
}));

const identifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "仅允许字母、数字、点、下划线和短横线");

const rawRoundSchema = z.union([
  z.string().min(1),
  z
    .object({
      id: identifierSchema.optional(),
      prompt: z.string().min(1).optional(),
      promptFile: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(0).max(MAX_ROUND_TIMEOUT_MS).optional(),
    })
    .refine((value) => Boolean(value.prompt) !== Boolean(value.promptFile), {
      message: "每轮必须且只能设置 prompt 或 promptFile",
    }),
]);

const rawTaskSchema = z.object({
  id: identifierSchema,
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  seedDir: z.string().min(1).optional(),
  rounds: z.array(rawRoundSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const rawTaskCollectionSchema = z
  .object({
    dataset: z.string().min(1),
    count: z.number().int().positive(),
    games: z.array(rawTaskSchema).min(1),
  })
  .refine((value) => value.count === value.games.length, {
    message: "count 必须等于 games 数组长度",
    path: ["count"],
  });

const rawTaskDocumentSchema = z.union([rawTaskSchema, rawTaskCollectionSchema]);

const rawModelSchema = z.object({
  id: identifierSchema,
  model: z.string().regex(/^[^/]+\/.+$/, "model 必须使用 provider/model 格式"),
  enabled: z.boolean().default(true),
  concurrency: z.number().int().positive().default(1),
  roundTimeoutMs: z.number().int().min(0).max(MAX_ROUND_TIMEOUT_MS).optional(),
  reasoningEffort: identifierSchema.optional(),
  agent: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  billingSnapshot: packyBillingSnapshotSchema.optional(),
});

const rawBenchmarkSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().min(1),
  dataset: z.object({
    dir: z.string().min(1),
    include: z.array(identifierSchema).default([]),
  }),
  models: z.array(rawModelSchema).min(1),
  runtime: z
    .object({
      harness: z.enum(["opencode", "mock"]).default("opencode"),
      stageMode: z.enum(["all", "manual"]).default("all"),
      globalConcurrency: z.number().int().positive().default(16),
      providerConcurrency: z.record(z.string(), z.number().int().positive()).default({}),
      outputDir: z.string().min(1).default("./runs"),
      dataDir: z.string().min(1).default("./.gamebench"),
      roundTimeoutMs: z.number().int().min(0).max(MAX_ROUND_TIMEOUT_MS).default(0),
      initialBuildSoftTimeoutMs: z.number().int().min(0).max(MAX_ROUND_TIMEOUT_MS).optional(),
      initialBuildWrapUpMs: z.number().int().min(1).max(60 * 60 * 1000).optional(),
      roundIdleTimeoutMs: z.number().int().min(0).max(MAX_ROUND_TIMEOUT_MS)
        .default(DEFAULT_ROUND_IDLE_TIMEOUT_MS),
      maxAttempts: z.number().int().min(1).max(10).default(2),
      retryBackoffMs: z.number().int().nonnegative().default(10_000),
      workspaceTemplate: z.string().min(1).optional(),
    })
    .default({
      harness: "opencode",
      stageMode: "all",
      globalConcurrency: 16,
      providerConcurrency: {},
      outputDir: "./runs",
      dataDir: "./.gamebench",
      roundTimeoutMs: 0,
      roundIdleTimeoutMs: DEFAULT_ROUND_IDLE_TIMEOUT_MS,
      maxAttempts: 2,
      retryBackoffMs: 10_000,
    }),
  dashboard: z
    .object({
      hostname: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(1).max(65_535).default(8787),
    })
    .default({ hostname: "127.0.0.1", port: 8787 }),
  opencode: z
    .object({
      serverUrl: z.url().optional(),
      hostname: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(1).max(65_535).default(4096),
      startupTimeoutMs: z.number().int().positive().default(15_000),
      agent: z.string().min(1).default("build"),
      config: z.record(z.string(), z.unknown()).default({}),
    })
    .default({
      hostname: "127.0.0.1",
      port: 4096,
      startupTimeoutMs: 15_000,
      agent: "build",
      config: {},
    }),
  mock: z
    .object({
      delayMs: z.number().int().nonnegative().default(250),
      failTaskIds: z.array(identifierSchema).default([]),
    })
    .default({ delayMs: 250, failTaskIds: [] }),
  systemPrompt: z.string().optional(),
  systemPromptFile: z.string().min(1).optional(),
});

const DEFAULT_SYSTEM_PROMPT = [
  "You are generating a game for an automated benchmark.",
  "Implement the requested game directly inside the current working directory.",
  "Work autonomously, do not ask the user questions, and keep all created files inside the workspace.",
  "The framework only collects generation artifacts; do not attempt to score or evaluate the game.",
].join(" ");

export async function loadBenchmarkConfig(configPath: string): Promise<{
  config: ResolvedBenchmarkConfig;
  tasks: TaskDefinition[];
}> {
  const sourcePath = path.resolve(configPath);
  const configDir = path.dirname(sourcePath);
  const raw = rawBenchmarkSchema.parse(JSON.parse(await readFile(sourcePath, "utf8")));
  const modelIds = new Set<string>();
  const models: ModelConfig[] = raw.models.map((model) => {
    if (modelIds.has(model.id)) {
      throw new Error(`模型 id 重复: ${model.id}`);
    }
    modelIds.add(model.id);
    const slash = model.model.indexOf("/");
    const result: ModelConfig = {
      id: model.id,
      model: model.model,
      provider: model.model.slice(0, slash),
      modelName: model.model.slice(slash + 1),
      enabled: model.enabled,
      concurrency: model.concurrency,
    };
    if (model.roundTimeoutMs !== undefined) result.roundTimeoutMs = model.roundTimeoutMs;
    if (model.reasoningEffort) result.reasoningEffort = model.reasoningEffort;
    if (model.agent) result.agent = model.agent;
    if (model.systemPrompt) result.systemPrompt = model.systemPrompt;
    if (model.billingSnapshot) result.billingSnapshot = model.billingSnapshot;
    return result;
  });

  if (!models.some((model) => model.enabled)) {
    throw new Error("配置中至少需要启用一个模型");
  }

  const datasetDir = resolveFrom(configDir, raw.dataset.dir);
  const tasks = await loadTasks(datasetDir, raw.dataset.include);
  const systemPrompt = raw.systemPromptFile
    ? await readFile(resolveFrom(configDir, raw.systemPromptFile), "utf8")
    : (raw.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);

  const runtime: ResolvedBenchmarkConfig["runtime"] = {
    harness: raw.runtime.harness,
    stageMode: raw.runtime.stageMode,
    globalConcurrency: raw.runtime.globalConcurrency,
    providerConcurrency: raw.runtime.providerConcurrency,
    outputDir: resolveFrom(configDir, raw.runtime.outputDir),
    dataDir: resolveFrom(configDir, raw.runtime.dataDir),
    roundTimeoutMs: raw.runtime.roundTimeoutMs,
    ...(raw.runtime.initialBuildSoftTimeoutMs !== undefined
      ? { initialBuildSoftTimeoutMs: raw.runtime.initialBuildSoftTimeoutMs } : {}),
    ...(raw.runtime.initialBuildWrapUpMs !== undefined
      ? { initialBuildWrapUpMs: raw.runtime.initialBuildWrapUpMs } : {}),
    roundIdleTimeoutMs: raw.runtime.roundIdleTimeoutMs,
    maxAttempts: raw.runtime.maxAttempts,
    retryBackoffMs: raw.runtime.retryBackoffMs,
  };
  if (raw.runtime.workspaceTemplate) {
    runtime.workspaceTemplate = resolveFrom(configDir, raw.runtime.workspaceTemplate);
  }

  const opencode: ResolvedBenchmarkConfig["opencode"] = {
    hostname: raw.opencode.hostname,
    port: raw.opencode.port,
    startupTimeoutMs: raw.opencode.startupTimeoutMs,
    agent: raw.opencode.agent,
    config: raw.opencode.config,
  };
  if (raw.opencode.serverUrl) opencode.serverUrl = raw.opencode.serverUrl;

  return {
    config: {
      version: 1,
      name: raw.name,
      sourcePath,
      datasetDir,
      includeTaskIds: raw.dataset.include,
      models,
      runtime,
      dashboard: raw.dashboard,
      opencode,
      mock: raw.mock,
      systemPrompt,
    },
    tasks,
  };
}

export async function loadTasks(
  datasetDir: string,
  includeTaskIds: string[] = [],
  options: { references?: "within-dataset" | "forbid" } = {},
): Promise<TaskDefinition[]> {
  const datasetRoot = await realpath(datasetDir);
  const referencePolicy = options.references ?? "within-dataset";
  const files = (await listJsonFiles(datasetRoot)).sort((left, right) => left.localeCompare(right));
  const include = new Set(includeTaskIds);
  const taskIds = new Set<string>();
  const tasks: TaskDefinition[] = [];

  for (const sourcePath of files) {
    const taskDir = path.dirname(sourcePath);
    const document = rawTaskDocumentSchema.parse(JSON.parse(await readFile(sourcePath, "utf8")));
    const rawTasks = "games" in document ? document.games : [document];

    for (const raw of rawTasks) {
      if (include.size > 0 && !include.has(raw.id)) continue;
      if (taskIds.has(raw.id)) throw new Error(`任务 id 重复: ${raw.id}`);
      taskIds.add(raw.id);

      const rounds: RoundDefinition[] = [];
      for (const [index, item] of raw.rounds.entries()) {
        if (typeof item === "string") {
          rounds.push({ id: `round-${index + 1}`, prompt: item });
          continue;
        }
        if (item.promptFile && referencePolicy === "forbid") {
          throw new Error(`网页上传题库不允许使用 promptFile: ${raw.id}/${item.id ?? `round-${index + 1}`}`);
        }
        const promptPath = item.promptFile
          ? await resolveDatasetReference(datasetRoot, taskDir, item.promptFile, "文件")
          : null;
        const prompt = item.prompt ?? (await readFile(promptPath!, "utf8"));
        const round: RoundDefinition = { id: item.id ?? `round-${index + 1}`, prompt };
        if (item.timeoutMs !== undefined) round.timeoutMs = item.timeoutMs;
        rounds.push(round);
      }

      const task: TaskDefinition = {
        id: raw.id,
        title: raw.title ?? raw.id,
        sourcePath,
        rounds,
        metadata: raw.metadata,
      };
      if (raw.description) task.description = raw.description;
      if (raw.seedDir) {
        if (referencePolicy === "forbid") {
          throw new Error(`网页上传题库不允许使用 seedDir: ${raw.id}`);
        }
        task.seedDir = await resolveDatasetReference(datasetRoot, taskDir, raw.seedDir, "目录");
        const seedInfo = await stat(task.seedDir);
        if (!seedInfo.isDirectory()) throw new Error(`seedDir 不是目录: ${raw.seedDir}`);
      }
      tasks.push(task);
    }
  }

  if (tasks.length === 0) {
    throw new Error(`数据集没有可运行任务: ${datasetDir}`);
  }
  const missing = [...include].filter((id) => !taskIds.has(id));
  if (missing.length > 0) {
    throw new Error(`include 中的任务不存在: ${missing.join(", ")}`);
  }
  return tasks;
}

async function listJsonFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listJsonFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      result.push(entryPath);
    }
  }
  return result;
}

function resolveFrom(base: string, target: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(base, target);
}

async function resolveDatasetReference(
  datasetRoot: string,
  taskDir: string,
  target: string,
  kind: "文件" | "目录",
): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(resolveFrom(taskDir, target));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${kind}引用无法读取: ${target} (${detail})`);
  }
  const relative = path.relative(datasetRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${kind}引用必须位于题库目录内: ${target}`);
  }
  return resolved;
}

export async function assertReadableDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`不是目录: ${directory}`);
}
