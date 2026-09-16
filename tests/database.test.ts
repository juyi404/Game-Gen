import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBenchmarkConfig } from "../src/config.js";
import { BenchmarkDatabase } from "../src/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("benchmark database", () => {
  it("migrates and persists infrastructure scopes independently of error messages", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-scopes-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "benchmark.sqlite");
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    let db = new BenchmarkDatabase(file);
    const experiment = db.createExperiment(loaded.config, loaded.tasks.slice(0, 1));
    const run = db.listRuns(experiment.id)[0]!;
    db.recordInfrastructureFailure(run.id, 1234, "provider");
    db.updateRun(run.id, { status: "retrying", error: "translated message without engine details" });
    db.close();
    db = new BenchmarkDatabase(file);
    expect(db.getInfrastructureRetryState(run.id)).toEqual({ attempts: 1, firstFailedAt: 1234, scope: "provider", kind: "infrastructure" });
    db.recordInfrastructureFailure(run.id, 5678, "engine");
    expect(db.getInfrastructureRetryState(run.id)).toEqual({ attempts: 2, firstFailedAt: 1234, scope: "engine", kind: "infrastructure" });
    db.clearInfrastructureFailures(run.id);
    expect(db.getInfrastructureRetryState(run.id)).toEqual({ attempts: 0, firstFailedAt: null, scope: null, kind: "infrastructure" });
    db.close();

    const old = new DatabaseSync(file);
    old.exec("ALTER TABLE runs DROP COLUMN infra_scope");
    old.exec("ALTER TABLE runs DROP COLUMN infra_failure_kind");
    old.exec("UPDATE runs SET infra_attempts = 2, infra_first_failed_at = 1234");
    old.close();
    db = new BenchmarkDatabase(file);
    try {
      expect(db.getInfrastructureRetryState(run.id)).toEqual({ attempts: 2, firstFailedAt: 1234, scope: null, kind: "infrastructure" });
      db.updateRun(run.id, { status: "failed" });
      db.recordInfrastructureFailure(run.id, 5678, "provider");
      const rollback = db.resetFailedRun(run.id);
      expect(db.getInfrastructureRetryState(run.id).scope).toBeNull();
      rollback();
      expect(db.getInfrastructureRetryState(run.id).scope).toBe("provider");
      db.recordInfrastructureFailure(run.id, 9000, undefined, "incomplete");
      expect(db.getInfrastructureRetryState(run.id)).toMatchObject({ kind: "incomplete", scope: null });
    } finally {
      db.close();
    }
  });

  it("persists the renewed budget across automatic retries and process recovery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-budget-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const filePath = path.join(directory, "benchmark.sqlite");
    let db = new BenchmarkDatabase(filePath);
    try {
      const experiment = db.createExperiment(loaded.config, loaded.tasks.slice(0, 1));
      const run = db.claimRun(db.listRuns(experiment.id)[0]!.id)!;
      expect(run.initialBuildStartedAt).toBe(1_000);
      db.updateRun(run.id, { status: "failed", workspacePath: directory, sessionId: "old-session" });
      clock.mockReturnValue(100_000);
      db.resetFailedRun(run.id);
      expect(db.claimRun(run.id)).toMatchObject({ startedAt: 1_000, initialBuildStartedAt: 100_000 });
      db.updateRun(run.id, { sessionId: "new-session" });
      clock.mockReturnValue(100_100);
      db.retryRun(run.id, 0, "HTTP 503", { preserveProgress: true });
      expect(db.claimRun(run.id)).toMatchObject({ initialBuildStartedAt: 100_000 });
      db.close();
      db = new BenchmarkDatabase(filePath);
      clock.mockReturnValue(100_200);
      db.recoverInterruptedRuns(experiment.id);
      expect(db.claimRun(run.id)).toMatchObject({
        startedAt: 1_000, initialBuildStartedAt: 100_000,
        sessionId: "new-session", resumePending: true,
      });
    } finally { db.close(); }
  });

  it("migrates existing databases without renewing an already-started build budget", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-budget-migration-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const filePath = path.join(directory, "benchmark.sqlite");
    const original = new BenchmarkDatabase(filePath);
    let runId: string;
    let startedAt: number | null;
    try {
      const experiment = original.createExperiment(loaded.config, loaded.tasks.slice(0, 1));
      const run = original.claimRun(original.listRuns(experiment.id)[0]!.id)!;
      runId = run.id;
      startedAt = run.startedAt;
    } finally { original.close(); }
    const legacy = new DatabaseSync(filePath);
    try { legacy.exec("ALTER TABLE runs DROP COLUMN initial_build_started_at"); }
    finally { legacy.close(); }
    const migrated = new BenchmarkDatabase(filePath);
    try {
      expect(migrated.getRun(runId)).toMatchObject({ startedAt, initialBuildStartedAt: startedAt });
    } finally { migrated.close(); }
  });

  it("creates the complete task by model matrix", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, loaded.tasks);
    const runs = db.listRuns(experiment.id);
    expect(runs).toHaveLength(loaded.tasks.length * loaded.config.models.length);
    expect(db.listRunnableRuns(experiment.id)).toHaveLength(runs.length);
    expect(db.listRunnableRuns(experiment.id, Date.now(), 3)).toHaveLength(3);
    expect(db.getSummary(experiment.id)).toMatchObject({ total: 10, queued: 10, completed: 0 });
    expect(db.getRounds(runs[0]!.id)).toHaveLength(loaded.tasks[0]!.rounds.length);
    const firstPage = db.listRunPage(experiment.id, { page: 1, pageSize: 1 });
    expect(firstPage).toMatchObject({ page: 1, pageSize: 1, totalTasks: 2, totalPages: 2, hasNextPage: true });
    expect(new Set(firstPage.runs.map((run) => run.taskId)).size).toBe(1);
    expect(firstPage.runs).toHaveLength(5);
    expect(firstPage.runs.every((run) => run.completedRounds === 0)).toBe(true);
    const laterTaskRun = runs.find((run) => run.taskId === loaded.tasks[1]!.id)!;
    db.updateRun(laterTaskRun.id, { status: "running" });
    const activeFirstPage = db.listRunPage(experiment.id, { page: 1, pageSize: 1 });
    expect(new Set(activeFirstPage.runs.map((run) => run.taskId))).toEqual(new Set([laterTaskRun.taskId]));
    const activeOrderedPage = db.listRunPage(experiment.id, { page: 1, pageSize: 2 });
    expect([...new Set(activeOrderedPage.runs.map((run) => run.taskId))][0]).toBe(laterTaskRun.taskId);
    const lastPage = db.listRunPage(experiment.id, { page: 2, pageSize: 1, status: "queued" });
    expect(lastPage.runs).toHaveLength(5);
    expect(lastPage.hasNextPage).toBe(false);
    db.close();
  });

  it("filters and paginates by model, matching status on that same model", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-model-filter-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    try {
      const experiment = db.createExperiment(loaded.config, loaded.tasks);
      const runs = db.listRuns(experiment.id);
      const first = runs[0]!;
      const other = runs.find((run) => run.taskId === first.taskId && run.modelId !== first.modelId)!;
      db.updateRun(other.id, { status: "failed" });
      expect(db.listRunPage(experiment.id, { status: "failed" }).totalTasks).toBe(1);
      expect(db.listRunPage(experiment.id, { modelId: first.modelId, status: "failed" }).totalTasks).toBe(0);
      const failed = db.listRunPage(experiment.id, { modelId: other.modelId, status: "failed" });
      expect(failed.runs.map((run) => run.id)).toEqual([other.id]);
      const page = db.listRunPage(experiment.id, { modelId: first.modelId, pageSize: 1, page: 2 });
      expect(page).toMatchObject({ page: 2, totalTasks: 2, totalPages: 2, hasNextPage: false });
      expect(page.runs).toHaveLength(1);
      expect(page.runs[0]!.modelId).toBe(first.modelId);
      expect(db.listRunPage(experiment.id, { modelId: first.modelId, search: first.taskId }).runs.map((run) => run.id)).toEqual([first.id]);
      expect(db.listRunPage(experiment.id, { modelId: "missing" }).totalTasks).toBe(0);
    } finally { db.close(); }
  });

  it("preserves and repairs completed stage meaning when an experiment is cancelled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-cancel-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.runtime.stageMode = "manual";
    const databasePath = path.join(directory, "benchmark.sqlite");
    let db = new BenchmarkDatabase(databasePath);
    const experiment = db.createExperiment(loaded.config, loaded.tasks);
    const [preservedRun, legacyRun] = db.listRuns(experiment.id);

    db.updateRound(preservedRun!.id, 0, "completed", { response: "done" });
    db.updateRun(preservedRun!.id, { status: "awaiting_stage", currentRound: 1 });
    db.updateExperimentStatus(experiment.id, "cancelled");
    db.cancelQueuedRuns(experiment.id);
    expect(db.getRun(preservedRun!.id)).toMatchObject({ status: "awaiting_stage", currentRound: 1 });

    db.updateRound(legacyRun!.id, 0, "completed", { response: "legacy done" });
    db.updateRun(legacyRun!.id, { status: "cancelled", currentRound: 1 });
    db.close();

    db = new BenchmarkDatabase(databasePath);
    expect(db.getRun(legacyRun!.id)).toMatchObject({ status: "awaiting_stage", currentRound: 1 });
    const page = db.listRunPage(experiment.id, { pageSize: 10 });
    expect(page.runs.find((run) => run.id === preservedRun!.id)?.completedRounds).toBe(1);
    expect(page.runs.find((run) => run.id === legacyRun!.id)?.completedRounds).toBe(1);
    expect(db.getSummary(experiment.id)).toMatchObject({ awaitingStage: 2, cancelled: 8 });
    db.close();
  });

  it("recovers an interrupted second stage without erasing the completed first stage", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-recovery-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    loaded.config.runtime.stageMode = "manual";
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, loaded.tasks.slice(0, 1));
    const initial = db.listRuns(experiment.id)[0]!;
    const claimed = db.claimRun(initial.id)!;
    expect(claimed.attempt).toBe(1);
    db.updateRound(initial.id, 0, "completed", { response: "stage one" });
    db.updateRound(initial.id, 1, "running");
    db.updateRun(initial.id, {
      status: "running",
      currentRound: 2,
      workspacePath: path.join(directory, "workspace"),
      sessionId: "persisted-session",
    });

    db.recoverInterruptedRuns(experiment.id);
    expect(db.getRun(initial.id)).toMatchObject({
      status: "queued",
      currentRound: 1,
      attempt: 1,
      workspacePath: path.join(directory, "workspace"),
      sessionId: "persisted-session",
    });
    expect(db.getRounds(initial.id)).toMatchObject([
      { status: "completed", response: "stage one" },
      { status: "pending", response: null, error: null },
    ]);
    expect(db.claimRun(initial.id)).toMatchObject({ attempt: 1, currentRound: 1 });
    db.close();
  });

  it("preserves completed rounds during a bounded infrastructure retry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-infra-retry-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, loaded.tasks.slice(0, 1));
    const run = db.listRuns(experiment.id)[0]!;
    db.claimRun(run.id);
    db.updateRound(run.id, 0, "completed", {
      response: "kept",
      usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, cost: 0.5 },
    });
    db.updateRound(run.id, 1, "failed", { error: "gateway down" });
    db.updateRun(run.id, {
      status: "running",
      currentRound: 2,
      workspacePath: path.join(directory, "workspace"),
      sessionId: "kept-session",
    });
    const failure = db.recordInfrastructureFailure(run.id, 1_000);
    expect(failure).toEqual({ attempts: 1, firstFailedAt: 1_000, scope: null, kind: "infrastructure" });
    db.retryRun(run.id, 0, "gateway down", { preserveProgress: true });
    expect(db.getRun(run.id)).toMatchObject({
      status: "retrying",
      currentRound: 1,
      attempt: 1,
      sessionId: "kept-session",
    });
    expect(db.getRounds(run.id)).toMatchObject([
      { status: "completed", response: "kept" },
      { status: "pending", response: null },
    ]);
    expect(db.claimRun(run.id)).toMatchObject({ attempt: 1, currentRound: 1 });
    expect(db.getUsageSummary(experiment.id)).toEqual({
      rounds: 1,
      input: 1,
      output: 2,
      reasoning: 3,
      cacheRead: 4,
      cacheWrite: 5,
      cost: 0.5,
    });
    for (let index = 2; index <= 4; index += 1) {
      db.recordInfrastructureFailure(run.id, 1_000 + index);
    }
    expect(db.getInfrastructureRetryState(run.id)).toEqual({
      attempts: 4,
      firstFailedAt: 1_000,
      scope: null, kind: "infrastructure",
    });
    db.close();
  });

  it("keeps the workspace session for a bounded in-place artifact repair", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-artifact-repair-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    try {
      const experiment = db.createExperiment(loaded.config, loaded.tasks.slice(0, 1));
      const run = db.listRuns(experiment.id)[0]!;
      db.claimRun(run.id);
      db.updateRun(run.id, {
        status: "running",
        currentRound: 1,
        workspacePath: path.join(directory, "partial-game"),
        sessionId: "artifact-repair-session",
      });
      db.updateRound(run.id, 0, "failed", { error: "external CDN" });

      db.retryRun(run.id, 0, "external CDN", { preserveSession: true });
      expect(db.getRun(run.id)).toMatchObject({
        status: "retrying",
        currentRound: 0,
        attempt: 1,
        resumePending: false,
        workspacePath: path.join(directory, "partial-game"),
        sessionId: "artifact-repair-session",
      });
      expect(db.getRounds(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "pending", response: null, error: null }),
      ]));
      expect(db.getRounds(run.id).every((round) => round.status === "pending")).toBe(true);
      expect(db.claimRun(run.id)).toMatchObject({
        attempt: 2,
        workspacePath: path.join(directory, "partial-game"),
        sessionId: "artifact-repair-session",
      });
    } finally {
      db.close();
    }
  });

  it("resumes an ordinary retry in place while consuming the attempt budget", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-in-place-retry-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    try {
      const experiment = db.createExperiment(loaded.config, loaded.tasks.slice(0, 1));
      const run = db.listRuns(experiment.id)[0]!;
      db.claimRun(run.id);
      const workspacePath = path.join(directory, "partial-game");
      db.updateRun(run.id, { status: "running", currentRound: 1, workspacePath, sessionId: "same-session" });
      db.updateRound(run.id, 0, "failed", { error: "temporary model error" });

      db.retryRun(run.id, 0, "temporary model error", {
        preserveProgress: true, preserveSession: true, incrementAttempt: true,
      });
      expect(db.getRun(run.id)).toMatchObject({
        status: "retrying", currentRound: 0, attempt: 2, resumePending: true,
        workspacePath, sessionId: "same-session",
      });
      expect(db.claimRun(run.id)).toMatchObject({
        attempt: 2, resumePending: true, workspacePath, sessionId: "same-session",
      });
    } finally {
      db.close();
    }
  });

  it("manually retries a failed run in its existing workspace without replaying completed rounds", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-manual-resume-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    try {
      const experiment = db.createExperiment(loaded.config, loaded.tasks.slice(0, 1));
      const run = db.listRuns(experiment.id)[0]!;
      db.claimRun(run.id);
      const workspacePath = path.join(directory, "partial-game");
      db.updateRun(run.id, {
        status: "failed",
        currentRound: 2,
        workspacePath,
        sessionId: "released-session",
      });
      db.updateRound(run.id, 0, "completed", { response: "keep me" });
      db.updateRound(run.id, 1, "failed", { error: "missing asset" });

      db.resetFailedRun(run.id);

      expect(db.getRun(run.id)).toMatchObject({
        status: "queued",
        currentRound: 1,
        attempt: 2,
        workspacePath,
        sessionId: null,
        resumePending: true,
      });
      expect(db.getRounds(run.id)[0]).toMatchObject({
        status: "completed",
        response: "keep me",
      });
      expect(db.getRounds(run.id)[1]).toMatchObject({
        status: "pending",
        response: null,
        error: null,
      });
      expect(db.claimRun(run.id)).toMatchObject({
        attempt: 2,
        workspacePath,
        resumePending: true,
      });
    } finally {
      db.close();
    }
  });

  it("dispatches preserved workspace resumes before untouched queued runs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-resume-priority-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, loaded.tasks.slice(0, 2));
    const [queued, resuming] = db.listRuns(experiment.id);
    db.claimRun(resuming!.id);
    db.updateRun(resuming!.id, {
      status: "running",
      workspacePath: path.join(directory, "partial-workspace"),
      sessionId: "partial-session",
    });
    db.retryRun(resuming!.id, 0, "resume partial generation", { preserveProgress: true });

    const runnable = db.listRunnableRuns(experiment.id);
    expect(runnable[0]).toMatchObject({ id: resuming!.id, resumePending: true });
    expect(runnable[1]).toMatchObject({ id: queued!.id, resumePending: false });
    db.close();
  });

  it("reports opened-stage progress separately and clears stale completion timestamps", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-progress-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.runtime.stageMode = "manual";
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    const experiment = db.createExperiment(loaded.config, loaded.tasks);
    const allRounds = db.getRoundSummary(experiment.id);
    const openedRounds = db.getRoundSummary(experiment.id, { openedOnly: true });
    expect(openedRounds.total).toBe(experiment.totalRuns);
    expect(openedRounds.total).toBeLessThan(allRounds.total);

    db.updateExperimentStatus(experiment.id, "cancelled");
    expect(db.getExperiment(experiment.id)?.completedAt).not.toBeNull();
    db.updateExperimentStatus(experiment.id, "running");
    expect(db.getExperiment(experiment.id)?.completedAt).toBeNull();
    db.close();
  });

  it("keeps event storage bounded and pages newest events without hiding truncation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-db-events-"));
    temporaryDirectories.push(directory);
    const previousExperimentLimit = process.env.GAMEBENCH_EVENT_RETENTION_PER_EXPERIMENT;
    const previousGlobalLimit = process.env.GAMEBENCH_EVENT_RETENTION_GLOBAL;
    process.env.GAMEBENCH_EVENT_RETENTION_PER_EXPERIMENT = "4";
    process.env.GAMEBENCH_EVENT_RETENTION_GLOBAL = "5";
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    if (previousExperimentLimit === undefined) delete process.env.GAMEBENCH_EVENT_RETENTION_PER_EXPERIMENT;
    else process.env.GAMEBENCH_EVENT_RETENTION_PER_EXPERIMENT = previousExperimentLimit;
    if (previousGlobalLimit === undefined) delete process.env.GAMEBENCH_EVENT_RETENTION_GLOBAL;
    else process.env.GAMEBENCH_EVENT_RETENTION_GLOBAL = previousGlobalLimit;
    const experiment = db.createExperiment(loaded.config, loaded.tasks.slice(0, 1));
    for (let index = 0; index < 8; index += 1) {
      db.appendEvent(experiment.id, null, `test.${index}`, "info", `event ${index}`);
    }
    db.pruneEvents(experiment.id);
    expect(db.listEvents({ experimentId: experiment.id, limit: 100 })).toHaveLength(4);
    const newest = db.listEventPage({ experimentId: experiment.id, newest: true, limit: 2 });
    expect(newest).toMatchObject({ hasMore: true });
    expect(newest.events.map((event) => event.message)).toEqual(["event 6", "event 7"]);
    const older = db.listEventPage({
      experimentId: experiment.id,
      newest: true,
      beforeId: newest.events[0]!.id,
      limit: 2,
    });
    expect(older.events.map((event) => event.message)).toEqual(["event 4", "event 5"]);
    expect(older.hasMore).toBe(false);
    db.close();
  });
});
