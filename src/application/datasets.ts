import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadTasks } from "../config.js";
import type { ControlPlaneOptions } from "./contracts.js";
import { InputError } from "./errors.js";
import { safeUploadPath } from "./paths.js";
import type { DatasetModelSelection, DatasetSummary } from "./schemas.js";
import { datasetDraftModelSchema, datasetImportSchema, datasetModelSelectionInputSchema, identifierSchema, manifestSchema } from "./schemas.js";

export class DatasetService {
  readonly datasetsDir: string;
  private datasetModelSelections: Record<string, DatasetModelSelection> = {};
  private loadingSelections: Promise<void> | null = null;
  private selectionWrites: Promise<void> = Promise.resolve();

  constructor(readonly options: ControlPlaneOptions) {
    this.datasetsDir = path.join(options.dataDir, "datasets");
  }

  async initialize(): Promise<void> {
    await mkdir(this.datasetsDir, { recursive: true });
  }

  async listDatasets(): Promise<DatasetSummary[]> {
    await this.initialize();
    const entries = await readdir(this.datasetsDir, { withFileTypes: true });
    const datasets: DatasetSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.endsWith(".uploading")) continue;
      const manifestPath = path.join(this.datasetsDir, entry.name, ".dataset.json");
      if (!existsSync(manifestPath)) continue;
      const raw = JSON.parse(await readFile(manifestPath, "utf8"));
      datasets.push(manifestSchema.parse(raw));
    }
    return datasets.sort((left, right) => right.createdAt - left.createdAt);
  }

  async listDatasetModelSelections(): Promise<Record<string, DatasetModelSelection>> {
    await this.loadDatasetModelSelections();
    return structuredClone(this.datasetModelSelections);
  }

  async saveDatasetModelSelection(
    datasetId: string,
    input: unknown,
  ): Promise<DatasetModelSelection> {
    if (!identifierSchema.safeParse(datasetId).success
      || !existsSync(path.join(this.datasetsDir, datasetId, ".dataset.json"))) {
      throw new InputError("所选题库不存在");
    }
    const parsed = datasetModelSelectionInputSchema.parse(input);
    const enabledIds = parsed.models
      .filter((model) => model.enabled && model.id.length > 0)
      .map((model) => model.id);
    if (new Set(enabledIds).size !== enabledIds.length) throw new InputError("模型显示名称不能重复");
    // All datasets share one file, so serialize the entire read/modify/write.
    const write = this.selectionWrites.then(async () => {
      await this.loadDatasetModelSelections();
      const selection = { datasetId, models: parsed.models, updatedAt: Date.now() };
      const selections = { ...this.datasetModelSelections, [datasetId]: selection };
      await this.persistDatasetModelSelections(selections);
      this.datasetModelSelections = selections;
      return structuredClone(selection);
    });
    this.selectionWrites = write.then(() => undefined, () => undefined);
    return write;
  }

  async importDataset(input: unknown): Promise<DatasetSummary> {
    const parsed = datasetImportSchema.parse(input);
    await this.initialize();
    const id = randomUUID();
    const temporaryDir = path.join(this.datasetsDir, `${id}.uploading`);
    const finalDir = path.join(this.datasetsDir, id);
    const seenPaths = new Set<string>();
    let totalBytes = 0;

    await mkdir(temporaryDir, { recursive: false });
    try {
      for (const file of parsed.files) {
        const relativePath = safeUploadPath(file.path);
        if (seenPaths.has(relativePath)) throw new InputError(`上传文件路径重复: ${relativePath}`);
        seenPaths.add(relativePath);
        const content = file.content.replace(/^\uFEFF/, "");
        totalBytes += Buffer.byteLength(content);
        const target = path.join(temporaryDir, ...relativePath.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }

      const tasks = await loadTasks(temporaryDir, [], { references: "forbid" });
      const summary: DatasetSummary = {
        id,
        name: parsed.name,
        createdAt: Date.now(),
        fileCount: parsed.files.length,
        taskCount: tasks.length,
        roundCount: tasks.reduce((total, task) => total + task.rounds.length, 0),
        totalBytes,
        preview: tasks.slice(0, 8).map((task) => ({
          id: task.id,
          title: task.title,
          rounds: task.rounds.length,
        })),
      };
      await writeFile(
        path.join(temporaryDir, ".dataset.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryDir, finalDir);
      return summary;
    } catch (error) {
      await rm(temporaryDir, { recursive: true, force: true });
      throw error;
    }
  }

  private loadDatasetModelSelections(): Promise<void> {
    this.loadingSelections ??= this.readDatasetModelSelections().catch((error) => {
      this.loadingSelections = null;
      throw error;
    });
    return this.loadingSelections;
  }

  private async readDatasetModelSelections(): Promise<void> {
    const statePath = path.join(this.options.dataDir, "dataset-model-selections.json");
    try {
      const raw = JSON.parse(await readFile(statePath, "utf8")) as { selections?: unknown };
      const selections = raw && typeof raw === "object" && raw.selections
        && typeof raw.selections === "object" && !Array.isArray(raw.selections)
        ? raw.selections as Record<string, unknown>
        : {};
      this.datasetModelSelections = Object.fromEntries(Object.entries(selections).flatMap(([datasetId, value]) => {
        const parsed = z.object({
          datasetId: identifierSchema,
          updatedAt: z.number(),
          models: z.array(datasetDraftModelSchema).max(100),
        }).safeParse(value);
        return parsed.success && parsed.data.datasetId === datasetId ? [[datasetId, parsed.data]] : [];
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistDatasetModelSelections(selections: Record<string, DatasetModelSelection>): Promise<void> {
    const statePath = path.join(this.options.dataDir, "dataset-model-selections.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, selections }, null, 2)}\n`, "utf8");
      await rename(temporaryPath, statePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
