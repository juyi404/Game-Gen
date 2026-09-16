import { HarnessFailure } from "../src/domain/harness-failure.js";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadBenchmarkConfig } from "../src/config.js";
import { BenchmarkDatabase } from "../src/database.js";
import { GenerationOrchestrator } from "../src/orchestrator.js";
import { ExperimentConflictError, OrchestratorManager } from "../src/manager.js";
import { OpenCodeHarness } from "../src/harness/opencode.js";
import { MockHarness } from "../src/harness/mock.js";
import { prepareWorkspace } from "../src/workspace.js";
import type { GenerationHarness } from "../src/types.js";

const directories: string[] = [];
const databases: BenchmarkDatabase[] = [];
const running: Array<{ shutdown(): Promise<void> }> = [];

afterEach(async () => {
  for (const instance of running.splice(0)) await instance.shutdown();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    const relative = path.relative(tmpdir(), directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid test cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebench-recovery-"));
  directories.push(directory);
  const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
  loaded.config.models = loaded.config.models.slice(0, 1);
  loaded.tasks = loaded.tasks.slice(0, 1);
  loaded.config.runtime.outputDir = path.join(directory, "runs");
  loaded.config.runtime.dataDir = path.join(directory, "data");
  loaded.config.runtime.initialBuildSoftTimeoutMs = 1_000;
  loaded.config.runtime.maxAttempts = 3;
  const db = new BenchmarkDatabase(path.join(directory, "review.sqlite"));
  databases.push(db);
  const experiment = db.createExperiment(loaded.config, loaded.tasks);
  const run = db.claimRun(db.listRuns(experiment.id)[0]!.id)!;
  return { ...loaded, db, experiment, run };
}

function failingHarness(): GenerationHarness {
  return {
    start: async () => {}, stop: async () => {}, beginRun: async () => "new-session",
    executeRound: async () => { throw new HarnessFailure("provider currently unavailable", { kind: "infrastructure", retryable: true, scope: "provider" }); },
    abortRun: async () => {}, releaseRun: async () => {},
  };
}

it.each(["infrastructure", "incomplete", "artifact", "timeout", "execution"] as const)(
  "honors a non-OpenCode adapter's nonretryable %s failure without consuming further attempts",
  async (kind) => {
    const { db, config, tasks, experiment, run } = await fixture();
    config.runtime.initialBuildSoftTimeoutMs = 0;
    let calls = 0;
    const harness = failingHarness();
    harness.executeRound = async () => {
      calls += 1;
      throw new HarnessFailure("A localized diagnostic with no vendor keywords", {
        kind, retryable: false, ...(kind === "infrastructure" ? { scope: "engine" as const } : {}),
      });
    };
    const orchestrator = new GenerationOrchestrator(db, experiment, config, tasks, harness);
    running.push(orchestrator);
    await orchestrator.start();
    await orchestrator.waitForCompletion();
    expect(calls).toBe(1);
    expect(db.getRun(run.id)).toMatchObject({ status: "failed", attempt: 1 });
    expect(db.getInfrastructureRetryState(run.id).attempts).toBe(0);
    expect(db.listEvents({ experimentId: experiment.id }).some((event) => event.type === "experiment.dispatch.cooldown")).toBe(false);
  },
);

it.each(["provider", "engine", "legacy", "incomplete"] as const)(
  "restores %s recovery from persisted metadata without inspecting diagnostic text",
  async (fault) => {
    const { db, config, tasks, experiment, run } = await fixture();
    config.runtime.initialBuildSoftTimeoutMs = 0;
    db.recordInfrastructureFailure(run.id, Date.now(),
      fault === "provider" || fault === "engine" ? fault : undefined,
      fault === "incomplete" ? "incomplete" : "infrastructure");
    db.retryRun(run.id, 0, "Opaque translated diagnostic", { preserveProgress: true });
    const scopes: string[] = [];
    const harness = failingHarness();
    harness.checkInfrastructure = async (scope) => { scopes.push(scope); };
    harness.executeRound = async () => ({ response: "independent engine completed successfully" });
    const orchestrator = new GenerationOrchestrator(db, experiment, config, tasks, harness);
    running.push(orchestrator);
    await orchestrator.start();
    await orchestrator.waitForCompletion();
    expect(scopes).toEqual(fault === "incomplete" ? [] : [fault === "legacy" ? "engine" : fault]);
    const probeEvents = db.listEvents({ experimentId: experiment.id }).filter((event) => event.type === "experiment.dispatch.probing");
    expect(probeEvents).toHaveLength(fault === "incomplete" ? 0 : 1);
    expect(db.getRun(run.id)?.attempt).toBe(1);
    expect(db.getInfrastructureRetryState(run.id).attempts).toBe(0);
  },
);

async function waitFor(predicate: () => boolean): Promise<void> {
  // Date.now is deliberately mocked in budget tests; use a bounded iteration count.
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for recovery state");
}

it("does not stall unrelated runs when an incomplete response is waiting after restart", async () => {
  const { db, config, tasks } = await fixture();
  config.runtime.initialBuildSoftTimeoutMs = 0;
  const independentTasks = [tasks[0]!, { ...tasks[0]!, id: "independent-task" }];
  const experiment = db.createExperiment(config, independentTasks);
  const runs = db.listRuns(experiment.id);
  const interrupted = db.claimRun(runs.find((candidate) => candidate.taskId !== "independent-task")!.id)!;
  const independent = runs.find((candidate) => candidate.taskId === "independent-task")!;
  db.recordInfrastructureFailure(interrupted.id, Date.now(), undefined, "incomplete");
  db.retryRun(interrupted.id, 60_000, "opaque task-local interruption", { preserveProgress: true });
  const calls: string[] = [];
  const harness = failingHarness();
  harness.executeRound = async (context) => {
    calls.push(context.task.id);
    return { response: "independent run completed" };
  };
  const orchestrator = new GenerationOrchestrator(db, experiment, config, independentTasks, harness);
  running.push(orchestrator);
  await orchestrator.start();
  await waitFor(() => ["completed", "awaiting_stage"].includes(db.getRun(independent.id)!.status));
  expect(calls.every((taskId) => taskId === "independent-task")).toBe(true);
  expect(db.getRun(interrupted.id)).toMatchObject({ status: "retrying", attempt: 1 });
  expect(db.getInfrastructureRetryState(interrupted.id)).toMatchObject({ attempts: 1, kind: "incomplete" });
});

it("restores the original requirements and completed-stage background to a new session", async () => {
  const { db, run, config, tasks, experiment } = await fixture();
  const task = tasks[0]!;
  const workspacePath = await prepareWorkspace(config, experiment, run, task);
  db.updateRound(run.id, 0, "completed", { response: "preserved work" });
  db.updateRun(run.id, { status: "failed", workspacePath, sessionId: "previous-session" });
  db.resetFailedRun(run.id);
  const retried = db.claimRun(run.id)!;
  expect(retried.sessionId).toBeNull();
  const currentRound = { id: "polish", prompt: "Add exactly 17 levels for {{task.id}}" };
  let submitted = "";
  const client = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async ({ body }: { body: unknown }) => {
        submitted = JSON.stringify(body);
        throw new Error("stop after capturing outgoing prompt");
      },
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  } as unknown as OpencodeClient;
  const harness = new OpenCodeHarness(config.opencode, config.systemPrompt, {
    connect: async () => ({ client, server: null, url: "http://127.0.0.1:1" }),
  });
  await harness.start();
  try {
    await expect(harness.executeRound({
      run: retried, model: config.models[0]!, task, workspacePath,
      signal: new AbortController().signal, emit: () => {},
    }, "new-session", currentRound, 1)).rejects.toThrow("stop after capturing");
    expect(submitted).toContain(`Add exactly 17 levels for ${task.id}`);
    expect(submitted).toContain(JSON.stringify(task.rounds[0]!.prompt).slice(1, -1));
    expect(submitted).toContain("不要重新执行");
    expect(submitted).toContain("不要从零重建");
  } finally { await harness.stop(); }
});

it("allows stage 2 recovery after the initial-build deadline but still bounds a prolonged outage", async () => {
  const { db, run, config, tasks, experiment } = await fixture();
  db.updateRound(run.id, 0, "completed", { response: "stage 1 complete" });
  const clock = vi.spyOn(Date, "now").mockReturnValue(run.startedAt! + 100_000);
  const orchestrator = new GenerationOrchestrator(db, experiment, config, tasks, failingHarness());
  running.push(orchestrator);
  await orchestrator.start();
  await waitFor(() => orchestrator.activeCount === 0 && db.getRun(run.id)!.status !== "queued");
  expect(db.getRounds(run.id)[0]!.status).toBe("completed");
  expect(db.getRun(run.id)!.status).toBe("retrying");
  const firstFailure = db.getInfrastructureRetryState(run.id).firstFailedAt!;
  await orchestrator.shutdown();
  running.splice(running.indexOf(orchestrator), 1);
  clock.mockReturnValue(firstFailure + 30 * 60_000 + 1);
  const recovered = new GenerationOrchestrator(db, db.getExperiment(experiment.id)!, config, tasks, failingHarness());
  running.push(recovered);
  await recovered.start();
  expect((await recovered.waitForCompletion()).status).toBe("failed");
  expect(db.getRun(run.id)!.status).toBe("failed");
});

it("uses the renewed manual-retry budget in dispatch recovery and retains its terminal deadline", async () => {
  const { db, run, config, tasks, experiment } = await fixture();
  const workspacePath = await prepareWorkspace(config, experiment, run, tasks[0]!);
  db.updateRun(run.id, { status: "failed", workspacePath, sessionId: "previous-session" });
  const clock = vi.spyOn(Date, "now").mockReturnValue(run.startedAt! + 100_000);
  db.resetFailedRun(run.id);
  const renewedAt = db.getRun(run.id)!.initialBuildStartedAt!;
  const orchestrator = new GenerationOrchestrator(db, experiment, config, tasks, failingHarness());
  running.push(orchestrator);
  await orchestrator.start();
  await waitFor(() => orchestrator.activeCount === 0 && db.getRun(run.id)!.status !== "queued");
  expect(db.getRun(run.id)!.status).toBe("retrying");
  expect(db.getRun(run.id)!.startedAt).toBe(run.startedAt);
  await orchestrator.shutdown();
  running.splice(running.indexOf(orchestrator), 1);
  clock.mockReturnValue(Math.max(db.getRun(run.id)!.availableAt, renewedAt + 1_001));
  const recovered = new GenerationOrchestrator(db, db.getExperiment(experiment.id)!, config, tasks, failingHarness());
  running.push(recovered);
  await recovered.start();
  expect((await recovered.waitForCompletion()).status).toBe("failed");
  expect(db.getRun(run.id)!.initialBuildStartedAt).toBe(renewedAt);
});

it("rejects a retry without changing its state while a different experiment is active", async () => {
  const { db, run, config, tasks } = await fixture();
  db.updateRun(run.id, { status: "failed", error: "original failure" });
  db.updateExperimentStatus(run.experimentId, "failed", "original failure");
  const beforeRun = db.getRun(run.id);
  const beforeExperiment = db.getExperiment(run.experimentId);
  config.mock.delayMs = 10_000;
  const manager = new OrchestratorManager(db);
  running.push(manager);
  await manager.createAndStart(config, tasks);
  await expect(manager.retryRun(run.id)).rejects.toBeInstanceOf(ExperimentConflictError);
  expect(db.getRun(run.id)).toEqual(beforeRun);
  expect(db.getExperiment(run.experimentId)).toEqual(beforeExperiment);
});

it("rolls back run, rounds, retry counters and experiment state when retry startup fails", async () => {
  const { db, run } = await fixture();
  db.updateRun(run.id, { status: "failed", sessionId: "preserved-session", error: "original failure" });
  db.updateRound(run.id, 0, "failed", { response: "partial response", error: "original failure" });
  db.recordInfrastructureFailure(run.id);
  db.updateExperimentStatus(run.experimentId, "failed", "original failure");
  const before = {
    run: db.getRun(run.id), rounds: db.getRounds(run.id),
    experiment: db.getExperiment(run.experimentId), infra: db.getInfrastructureRetryState(run.id),
  };
  vi.spyOn(MockHarness.prototype, "start").mockRejectedValue(new Error("startup failed"));
  const manager = new OrchestratorManager(db);
  running.push(manager);
  await expect(manager.retryRun(run.id)).rejects.toThrow("startup failed");
  expect(db.getRun(run.id)).toEqual(before.run);
  expect(db.getRounds(run.id)).toEqual(before.rounds);
  expect(db.getExperiment(run.experimentId)).toEqual(before.experiment);
  expect(db.getInfrastructureRetryState(run.id)).toEqual(before.infra);
  expect(manager.activeExperimentId).toBeNull();
});

it("blocks concurrent lifecycle changes while an experiment is starting", async () => {
  const { db, run, config, tasks } = await fixture();
  db.updateRun(run.id, { status: "failed", error: "original failure" });
  const before = db.getRun(run.id);
  let release!: () => void;
  vi.spyOn(MockHarness.prototype, "start").mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  config.mock.delayMs = 10_000;
  const manager = new OrchestratorManager(db);
  running.push(manager);
  const starting = manager.createAndStart(config, tasks);
  try {
    await waitFor(() => Boolean(release));
    await expect(manager.retryRun(run.id)).rejects.toBeInstanceOf(ExperimentConflictError);
    expect(db.getRun(run.id)).toEqual(before);
  } finally {
    release();
    await starting;
  }
});
