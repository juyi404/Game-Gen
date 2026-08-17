import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localEntryReferences,
  validateGeneratedGameArtifacts,
} from "../src/generated-artifact.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("generated game artifact validation", () => {
  it("rejects the untouched workspace placeholder", async () => {
    const directory = await workspace();
    await writeFile(
      path.join(directory, "index.html"),
      "<title>Game Generation Workspace</title><main>Replace this page with the generated game.</main>",
      "utf8",
    );
    await expect(validateGeneratedGameArtifacts(directory)).rejects.toThrow("默认占位页");
  });

  it("rejects missing local entry resources", async () => {
    const directory = await workspace();
    await writeFile(
      path.join(directory, "index.html"),
      '<link rel="stylesheet" href="./styles.css"><main>Game</main><script type="module" src="./game.js"></script>',
      "utf8",
    );
    await writeFile(path.join(directory, "styles.css"), "body {}", "utf8");
    await expect(validateGeneratedGameArtifacts(directory)).rejects.toThrow("./game.js");
  });

  it("accepts complete local resources and ignores remote resources", async () => {
    const directory = await workspace();
    await mkdir(path.join(directory, "src"));
    await writeFile(
      path.join(directory, "index.html"),
      '<link href="https://fonts.example/game.css" rel="stylesheet"><link href="/src/game.css?v=1" rel="stylesheet"><main>Game</main><script src="/src/game.js#build"></script>',
      "utf8",
    );
    await writeFile(path.join(directory, "src", "game.css"), "body {}", "utf8");
    await writeFile(path.join(directory, "src", "game.js"), "window.game = true", "utf8");
    await expect(validateGeneratedGameArtifacts(directory)).resolves.toBeUndefined();
    expect(localEntryReferences(await import("node:fs/promises").then(
      ({ readFile }) => readFile(path.join(directory, "index.html"), "utf8"),
    ))).toEqual(["/src/game.css?v=1", "/src/game.js#build"]);
  });
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebench-artifact-"));
  temporaryDirectories.push(directory);
  return directory;
}
