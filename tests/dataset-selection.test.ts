import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DatasetService } from "../src/application/datasets.js";
import { loadBenchmarkConfig } from "../src/config.js";

const hooks = vi.hoisted(() => ({ beforeRename: null as null | (() => Promise<void>) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith("dataset-model-selections.json")) await hooks.beforeRename?.();
    return fs.rename(...args);
  } };
});
const directories: string[] = [];
afterEach(async () => {
  hooks.beforeRename = null;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebench-selections-"));
  directories.push(directory);
  const { config } = await loadBenchmarkConfig(path.resolve("examples/benchmark.mock.json"));
  const options = { dataDir: directory, projectRoot: process.cwd(), outputDir: directory, opencode: config.opencode, dashboard: config.dashboard };
  const service = new DatasetService(options);
  const input = { name: "Test", files: [{ path: "a.json", content: JSON.stringify({ id: "a", rounds: ["test"] }) }] };
  const a = await service.importDataset(input), b = await service.importDataset(input);
  return { directory, options, service, a, b };
}
const selection = (id: string) => ({ models: [{ id, model: `provider/${id}`, enabled: true, concurrency: 1 }] });

it("serializes writes across datasets and preserves every selection after restart", async () => {
  const { options, service, a, b } = await fixture();
  vi.spyOn(Date, "now").mockReturnValue(123456789);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let renames = 0;
  hooks.beforeRename = async () => { renames++; entered(); await gate; };
  const first = service.saveDatasetModelSelection(a.id, selection("one"));
  await started;
  const second = service.saveDatasetModelSelection(b.id, selection("two"));
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(renames).toBe(1);
    expect(await service.listDatasetModelSelections()).toEqual({});
  } finally { release(); await Promise.all([first, second]); }
  const saved = await new DatasetService(options).listDatasetModelSelections();
  expect(saved[a.id]?.models[0]?.id).toBe("one");
  expect(saved[b.id]?.models[0]?.id).toBe("two");
});

it("keeps the previous saved state after a failed write and permits the next save", async () => {
  const { options, service, a, b } = await fixture();
  await service.saveDatasetModelSelection(a.id, selection("original"));
  hooks.beforeRename = async () => { throw new Error("disk unavailable"); };
  await expect(service.saveDatasetModelSelection(a.id, selection("lost"))).rejects.toThrow("disk unavailable");
  expect((await service.listDatasetModelSelections())[a.id]?.models[0]?.id).toBe("original");
  hooks.beforeRename = null;
  await service.saveDatasetModelSelection(b.id, selection("next"));
  const reloaded = await new DatasetService(options).listDatasetModelSelections();
  expect(reloaded[a.id]?.models[0]?.id).toBe("original");
  expect(reloaded[b.id]?.models[0]?.id).toBe("next");
});

it("shares initial reads with saves and retries loading after a malformed file is repaired", async () => {
  const { directory, options, service, a, b } = await fixture();
  await service.saveDatasetModelSelection(a.id, selection("existing"));
  const fresh = new DatasetService(options);
  const [loaded] = await Promise.all([fresh.listDatasetModelSelections(), fresh.saveDatasetModelSelection(b.id, selection("new"))]);
  expect(loaded[a.id]?.models[0]?.id).toBe("existing");
  const file = path.join(directory, "dataset-model-selections.json");
  const valid = await readFile(file, "utf8");
  await writeFile(file, "invalid-json");
  const broken = new DatasetService(options);
  await expect(broken.listDatasetModelSelections()).rejects.toThrow();
  await writeFile(file, valid);
  expect(Object.keys(await broken.listDatasetModelSelections())).toHaveLength(2);
});
