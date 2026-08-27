import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildEffectiveSystemPrompt, renderRoundPrompt } from "./prompt-context.js";
import type {
  ExperimentRecord,
  ExperimentSummary,
  HarnessRoundResult,
  ModelConfig,
  ResolvedBenchmarkConfig,
  RoundDefinition,
  RoundRecord,
  RunRecord,
  TaskDefinition,
} from "./types.js";

export interface RoundContextWriteInput {
  config: ResolvedBenchmarkConfig;
  workspacePath: string;
  run: RunRecord;
  task: TaskDefinition;
  model: ModelConfig;
  round: RoundDefinition;
  roundRecord: RoundRecord;
  allRounds: RoundRecord[];
  sessionId: string;
  usage?: HarnessRoundResult["usage"];
  harnessContext?: unknown;
}

export async function prepareWorkspace(
  config: ResolvedBenchmarkConfig,
  experiment: ExperimentRecord,
  run: RunRecord,
  task: TaskDefinition,
  tasks: Iterable<TaskDefinition> = [task],
): Promise<string> {
  const outputRoot = experimentOutputDir(config, experiment.id);
  if (run.workspacePath && (run.sessionId || run.resumePending)) {
    const existingWorkspace = path.resolve(run.workspacePath);
    const relative = path.relative(outputRoot, existingWorkspace);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`续跑源码目录超出本次任务范围: ${existingWorkspace}`);
    }
    if (!existsSync(existingWorkspace)) {
      throw new Error(`续跑源码目录不存在: ${existingWorkspace}`);
    }
    return existingWorkspace;
  }
  const model = config.models.find((item) => item.id === run.modelId);
  const workspacePath = path.join(
    outputRoot,
    gameDirectoryName(task, tasks),
    safeSegment(run.modelId),
    `attempt-${run.attempt}`,
  );
  await mkdir(workspacePath, { recursive: true });

  if (config.runtime.workspaceTemplate) {
    await cp(config.runtime.workspaceTemplate, workspacePath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }
  if (task.seedDir) {
    await cp(task.seedDir, workspacePath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }

  const metadataDir = path.join(workspacePath, ".benchmark");
  await mkdir(metadataDir, { recursive: true });
  await writeFile(
    path.join(metadataDir, "generation.json"),
    `${JSON.stringify(
      {
        experimentId: experiment.id,
        runId: run.id,
        taskId: task.id,
        modelId: run.modelId,
        model: `${run.providerId}/${run.modelName}`,
         reasoningEffort: model?.reasoningEffort ?? null,
        stageMode: experiment.stageMode,
        attempt: run.attempt,
        createdAt: new Date().toISOString(),
        metadata: task.metadata,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return workspacePath;
}

export function experimentOutputDir(
  config: ResolvedBenchmarkConfig,
  experimentId: string,
): string {
  return path.join(config.runtime.outputDir, safeSegment(experimentId));
}

export function experimentManifestPath(
  config: ResolvedBenchmarkConfig,
  experimentId: string,
): string {
  return path.join(experimentOutputDir(config, experimentId), "manifest.json");
}

export function roundContextDirectory(workspacePath: string): string {
  return path.join(workspacePath, ".benchmark", "round-contexts");
}

export function roundContextPath(
  workspacePath: string,
  roundIndex: number,
  roundId: string,
): string {
  const sequence = String(roundIndex + 1).padStart(3, "0");
  return path.join(roundContextDirectory(workspacePath), `${sequence}-${safeSegment(roundId)}.json`);
}

export async function writeRoundContext(input: RoundContextWriteInput): Promise<string> {
  const contextPath = roundContextPath(
    input.workspacePath,
    input.roundRecord.roundIndex,
    input.roundRecord.roundId,
  );
  const promptContext = {
    task: input.task,
    model: input.model,
    workspacePath: input.workspacePath,
  };
  const contextBeforeRound: Array<{
    role: "user" | "assistant";
    roundIndex: number;
    roundId: string;
    content: string;
  }> = [];
  for (const prior of input.allRounds) {
    if (prior.roundIndex >= input.roundRecord.roundIndex) break;
    const definition = input.task.rounds[prior.roundIndex];
    contextBeforeRound.push({
      role: "user",
      roundIndex: prior.roundIndex,
      roundId: prior.roundId,
      content: renderRoundPrompt(definition?.prompt ?? prior.prompt, promptContext, prior.roundIndex),
    });
    if (prior.response !== null) {
      contextBeforeRound.push({
        role: "assistant",
        roundIndex: prior.roundIndex,
        roundId: prior.roundId,
        content: prior.response,
      });
    }
  }

  const renderedPrompt = renderRoundPrompt(
    input.round.prompt,
    promptContext,
    input.roundRecord.roundIndex,
  );
  await writeJsonAtomic(contextPath, {
    schemaVersion: 1,
    type: "game-generation-round-context",
    experimentId: input.run.experimentId,
    runId: input.run.id,
    attempt: input.run.attempt,
    task: {
      id: input.task.id,
      title: input.task.title,
      description: input.task.description ?? null,
      metadata: input.task.metadata,
    },
    model: {
      id: input.model.id,
      providerId: input.model.provider,
      modelId: input.model.modelName,
      model: input.model.model,
      agent: input.model.agent ?? input.config.opencode.agent,
      reasoningEffort: input.model.reasoningEffort ?? null,
    },
    round: {
      index: input.roundRecord.roundIndex,
      number: input.roundRecord.roundIndex + 1,
      id: input.roundRecord.roundId,
      status: input.roundRecord.status,
      timeoutMs: (input.round.timeoutMs ?? input.config.runtime.roundTimeoutMs) || null,
      idleTimeoutMs: input.config.runtime.roundIdleTimeoutMs || null,
      unlimited: (input.round.timeoutMs ?? input.config.runtime.roundTimeoutMs) <= 0,
      startedAt: toIsoString(input.roundRecord.startedAt),
      completedAt: toIsoString(input.roundRecord.completedAt),
      error: input.roundRecord.error,
    },
    paths: {
      workspace: input.workspacePath,
      contextFile: contextPath,
    },
    request: {
      systemPrompt: {
        benchmark: input.config.systemPrompt,
        model: input.model.systemPrompt ?? null,
        effective: buildEffectiveSystemPrompt(
          input.config.systemPrompt,
          input.model.systemPrompt,
        ),
      },
      userPrompt: {
        original: input.round.prompt,
        rendered: renderedPrompt,
      },
    },
    contextBeforeRound,
    currentTurn: {
      user: {
        role: "user",
        content: renderedPrompt,
      },
      assistant: input.roundRecord.response === null
        ? null
        : {
            role: "assistant",
            content: input.roundRecord.response,
          },
    },
    usage: input.usage ?? null,
    session: {
      id: input.sessionId,
      harness: input.config.runtime.harness,
      snapshotAfterRound: input.harnessContext ?? null,
    },
    savedAt: new Date().toISOString(),
  });
  return contextPath;
}

export async function writeAttemptResult(
  workspacePath: string,
  run: RunRecord,
  modelConfig: ModelConfig | undefined,
  rounds: RoundRecord[],
  status: string,
  error: string | null,
  willRetry = false,
): Promise<void> {
  const resultPath = path.join(workspacePath, ".benchmark", "result.json");
  await writeJsonAtomic(resultPath, {
    schemaVersion: 1,
    experimentId: run.experimentId,
    runId: run.id,
    taskId: run.taskId,
    taskTitle: run.taskTitle,
    modelId: run.modelId,
    model: `${run.providerId}/${run.modelName}`,
    reasoningEffort: modelConfig?.reasoningEffort ?? null,
    attempt: run.attempt,
    status,
    willRetry,
    sourceDirectory: workspacePath,
    sessionId: run.sessionId,
    startedAt: toIsoString(run.startedAt),
    completedAt: new Date().toISOString(),
    error,
    roundContextDirectory: existsSync(roundContextDirectory(workspacePath))
      ? roundContextDirectory(workspacePath)
      : null,
    rounds: rounds.map((round) => ({
      index: round.roundIndex,
      id: round.roundId,
      status: round.status,
      startedAt: toIsoString(round.startedAt),
      completedAt: toIsoString(round.completedAt),
      response: round.response,
      error: round.error,
      contextFile: existsSync(roundContextPath(workspacePath, round.roundIndex, round.roundId))
        ? roundContextPath(workspacePath, round.roundIndex, round.roundId)
        : null,
    })),
  });
}

export async function writeExperimentManifest(
  config: ResolvedBenchmarkConfig,
  experiment: ExperimentRecord,
  runs: RunRecord[],
  summary: ExperimentSummary,
): Promise<string> {
  const outputDir = experimentOutputDir(config, experiment.id);
  const manifestPath = experimentManifestPath(config, experiment.id);
  await mkdir(outputDir, { recursive: true });
  await writeJsonAtomic(manifestPath, {
    schemaVersion: 1,
    id: experiment.id,
    name: experiment.name,
    status: experiment.status,
    stageMode: experiment.stageMode,
    targetRound: experiment.targetRound,
    maxRounds: experiment.maxRounds,
    sourceDirectory: outputDir,
    createdAt: toIsoString(experiment.createdAt),
    startedAt: toIsoString(experiment.startedAt),
    completedAt: toIsoString(experiment.completedAt),
    updatedAt: new Date().toISOString(),
    summary,
    runs: runs.map((run) => {
      const model = config.models.find((item) => item.id === run.modelId);
      return {
        runId: run.id,
        taskId: run.taskId,
        taskTitle: run.taskTitle,
        modelId: run.modelId,
        model: `${run.providerId}/${run.modelName}`,
        reasoningEffort: model?.reasoningEffort ?? null,
        status: run.status,
        currentRound: run.currentRound,
        totalRounds: run.totalRounds,
        attempt: run.attempt,
        sourceDirectory: run.workspacePath,
        resultFile: run.workspacePath
          ? path.join(run.workspacePath, ".benchmark", "result.json")
          : null,
        roundContextDirectory: run.workspacePath
          && existsSync(roundContextDirectory(run.workspacePath))
            ? roundContextDirectory(run.workspacePath)
            : null,
        sessionId: run.sessionId,
        error: run.error,
        startedAt: toIsoString(run.startedAt),
        completedAt: toIsoString(run.completedAt),
      };
    }),
  });
  return manifestPath;
}

export function safeSegment(value: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "");
  const truncated = Array.from(normalized).slice(0, 120).join("").replace(/[\s.]+$/g, "");
  if (!truncated) return "item";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(truncated)) {
    return `${truncated}-item`;
  }
  return truncated;
}

export function gameDirectoryName(
  task: TaskDefinition,
  tasks: Iterable<TaskDefinition> = [task],
): string {
  const gameName = safeSegment(task.title);
  const collisionKey = gameName.toLocaleLowerCase();
  const hasCollision = Array.from(tasks).some((candidate) => (
    candidate.id !== task.id
    && safeSegment(candidate.title).toLocaleLowerCase() === collisionKey
  ));
  if (!hasCollision) return gameName;

  const suffix = `--${safeSegment(task.id)}`;
  const availableLength = Math.max(1, 120 - Array.from(suffix).length);
  const shortenedName = Array.from(gameName).slice(0, availableLength).join("").replace(/[\s.]+$/g, "") || "item";
  return `${shortenedName}${suffix}`;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function toIsoString(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}
