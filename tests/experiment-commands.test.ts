import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentCommands } from "../src/application/experiment-commands.js";
import { OrchestratorManager } from "../src/application/experiment-manager.js";
import { NotFoundError } from "../src/application/errors.js";
import { loadBenchmarkConfig } from "../src/config.js";
import { BenchmarkDatabase } from "../src/persistence/database.js";

const fixtures: Array<{ commands: ExperimentCommands; db: BenchmarkDatabase; directory: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.commands.shutdown();
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("application experiment commands", () => {
  it("runs and advances a staged experiment without HTTP orchestrating recovery", async () => {
    const f = await createFixture();
    const { experiment, orchestrator } = await f.commands.createFromConfig(f.config, f.tasks);
    expect((await orchestrator.waitForCompletion()).status).toBe("awaiting_stage");
    const firstRun = f.db.listRuns(experiment.id)[0]!;
    await f.commands.advanceStage(experiment.id);
    const next = f.manager.get(experiment.id)!;
    await next.waitForCompletion();
    const secondRun = f.db.getRun(firstRun.id)!;
    expect(secondRun.currentRound).toBe(2);
    expect(secondRun.sessionId).toBe(firstRun.sessionId);
    expect(secondRun.workspacePath).toBe(firstRun.workspacePath);
    expect(f.prepare).toHaveBeenCalledTimes(2);
  });

  it("leaves a failed run untouched when runtime preparation fails, then permits a retry", async () => {
    const f = await createFixture();
    const experiment = f.db.createExperiment(f.config, f.tasks);
    const run = f.db.listRuns(experiment.id)[0]!;
    f.db.updateRun(run.id, { status: "failed", error: "test failure" });
    const before = f.db.getRun(run.id);
    f.prepare.mockRejectedValueOnce(new Error("runtime unavailable"));
    await expect(f.commands.retryRun(run.id)).rejects.toThrow("runtime unavailable");
    expect(f.db.getRun(run.id)).toEqual(before);
    await f.commands.retryRun(run.id);
    await f.manager.get(experiment.id)!.waitForCompletion();
    expect(f.db.getRun(run.id)?.status).toBe("awaiting_stage");
  });

  it("checks missing records before preparing any runtime", async () => {
    const f = await createFixture();
    await expect(f.commands.retryRun("missing")).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.commands.advanceStage("missing")).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.commands.recoverExperiment("missing")).rejects.toBeInstanceOf(NotFoundError);
    expect(await f.commands.recoverLatestExperiment()).toBeNull();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("recovers the latest pending experiment through the same runtime preparation path", async () => {
    const f = await createFixture();
    const experiment = f.db.createExperiment(f.config, f.tasks);
    expect((await f.commands.recoverLatestExperiment())?.id).toBe(experiment.id);
    expect(f.prepare).toHaveBeenCalledOnce();
    await f.manager.get(experiment.id)!.waitForCompletion();
    expect(f.db.getExperiment(experiment.id)?.status).toBe("awaiting_stage");
  });
});

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebench-commands-"));
  const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
  loaded.config.models = loaded.config.models.slice(0, 1);
  loaded.config.runtime = {
    ...loaded.config.runtime, stageMode: "manual", globalConcurrency: 1,
    dataDir: path.join(directory, "data"), outputDir: path.join(directory, "runs"),
  };
  loaded.config.mock.delayMs = 1;
  loaded.config.mock.failTaskIds = [];
  const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
  const manager = new OrchestratorManager(db);
  const prepare = vi.fn(async (config: typeof loaded.config) => config);
  const commands = new ExperimentCommands(manager, prepare);
  const fixture = { directory, db, manager, commands, prepare, config: loaded.config, tasks: loaded.tasks.slice(0, 1) };
  fixtures.push(fixture);
  return fixture;
}
