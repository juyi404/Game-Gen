import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBenchmarkConfig } from "../src/config.js";
import { BenchmarkDatabase } from "../src/database.js";
import { GenerationOrchestrator } from "../src/orchestrator.js";
import type {
  GenerationHarness,
  HarnessRoundResult,
  HarnessRunContext,
  RoundDefinition,
} from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generation orchestrator", () => {
  it("keeps rounds sequential while respecting global concurrency", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-run-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 3).map((model) => ({ ...model, concurrency: 2 }));
    loaded.tasks[0]!.rounds[0]!.prompt = "Build {{task.id}} with {{model.id}} in round {{round.index}} at {{workspace}}";
    loaded.config.runtime.globalConcurrency = 2;
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, loaded.tasks);
    const harness = new TrackingHarness();
    const orchestrator = new GenerationOrchestrator(db, experiment, loaded.config, loaded.tasks, harness);
    try {
      await orchestrator.start();
      const result = await orchestrator.waitForCompletion();
      const summary = db.getSummary(experiment.id);
      expect(result.status).toBe("completed");
      expect(summary.completed).toBe(6);
      expect(harness.maximumActive).toBe(2);
      const runs = db.listRuns(experiment.id);
      expect(runs).toHaveLength(loaded.tasks.length * loaded.config.models.length);
      for (const run of runs) {
        const expectedOrder = loaded.tasks
          .find((task) => task.id === run.taskId)!
          .rounds.map((_, index) => index);
        expect(harness.roundOrder.get(run.id)).toEqual(expectedOrder);
        expect(new Set(harness.roundSessions.get(run.id))).toEqual(new Set([harness.sessions.get(run.id)]));
        expect(run.workspacePath).not.toBeNull();
        expect(path.basename(path.dirname(path.dirname(run.workspacePath!)))).toBe(run.taskTitle);
        expect(path.basename(path.dirname(run.workspacePath!))).toBe(run.modelId);
        const result = JSON.parse(
          await readFile(path.join(run.workspacePath!, ".benchmark", "result.json"), "utf8"),
        ) as {
          status: string;
          sessionId: string;
          roundContextDirectory: string;
          rounds: Array<{ contextFile: string }>;
        };
        expect(result).toMatchObject({
          status: "completed",
          sessionId: harness.sessions.get(run.id),
        });
        expect(result.rounds).toHaveLength(expectedOrder.length);
        expect(result.roundContextDirectory).toBe(
          path.join(run.workspacePath!, ".benchmark", "round-contexts"),
        );
        for (const [roundIndex, roundResult] of result.rounds.entries()) {
          const context = JSON.parse(
            await readFile(roundResult.contextFile, "utf8"),
          ) as {
            round: {
              index: number;
              status: string;
              error: string | null;
              timeoutMs: number | null;
              idleTimeoutMs: number | null;
              unlimited: boolean;
            };
            request: { userPrompt: { original: string; rendered: string } };
            contextBeforeRound: Array<{ role: string; roundIndex: number; content: string }>;
            currentTurn: { assistant: { content: string } | null };
            usage: { input: number; output: number; reasoning: number; cost: number };
            session: { id: string; snapshotAfterRound: Record<string, unknown> };
          };
          expect(context.round).toMatchObject({
            index: roundIndex,
            status: "completed",
            error: null,
            timeoutMs: null,
            idleTimeoutMs: loaded.config.runtime.roundIdleTimeoutMs,
            unlimited: true,
          });
          expect(context.request.userPrompt.original).toBe(
            loaded.tasks.find((task) => task.id === run.taskId)!.rounds[roundIndex]!.prompt,
          );
          expect(context.request.userPrompt.rendered).not.toContain("{{");
          expect(context.currentTurn.assistant?.content).toBe(`round ${roundIndex}`);
          expect(context.usage).toEqual({
            input: roundIndex + 1,
            output: roundIndex + 2,
            reasoning: roundIndex + 3,
            cacheRead: 0,
            cacheWrite: 0,
            cost: roundIndex / 100,
          });
          expect(context.contextBeforeRound).toHaveLength(roundIndex * 2);
          if (roundIndex > 0) {
            expect(context.contextBeforeRound).toEqual(expect.arrayContaining([
              expect.objectContaining({
                role: "assistant",
                roundIndex: roundIndex - 1,
                content: `round ${roundIndex - 1}`,
              }),
            ]));
          }
          expect(context.session).toMatchObject({
            id: harness.sessions.get(run.id),
            snapshotAfterRound: {
              type: "tracking-harness",
              sessionId: harness.sessions.get(run.id),
              roundIndex,
            },
          });
        }
        expect(await readFile(path.join(run.workspacePath!, "index.html"), "utf8")).toContain(run.taskTitle);
      }
      const manifest = JSON.parse(
        await readFile(path.join(loaded.config.runtime.outputDir, experiment.id, "manifest.json"), "utf8"),
      ) as { status: string; runs: unknown[] };
      expect(manifest.status).toBe("completed");
      expect(manifest.runs).toHaveLength(runs.length);
    } finally {
      db.close();
    }
  });

  it("runs one manual stage at a time and resumes the same workspace and session", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-stages-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    loaded.config.runtime.stageMode = "manual";
    loaded.config.runtime.globalConcurrency = 1;
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const tasks = [loaded.tasks.find((task) => task.rounds.length === 3)!];
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, tasks);
    const harness = new TrackingHarness();
    try {
      expect(experiment).toMatchObject({
        stageMode: "manual",
        targetRound: 1,
        maxRounds: 3,
      });

      const firstStage = new GenerationOrchestrator(
        db,
        experiment,
        loaded.config,
        tasks,
        harness,
      );
      await firstStage.start();
      expect((await firstStage.waitForCompletion()).status).toBe("awaiting_stage");
      const firstRun = db.listRuns(experiment.id)[0]!;
      expect(firstRun).toMatchObject({
        status: "awaiting_stage",
        currentRound: 1,
        attempt: 1,
      });
      expect(db.getRounds(firstRun.id).map((round) => round.status)).toEqual([
        "completed", "pending", "pending",
      ]);
      const firstWorkspace = firstRun.workspacePath;
      const firstSession = firstRun.sessionId;

      const secondExperiment = db.advanceExperimentStage(experiment.id);
      const secondStage = new GenerationOrchestrator(
        db,
        secondExperiment,
        loaded.config,
        tasks,
        harness,
      );
      await secondStage.start();
      expect((await secondStage.waitForCompletion()).status).toBe("awaiting_stage");
      const secondRun = db.listRuns(experiment.id)[0]!;
      expect(secondRun).toMatchObject({
        status: "awaiting_stage",
        currentRound: 2,
        attempt: 1,
        workspacePath: firstWorkspace,
        sessionId: firstSession,
      });
      expect(harness.sessionStarts.get(firstRun.id)).toBe(1);
      expect(harness.roundOrder.get(firstRun.id)).toEqual([0, 1]);
      const secondRoundContext = JSON.parse(await readFile(
        path.join(firstWorkspace!, ".benchmark", "round-contexts", "002-gameplay-polish.json"),
        "utf8",
      )) as {
        contextBeforeRound: Array<{ role: string; roundIndex: number; content: string }>;
        session: { id: string };
      };
      expect(secondRoundContext.contextBeforeRound).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", roundIndex: 0, content: "round 0" }),
      ]));
      expect(secondRoundContext.session.id).toBe(firstSession);

      const thirdExperiment = db.advanceExperimentStage(experiment.id);
      const thirdStage = new GenerationOrchestrator(
        db,
        thirdExperiment,
        loaded.config,
        tasks,
        harness,
      );
      await thirdStage.start();
      expect((await thirdStage.waitForCompletion()).status).toBe("completed");
      const finalRun = db.listRuns(experiment.id)[0]!;
      expect(finalRun).toMatchObject({
        status: "completed",
        currentRound: 3,
        attempt: 1,
        workspacePath: firstWorkspace,
        sessionId: firstSession,
      });
      expect(harness.sessionStarts.get(firstRun.id)).toBe(1);
      expect(harness.roundOrder.get(firstRun.id)).toEqual([0, 1, 2]);
      expect(db.getRoundSummary(experiment.id)).toMatchObject({
        total: 3,
        completed: 3,
        pending: 0,
      });
      expect(JSON.parse(await readFile(
        path.join(firstWorkspace!, ".benchmark", "result.json"),
        "utf8",
      ))).toMatchObject({
        status: "completed",
        sessionId: firstSession,
        rounds: [
          { status: "completed" },
          { status: "completed" },
          { status: "completed" },
        ],
      });
    } finally {
      db.close();
    }
  });

  it("enforces global, provider, and per-model concurrency together", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-limits-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const baseTask = loaded.tasks[0]!;
    const tasks = Array.from({ length: 6 }, (_, index) => ({
      ...baseTask,
      id: `limit-task-${index + 1}`,
      title: `Limit task ${index + 1}`,
    }));
    loaded.config.models = [
      model("a-one", "provider-a", 1),
      model("a-two", "provider-a", 3),
      model("b-one", "provider-b", 2),
      model("c-one", "provider-c", 5),
    ];
    loaded.config.runtime.globalConcurrency = 4;
    loaded.config.runtime.providerConcurrency = {
      "provider-a": 2,
      "provider-b": 1,
      "provider-c": 5,
    };
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, tasks);
    const harness = new TrackingHarness(24);
    const orchestrator = new GenerationOrchestrator(db, experiment, loaded.config, tasks, harness);
    try {
      await orchestrator.start();
      await orchestrator.waitForCompletion();
      expect(db.getSummary(experiment.id)).toMatchObject({ completed: 24, failed: 0 });
      expect(harness.maximumActive).toBe(4);
      expect(harness.providerMaximum.get("provider-a")).toBe(2);
      expect(harness.providerMaximum.get("provider-b")).toBe(1);
      expect(harness.modelMaximum.get("a-one")).toBe(1);
      expect(harness.modelMaximum.get("a-two")).toBeLessThanOrEqual(3);
      expect(harness.modelMaximum.get("c-one")).toBeLessThanOrEqual(5);
    } finally {
      db.close();
    }
  });

  it("preserves a failed attempt when the next attempt succeeds", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-retry-artifacts-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    loaded.config.runtime.globalConcurrency = 1;
    loaded.config.runtime.maxAttempts = 2;
    loaded.config.runtime.retryBackoffMs = 1;
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const tasks = loaded.tasks.slice(0, 1);
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, tasks);
    const orchestrator = new GenerationOrchestrator(
      db,
      experiment,
      loaded.config,
      tasks,
      new RetryOnceHarness(),
    );
    try {
      await orchestrator.start();
      const completed = await orchestrator.waitForCompletion();
      expect(completed.status).toBe("completed");
      const run = db.listRuns(experiment.id)[0]!;
      expect(run.attempt).toBe(2);
      const runRoot = path.dirname(run.workspacePath!);
      const firstResult = JSON.parse(
        await readFile(path.join(runRoot, "attempt-1", ".benchmark", "result.json"), "utf8"),
      ) as { status: string; willRetry: boolean; rounds: Array<{ contextFile: string }> };
      const secondResult = JSON.parse(
        await readFile(path.join(runRoot, "attempt-2", ".benchmark", "result.json"), "utf8"),
      ) as { status: string; willRetry: boolean; rounds: Array<{ contextFile: string }> };
      expect(firstResult).toMatchObject({ status: "failed", willRetry: true });
      expect(secondResult).toMatchObject({ status: "completed", willRetry: false });
      const failedContext = JSON.parse(
        await readFile(firstResult.rounds[0]!.contextFile, "utf8"),
      ) as {
        attempt: number;
        round: { status: string; error: string };
        currentTurn: { assistant: null };
      };
      expect(failedContext).toMatchObject({
        attempt: 1,
        round: { status: "failed", error: "retry this attempt" },
        currentTurn: { assistant: null },
      });
      for (const round of secondResult.rounds) {
        const context = JSON.parse(await readFile(round.contextFile, "utf8")) as {
          attempt: number;
          round: { status: string };
        };
        expect(context).toMatchObject({ attempt: 2, round: { status: "completed" } });
      }
      expect(await readFile(path.join(runRoot, "attempt-1", "partial.txt"), "utf8")).toBe("kept");
      expect(await readFile(path.join(runRoot, "attempt-2", "index.html"), "utf8")).toContain("retry success");
    } finally {
      db.close();
    }
  });

  it("opens a global cooldown and preserves attempt budget for infrastructure failures", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-infrastructure-circuit-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const baseTask = loaded.tasks[0]!;
    const tasks = Array.from({ length: 6 }, (_, index) => ({
      ...baseTask,
      id: `outage-task-${index + 1}`,
      title: `Outage task ${index + 1}`,
    }));
    loaded.config.models = loaded.config.models.slice(0, 1).map((model) => ({
      ...model,
      concurrency: 2,
    }));
    loaded.config.runtime.globalConcurrency = 2;
    loaded.config.runtime.maxAttempts = 1;
    loaded.config.runtime.retryBackoffMs = 1;
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, tasks);
    const harness = new InfrastructureFailureHarness();
    const orchestrator = new GenerationOrchestrator(
      db,
      experiment,
      loaded.config,
      tasks,
      harness,
    );
    try {
      await orchestrator.start();
      await waitFor(() => harness.beginCalls === 2 && orchestrator.activeCount === 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(harness.beginCalls).toBe(2);
      expect(db.getSummary(experiment.id)).toMatchObject({ queued: 4, retrying: 2, failed: 0 });
      const attempted = db.listRuns(experiment.id).filter((run) => run.attempt === 1);
      expect(attempted).toHaveLength(2);
      expect(attempted.every((run) => run.maxAttempts === 1)).toBe(true);
      expect(attempted.every(
        (run) => db.getInfrastructureRetryState(run.id).attempts === 1,
      )).toBe(true);
      expect(db.listEvents({ experimentId: experiment.id }).some(
        (event) => event.type === "experiment.dispatch.cooldown",
      )).toBe(true);
    } finally {
      await orchestrator.shutdown();
      db.close();
    }
  });

  it("isolates a provider outage while healthy providers keep running", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-provider-circuit-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const baseTask = loaded.tasks[0]!;
    const tasks = Array.from({ length: 2 }, (_, index) => ({
      ...baseTask,
      id: `provider-task-${index + 1}`,
      title: `Provider task ${index + 1}`,
    }));
    loaded.config.models = [
      model("blocked-model", "provider-a", 2),
      model("healthy-model", "provider-b", 2),
    ];
    loaded.config.runtime.globalConcurrency = 2;
    loaded.config.runtime.maxAttempts = 1;
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, tasks);
    const orchestrator = new GenerationOrchestrator(
      db,
      experiment,
      loaded.config,
      tasks,
      new ProviderIsolationHarness(),
    );
    try {
      await orchestrator.start();
      await waitFor(() => db.getSummary(experiment.id).completed === 2);
      expect(db.getModelRunSummaries(experiment.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerId: "provider-b", completed: 2 }),
        expect.objectContaining({ providerId: "provider-a", completed: 0 }),
      ]));
      expect(db.listEvents({ experimentId: experiment.id }).some((event) =>
        event.type === "experiment.dispatch.cooldown" &&
        event.data.scope === "provider" &&
        event.data.providerId === "provider-a"
      )).toBe(true);
    } finally {
      await orchestrator.shutdown();
      db.close();
    }
  });

  it("pauses immediately on exhausted provider quota without burning attempt budgets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-provider-quota-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const baseTask = loaded.tasks[0]!;
    const tasks = Array.from({ length: 4 }, (_, index) => ({
      ...baseTask,
      id: `quota-task-${index + 1}`,
      title: `Quota task ${index + 1}`,
    }));
    loaded.config.models = loaded.config.models.slice(0, 1).map((item) => ({
      ...item,
      concurrency: 2,
    }));
    loaded.config.runtime.globalConcurrency = 2;
    loaded.config.runtime.maxAttempts = 5;
    loaded.config.runtime.retryBackoffMs = 1;
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, tasks);
    const orchestrator = new GenerationOrchestrator(
      db,
      experiment,
      loaded.config,
      tasks,
      new QuotaFailureHarness(),
    );
    try {
      await orchestrator.start();
      await waitFor(() => db.getExperiment(experiment.id)?.status === "paused" && orchestrator.activeCount === 0);
      expect(db.getSummary(experiment.id)).toMatchObject({
        queued: 2,
        retrying: 2,
        failed: 0,
      });
      const blockedRuns = db.listRuns(experiment.id).filter((run) => run.status === "retrying");
      expect(blockedRuns).toHaveLength(2);
      expect(blockedRuns.every((run) =>
        run.attempt === 1 &&
        run.resumePending &&
        run.workspacePath !== null &&
        run.sessionId !== null
      )).toBe(true);
      const events = db.listEvents({ experimentId: experiment.id });
      expect(events.filter((event) => event.type === "experiment.provider.blocked")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.provider.blocked")).toHaveLength(2);
      expect(events.some((event) => event.type === "run.retrying")).toBe(false);
    } finally {
      await orchestrator.shutdown();
      db.close();
    }
  });

  it("keeps filling concurrency when unknown finishes only require per-run continuation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-unknown-finish-refill-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const baseTask = loaded.tasks[0]!;
    const tasks = Array.from({ length: 2 }, (_, index) => ({
      ...baseTask,
      id: `unknown-finish-task-${index + 1}`,
      title: `Unknown finish task ${index + 1}`,
    }));
    loaded.config.models = loaded.config.models.slice(0, 1).map((item) => ({
      ...item,
      concurrency: 2,
    }));
    loaded.config.runtime.globalConcurrency = 2;
    loaded.config.runtime.maxAttempts = 1;
    loaded.config.runtime.retryBackoffMs = 1;
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, tasks);
    const orchestrator = new GenerationOrchestrator(
      db,
      experiment,
      loaded.config,
      tasks,
      new UnknownFinishOnceHarness(),
    );
    try {
      await orchestrator.start();
      expect((await orchestrator.waitForCompletion()).status).toBe("completed");
      expect(db.getSummary(experiment.id)).toMatchObject({ completed: 2, failed: 0, retrying: 0 });
      expect(db.listRuns(experiment.id).every((run) => run.attempt === 1)).toBe(true);
      const events = db.listEvents({ experimentId: experiment.id });
      expect(events.filter((event) => event.type === "run.continuation.retrying")).toHaveLength(2);
      expect(events.some((event) => event.type === "experiment.dispatch.cooldown")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("enforces the configured round hard timeout as a normal finite failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-round-timeout-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    loaded.tasks = loaded.tasks.slice(0, 1);
    loaded.config.runtime.globalConcurrency = 1;
    loaded.config.runtime.maxAttempts = 1;
    loaded.config.runtime.roundTimeoutMs = 25;
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, loaded.tasks);
    const orchestrator = new GenerationOrchestrator(
      db,
      experiment,
      loaded.config,
      loaded.tasks,
      new RoundTimeoutHarness(),
    );
    try {
      await orchestrator.start();
      const completed = await orchestrator.waitForCompletion();
      expect(completed.status).toBe("failed");
      expect(db.getSummary(experiment.id)).toMatchObject({ failed: 1, retrying: 0 });
      expect(db.listEvents({ experimentId: experiment.id }).some((event) =>
        event.type === "run.failed" && event.data.error === "轮次执行超过硬超时 25ms"
      )).toBe(true);
      expect(db.listEvents({ experimentId: experiment.id }).some((event) =>
        event.type === "run.infrastructure.retrying"
      )).toBe(false);
    } finally {
      db.close();
    }
  });

  it("waits for interrupted runs to finish writing before shutdown returns", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-shutdown-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    loaded.config.runtime.globalConcurrency = 1;
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const tasks = loaded.tasks.slice(0, 1);
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, tasks);
    const orchestrator = new GenerationOrchestrator(
      db,
      experiment,
      loaded.config,
      tasks,
      new SlowAbortHarness(),
    );
    try {
      await orchestrator.start();
      await waitFor(() => orchestrator.activeCount === 1);
      await orchestrator.shutdown();
      expect(orchestrator.activeCount).toBe(0);
      const run = db.listRuns(experiment.id)[0]!;
      expect(run.workspacePath).not.toBeNull();
      expect(JSON.parse(
        await readFile(path.join(run.workspacePath!, ".benchmark", "result.json"), "utf8"),
      )).toMatchObject({ status: "interrupted" });
    } finally {
      db.close();
    }
  });
});

