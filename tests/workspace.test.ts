import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBenchmarkConfig } from "../src/config.js";
import { BenchmarkDatabase } from "../src/database.js";
import type { TaskDefinition } from "../src/types.js";
import { gameDirectoryName, prepareWorkspace, safeSegment } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("workspace directory names", () => {
  it("uses the Unicode game title as the directory name", () => {
    const task = createTask("game-0002", "索尼克：超级巨星");

    expect(gameDirectoryName(task)).toBe("索尼克：超级巨星");
  });

  it("removes invalid filesystem characters and handles Windows reserved names", () => {
    expect(safeSegment("  游戏 / 特别版. ")).toBe("游戏 - 特别版");
    expect(safeSegment("CON")).toBe("CON-item");
  });

  it("adds the task id only when sanitized game names collide", () => {
    const first = createTask("game-0001", "同名/游戏");
    const second = createTask("game-0002", "同名\\游戏");

    expect(gameDirectoryName(first, [first, second])).toBe("同名-游戏--game-0001");
    expect(gameDirectoryName(second, [first, second])).toBe("同名-游戏--game-0002");
  });

  it("reuses an interrupted first-round workspace when its session is preserved", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-workspace-resume-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const task = loaded.tasks[0]!;
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    try {
      const experiment = db.createExperiment(loaded.config, [task]);
      const run = db.listRuns(experiment.id)[0]!;
      const existingWorkspace = path.join(
        loaded.config.runtime.outputDir,
        experiment.id,
        gameDirectoryName(task),
        run.modelId,
        "attempt-1",
      );
      await mkdir(existingWorkspace, { recursive: true });
      db.updateRun(run.id, {
        workspacePath: existingWorkspace,
        sessionId: "preserved-first-round-session",
        currentRound: 0,
      });

      const resumedRun = db.getRun(run.id)!;
      await expect(prepareWorkspace(
        loaded.config,
        experiment,
        resumedRun,
        task,
      )).resolves.toBe(existingWorkspace);
    } finally {
      db.close();
    }
  });

  it("reuses partial retry artifacts even when the previous session is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-workspace-partial-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
    loaded.config.models = loaded.config.models.slice(0, 1);
    loaded.config.runtime.outputDir = path.join(directory, "runs");
    loaded.config.runtime.dataDir = path.join(directory, "data");
    const task = loaded.tasks[0]!;
    const db = new BenchmarkDatabase(path.join(directory, "benchmark.sqlite"));
    try {
      const experiment = db.createExperiment(loaded.config, [task]);
      const run = db.listRuns(experiment.id)[0]!;
      const existingWorkspace = path.join(
        loaded.config.runtime.outputDir,
        experiment.id,
        gameDirectoryName(task),
        run.modelId,
        "attempt-1",
      );
      await mkdir(existingWorkspace, { recursive: true });
      db.updateRun(run.id, { workspacePath: existingWorkspace, sessionId: null });
      db.retryRun(run.id, 0, "resume partial workspace", { preserveProgress: true });
      const resumedRun = db.claimRun(run.id)!;

      await expect(prepareWorkspace(
        loaded.config,
        experiment,
        resumedRun,
        task,
      )).resolves.toBe(existingWorkspace);
    } finally {
      db.close();
    }
  });
});

function createTask(id: string, title: string): TaskDefinition {
  return {
    id,
    title,
    sourcePath: `${id}.json`,
    rounds: [{ id: "round-1", prompt: "build" }],
    metadata: {},
  };
}
