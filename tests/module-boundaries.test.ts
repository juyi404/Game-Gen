import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve("src");
const files = readdirSync(root, { recursive: true })
  .map(String).filter((file) => /\.(ts|js)$/u.test(file))
  .map((file) => path.join(root, file));
const graph = new Map(files.map((file) => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const dependencies: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      dependencies.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      dependencies.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [file, dependencies.filter((specifier) => specifier.startsWith(".")).map((specifier) => {
    const resolved = path.resolve(path.dirname(file), specifier);
    return files.includes(resolved) ? resolved : resolved.replace(/\.js$/u, ".ts");
  })];
}));

const relative = (file: string) => path.relative(root, file).replaceAll("\\", "/");

describe("module boundaries", () => {
  it("resolves local imports without dependency cycles, including type and lazy imports", () => {
    const complete = new Set<string>();
    function visit(file: string, ancestors: string[]): void {
      expect(ancestors.includes(file), [...ancestors, file].map(relative).join(" -> ")).toBe(false);
      if (complete.has(file)) return;
      expect(graph.has(file), relative(file)).toBe(true);
      for (const dependency of graph.get(file)!) visit(dependency, [...ancestors, file]);
      complete.add(file);
    }
    for (const file of files) visit(file, []);
  });

  it("keeps domain, persistence and adapters independent of application and HTTP entry points", () => {
    for (const [file, dependencies] of graph) {
      const owner = relative(file).split("/")[0]!;
      for (const dependency of dependencies) {
        const target = relative(dependency);
        if (owner === "domain") expect(target.startsWith("domain/"), `${relative(file)} -> ${target}`).toBe(true);
        if (["persistence", "providers", "runtime", "harness", "execution", "artifacts"].includes(owner)) {
          expect(target, relative(file)).not.toMatch(/^(application|server)\//u);
        }
        if (relative(file).startsWith("server/routes/")) {
          expect(target, relative(file)).not.toMatch(/^(execution\/|application\/experiment-manager\.ts$)/u);
        }
        if (relative(file).includes("/") && !relative(file).startsWith("public/")) {
          expect(target, relative(file)).not.toMatch(/^(types|database|manager|orchestrator|workspace|opencode-service|opencode-runtime|generated-artifact|generation-budget|control-plane)\.ts$/u);
        }
      }
    }
  });

  it("keeps browser state, selectors and effects below page controllers and feature views", () => {
    for (const [file, dependencies] of graph) {
      if (!relative(file).startsWith("public/modules/")) continue;
      const name = path.basename(file);
      const allowed = new Set(["format.js", "state.js", "setup-selectors.js"]);
      // State ownership and pure selectors cannot acquire API, DOM or controller dependencies.
      if (["format.js", "state.js", "setup-store.js"].includes(name)) allowed.clear();
      if (name === "setup-selectors.js") allowed.delete("setup-selectors.js");
      for (const dependency of dependencies) {
        expect(relative(dependency).startsWith("public/modules/"), relative(file)).toBe(true);
        expect(allowed.has(path.basename(dependency)), `${relative(file)} -> ${relative(dependency)}`).toBe(true);
      }
    }
  });
});