class TrackingHarness implements GenerationHarness {
  active = 0;
  maximumActive = 0;
  roundOrder = new Map<string, number[]>();
  roundSessions = new Map<string, string[]>();
  sessions = new Map<string, string>();
  sessionStarts = new Map<string, number>();
  providerActive = new Map<string, number>();
  providerMaximum = new Map<string, number>();
  modelActive = new Map<string, number>();
  modelMaximum = new Map<string, number>();

  constructor(private readonly delayMs = 12) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async beginRun(context: HarnessRunContext): Promise<string> {
    const sessionId = `session-${context.run.id}`;
    this.sessions.set(context.run.id, sessionId);
    this.sessionStarts.set(context.run.id, (this.sessionStarts.get(context.run.id) ?? 0) + 1);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    increment(this.providerActive, context.run.providerId);
    increment(this.modelActive, context.run.modelId);
    recordMaximum(this.providerActive, this.providerMaximum, context.run.providerId);
    recordMaximum(this.modelActive, this.modelMaximum, context.run.modelId);
    return sessionId;
  }
  async executeRound(
    context: HarnessRunContext,
    sessionId: string,
    _round: RoundDefinition,
    roundIndex: number,
  ): Promise<HarnessRoundResult> {
    const order = this.roundOrder.get(context.run.id) ?? [];
    order.push(roundIndex);
    this.roundOrder.set(context.run.id, order);
    const sessions = this.roundSessions.get(context.run.id) ?? [];
    sessions.push(sessionId);
    this.roundSessions.set(context.run.id, sessions);
    if (roundIndex === 0) {
      await writeFile(
        path.join(context.workspacePath, "index.html"),
        `<title>${context.task.title}</title>`,
        "utf8",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (roundIndex === context.task.rounds.length - 1) {
      this.active -= 1;
      decrement(this.providerActive, context.run.providerId);
      decrement(this.modelActive, context.run.modelId);
    }
    return {
      response: `round ${roundIndex}`,
      usage: {
        input: roundIndex + 1,
        output: roundIndex + 2,
        reasoning: roundIndex + 3,
        cacheRead: 0,
        cacheWrite: 0,
        cost: roundIndex / 100,
      },
    };
  }
  async captureRoundContext(
    _context: HarnessRunContext,
    sessionId: string,
    _round: RoundDefinition,
    roundIndex: number,
  ): Promise<unknown> {
    return { type: "tracking-harness", sessionId, roundIndex };
  }
  async abortRun(): Promise<void> {}
}

class RetryOnceHarness implements GenerationHarness {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async beginRun(context: HarnessRunContext): Promise<string> {
    return `retry-session-${context.run.attempt}`;
  }
  async executeRound(
    context: HarnessRunContext,
    _sessionId: string,
    _round: RoundDefinition,
    roundIndex: number,
  ): Promise<HarnessRoundResult> {
    if (context.run.attempt === 1) {
      await writeFile(path.join(context.workspacePath, "partial.txt"), "kept", "utf8");
      throw new Error("retry this attempt");
    }
    if (roundIndex === 0) {
      await writeFile(path.join(context.workspacePath, "index.html"), "retry success", "utf8");
    }
    return { response: `round ${roundIndex}` };
  }
  async abortRun(): Promise<void> {}
}

class SlowAbortHarness implements GenerationHarness {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async beginRun(context: HarnessRunContext): Promise<string> {
    await writeFile(path.join(context.workspacePath, "index.html"), "shutdown test", "utf8");
    return `shutdown-session-${context.run.id}`;
  }
  async executeRound(context: HarnessRunContext): Promise<HarnessRoundResult> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      context.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(context.signal.reason);
      }, { once: true });
    });
    return { response: "unexpected completion" };
  }
  async abortRun(): Promise<void> {}
}

