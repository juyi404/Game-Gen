import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBenchmarkConfig, loadTasks } from "../src/config.js";

describe("benchmark config", () => {
  it("loads tasks and expands the provider/model identifiers", async () => {
    const { config, tasks } = await loadBenchmarkConfig(
      path.resolve("examples/benchmark.mock.json"),
    );
    expect(config.runtime.harness).toBe("mock");
    expect(config.runtime.roundTimeoutMs).toBe(0);
    expect(config.models).toHaveLength(5);
    expect(config.models[0]).toMatchObject({
      provider: "openai",
      modelName: "gpt-5",
    });
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.rounds.length).toBeGreaterThan(1);
    expect(path.isAbsolute(config.runtime.outputDir)).toBe(true);
  });

  it("loads all games from one aggregate JSON file in source order", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-aggregate-"));
    try {
      await writeFile(path.join(directory, "all-games.json"), JSON.stringify({
        dataset: "Aggregate games",
        count: 2,
        games: [aggregateTask("game-0001", "First game"), aggregateTask("game-0002", "Second game")],
      }));

      const tasks = await loadTasks(directory);
      expect(tasks.map((task) => task.id)).toEqual(["game-0001", "game-0002"]);
      expect(tasks.map((task) => task.title)).toEqual(["First game", "Second game"]);
      expect(tasks.every((task) => task.rounds.length === 4)).toBe(true);
      expect(tasks[0]?.rounds.map((round) => round.id)).toEqual([
        "round-1", "round-2", "round-3", "round-4",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes legacy round timeouts to unlimited", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-unlimited-"));
    const tasksDirectory = path.join(directory, "tasks");
    try {
      await mkdir(tasksDirectory);
      await writeFile(path.join(tasksDirectory, "game.json"), JSON.stringify({
        id: "game-1",
        rounds: [{ prompt: "Build the game", timeoutMs: 60_000 }],
      }));
      const configPath = path.join(directory, "benchmark.json");
      await writeFile(configPath, JSON.stringify({
        version: 1,
        name: "Unlimited generation",
        dataset: { dir: "./tasks" },
        models: [{ id: "model", model: "provider/model" }],
        runtime: { harness: "mock", roundTimeoutMs: 1_800_000 },
      }));

      const { config, tasks } = await loadBenchmarkConfig(configPath);
      expect(config.runtime.roundTimeoutMs).toBe(0);
      expect(tasks[0]?.rounds[0]?.timeoutMs).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an aggregate JSON whose count does not match games", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gamebench-aggregate-invalid-"));
    try {
      await writeFile(path.join(directory, "all-games.json"), JSON.stringify({
        dataset: "Invalid aggregate",
        count: 3,
        games: [aggregateTask("game-0001", "First game")],
      }));
      await expect(loadTasks(directory)).rejects.toThrow("count 必须等于 games 数组长度");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function aggregateTask(id: string, title: string) {
  return {
    id,
    title,
    rounds: Array.from({ length: 4 }, (_, index) => ({
      id: `round-${index + 1}`,
      prompt: `${title} prompt ${index + 1}`,
    })),
    metadata: { source: "aggregate-test" },
  };
}
