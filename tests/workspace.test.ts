import { describe, expect, it } from "vitest";
import type { TaskDefinition } from "../src/types.js";
import { gameDirectoryName, safeSegment } from "../src/workspace.js";

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