class InfrastructureFailureHarness implements GenerationHarness {
  beginCalls = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async beginRun(): Promise<string> {
    this.beginCalls += 1;
    throw new Error("fetch failed");
  }
  async executeRound(): Promise<HarnessRoundResult> {
    throw new Error("unexpected round execution");
  }
  async abortRun(): Promise<void> {}
  async releaseRun(): Promise<void> {}
}

class ProviderIsolationHarness implements GenerationHarness {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async beginRun(context: HarnessRunContext): Promise<string> {
    return `provider-session-${context.run.id}`;
  }
  async executeRound(context: HarnessRunContext): Promise<HarnessRoundResult> {
    if (context.run.providerId === "provider-a") {
      throw new Error("429 too many requests");
    }
    await writeFile(path.join(context.workspacePath, "index.html"), "healthy", "utf8");
    return { response: "healthy" };
  }
  async abortRun(): Promise<void> {}
  async releaseRun(): Promise<void> {}
}

class QuotaFailureHarness implements GenerationHarness {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async beginRun(context: HarnessRunContext): Promise<string> {
    return `quota-session-${context.run.id}`;
  }
  async executeRound(): Promise<HarnessRoundResult> {
    throw new Error(
      'APIError: Forbidden: {"error":{"message":"用户额度不足, 剩余额度: $-3.66","code":"insufficient_user_quota"}}',
    );
  }
  async abortRun(): Promise<void> {}
  async releaseRun(): Promise<void> {}
}

