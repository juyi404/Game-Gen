import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("rejects pages without visible content or executable game scripts", async () => {
    const directory = await workspace();
    await writeFile(
      path.join(directory, "index.html"),
      "<!doctype html><html><head><title>Empty</title></head><body><!-- nothing --></body></html>",
      "utf8",
    );
    await expect(validateGeneratedGameArtifacts(directory)).rejects.toThrow("没有可见游戏内容");
  });

  it("rejects empty and syntactically invalid classic scripts", async () => {
    const directory = await workspace();
    await writeFile(
      path.join(directory, "index.html"),
      '<main>Game</main><script src="./game.js"></script>',
      "utf8",
    );
    await writeFile(path.join(directory, "game.js"), "const broken = ;", "utf8");
    await expect(validateGeneratedGameArtifacts(directory)).rejects.toThrow("JavaScript 语法错误");
  });

  it("checks common image, media, icon, and srcset references", async () => {
    const directory = await workspace();
    await writeFile(
      path.join(directory, "index.html"),
      '<link rel="icon" href="./icon.png"><main><img src="./hero.png" srcset="./hero-2x.png 2x"><video poster="./poster.png"><source src="./intro.mp4"></video></main>',
      "utf8",
    );
    await expect(validateGeneratedGameArtifacts(directory)).rejects.toThrow("icon.png");
    expect(localEntryReferences(await readFile(path.join(directory, "index.html"), "utf8")))
      .toEqual(["./icon.png", "./hero.png", "./hero-2x.png", "./poster.png", "./intro.mp4"]);
  });

  it.each(["inline", "external"])("rejects syntactically invalid %s module scripts", async (kind) => {
    const directory = await workspace();
    const code = "export const broken = ;";
    await writeFile(path.join(directory, "game.js"), code);
    await writeFile(path.join(directory, "index.html"), kind === "inline"
      ? `<canvas></canvas><script type="module">${code}</script>`
      : '<canvas></canvas><script type="module" src="./game.js"></script>');
    await expect(validateGeneratedGameArtifacts(directory)).rejects.toThrow("JavaScript 语法错误");
  });

  it("accepts module imports, exports and top-level await without executing the game", async () => {
    const directory = await workspace();
    await writeFile(path.join(directory, "index.html"), '<canvas></canvas><script type="module" src="./game.js"></script>');
    await writeFile(path.join(directory, "game.js"), [
      'import { value } from "./logic.js";',
      'export const result = await Promise.resolve(value);',
      'throw new Error("validation must not execute generated code");',
    ].join("\n"));
    await writeFile(path.join(directory, "logic.js"), "export const value = 17;");
    await expect(validateGeneratedGameArtifacts(directory)).resolves.toBeUndefined();
  });

  it("rejects remote executable scripts because previews cannot connect externally", async () => {
    const directory = await workspace();
    await writeFile(
      path.join(directory, "index.html"),
      '<main>Game</main><script src="https://cdn.example/game.js"></script>',
      "utf8",
    );
    await expect(validateGeneratedGameArtifacts(directory)).rejects.toThrow("外部脚本");
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

  it("ignores data URLs containing markup delimiters", async () => {
    const directory = await workspace();
    await writeFile(
      path.join(directory, "index.html"),
      `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><circle r='8'/></svg>"><main>Game</main><img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>">`,
      "utf8",
    );
    await expect(validateGeneratedGameArtifacts(directory)).resolves.toBeUndefined();
    expect(localEntryReferences(await readFile(path.join(directory, "index.html"), "utf8")))
      .toEqual([]);
  });
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebench-artifact-"));
  temporaryDirectories.push(directory);
  return directory;
}
