import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBenchmarkConfig } from "../src/config.js";
import { BenchmarkDatabase } from "../src/database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("benchmark database", () => {
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
    db.close();
  });
});
