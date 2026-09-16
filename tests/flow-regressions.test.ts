import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBenchmarkConfig } from "../src/config.js";
import { OrchestratorManager } from "../src/application/experiment-manager.js";
import { GenerationOrchestrator } from "../src/execution/orchestrator.js";
import { MockHarness } from "../src/harness/mock.js";
import { BenchmarkDatabase } from "../src/persistence/database.js";

const directories: string[] = [];
const databases: BenchmarkDatabase[] = [];
const running: Array<{ shutdown(): Promise<void> }> = [];
afterEach(async () => {
  for (const instance of running.splice(0)) await instance.shutdown();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebench-flows-"));
  directories.push(directory);
  const { config, tasks } = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
  config.models = config.models.slice(0, 1);
  config.runtime = { ...config.runtime, stageMode: "manual", outputDir: path.join(directory, "runs"), dataDir: directory };
  config.mock = { delayMs: 1, failTaskIds: [] };
  const db = new BenchmarkDatabase(path.join(directory, "state.sqlite"));
  databases.push(db);
  const task = { ...tasks[0]!, rounds: tasks[0]!.rounds.slice(0, 2) };
  return { directory, config, tasks: [task], db };
}

describe("lifecycle regression coverage", () => {
  it.each([false, true])("waits for finalization during shutdown (stop failure: %s)", async (stopFails) => {
    const { config, tasks, db } = await fixture();
    const experiment = db.createExperiment(config, tasks);
    const run = db.listRuns(experiment.id)[0]!;
    db.updateRun(run.id, { status: "completed", currentRound: run.totalRounds });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = new MockHarness(config.mock);
    const stop = vi.spyOn(harness, "stop").mockImplementation(async () => {
      await gate;
      if (stopFails) throw new Error("stop failed");
    });
    const orchestrator = new GenerationOrchestrator(db, experiment, config, tasks, harness);
    running.push(orchestrator);
    let closed = false;
    try {
      await orchestrator.start();
      expect(orchestrator.isSettled).toBe(false);
      const shutdown = orchestrator.shutdown().then(() => { closed = true; });
      const concurrentShutdown = orchestrator.shutdown();
      await Promise.resolve();
      expect(closed).toBe(false);
      release();
      await Promise.all([shutdown, concurrentShutdown]);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(orchestrator.isSettled).toBe(true);
      expect(db.getExperiment(experiment.id)?.status).toBe(stopFails ? "failed" : "completed");
      const manifest = JSON.parse(await readFile(path.join(config.runtime.outputDir, experiment.id, "manifest.json"), "utf8"));
      expect(manifest.status).toBe(stopFails ? "failed" : "completed");
    } finally { release(); await orchestrator.waitForCompletion(); }
  });

  it("does not advance the stage when its configuration cannot be loaded", async () => {
    const { directory, config, tasks, db } = await fixture();
    config.sourcePath = path.join(directory, "missing.json");
    const experiment = db.createExperiment(config, tasks);
    db.updateExperimentStatus(experiment.id, "awaiting_stage");
    const before = db.getExperiment(experiment.id);
    const manager = new OrchestratorManager(db);
    running.push(manager);
    await expect(manager.advanceStage(experiment.id)).rejects.toThrow();
    expect(db.getExperiment(experiment.id)).toEqual(before);
    expect(manager.activeExperimentId).toBeNull();
  });

  it("restores a failed stage startup and allows the same next stage to be retried", async () => {
    const { config, tasks, db } = await fixture();
    const manager = new OrchestratorManager(db);
    running.push(manager);
    const { experiment, orchestrator } = await manager.createAndStart(config, tasks);
    await orchestrator.waitForCompletion();
    const before = db.getExperiment(experiment.id);
    const runsBefore = db.listRuns(experiment.id);
    expect(before).toMatchObject({ status: "awaiting_stage", targetRound: 1 });
    vi.spyOn(MockHarness.prototype, "start").mockRejectedValueOnce(new Error("startup failed"));
    await expect(manager.advanceStage(experiment.id)).rejects.toThrow("startup failed");
    expect(db.getExperiment(experiment.id)).toEqual(before);
    expect(db.listRuns(experiment.id)).toEqual(runsBefore);
    expect(manager.activeExperimentId).toBeNull();
    const manifest = JSON.parse(await readFile(path.join(config.runtime.outputDir, experiment.id, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ status: "awaiting_stage", targetRound: 1 });
    const next = await manager.advanceStage(experiment.id);
    expect(await next.waitForCompletion()).toMatchObject({ status: "completed", targetRound: 2 });
  });
});