class UnknownFinishOnceHarness implements GenerationHarness {
  private readonly calls = new Map<string, number>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async beginRun(context: HarnessRunContext): Promise<string> {
    return `unknown-finish-session-${context.run.id}`;
  }
  async executeRound(context: HarnessRunContext): Promise<HarnessRoundResult> {
    const calls = (this.calls.get(context.run.id) ?? 0) + 1;
    this.calls.set(context.run.id, calls);
    if (calls === 1) {
      throw new Error("OpenCode 上游响应连续异常结束：finish=unknown，已在原会话续作 3 次");
    }
    await writeFile(path.join(context.workspacePath, "index.html"), "continued", "utf8");
    return { response: "continued successfully" };
  }
  async abortRun(): Promise<void> {}
  async releaseRun(): Promise<void> {}
}

class RoundTimeoutHarness implements GenerationHarness {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async beginRun(context: HarnessRunContext): Promise<string> {
    return `timeout-session-${context.run.id}`;
  }
  async executeRound(context: HarnessRunContext): Promise<HarnessRoundResult> {
    await new Promise<void>((resolve, reject) => {
      if (context.signal.aborted) {
        reject(context.signal.reason);
        return;
      }
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    });
    return { response: "unexpected completion" };
  }
  async abortRun(): Promise<void> {}
  async releaseRun(): Promise<void> {}
}

function model(id: string, provider: string, concurrency: number) {
  return {
    id,
    model: `${provider}/game-model`,
    provider,
    modelName: "game-model",
    enabled: true,
    concurrency,
  };
}

function increment(values: Map<string, number>, key: string): void {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function decrement(values: Map<string, number>, key: string): void {
  const next = (values.get(key) ?? 1) - 1;
  if (next === 0) values.delete(key);
  else values.set(key, next);
}

function recordMaximum(
  active: Map<string, number>,
  maximum: Map<string, number>,
  key: string,
): void {
  maximum.set(key, Math.max(maximum.get(key) ?? 0, active.get(key) ?? 0));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for orchestrator state");
}
