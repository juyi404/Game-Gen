import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PackyProviderConfig } from "./contracts.js";
import { recordValue } from "./values.js";

type ProviderKind = "packy" | "aggregator";

/** Owns managed provider metadata. Credentials remain in OpenCode's auth store. */
export class ManagedProviderStore {
  private readonly providers: Record<ProviderKind, Record<string, PackyProviderConfig>> = {
    packy: {}, aggregator: {},
  };
  private loading: Promise<void> | null = null;

  constructor(private readonly stateDir?: string) {}

  load(): Promise<void> {
    this.loading ??= Promise.all([this.loadKind("packy"), this.loadKind("aggregator")])
      .then(() => undefined)
      .catch((error) => { this.loading = null; throw error; });
    return this.loading;
  }

  get(kind: ProviderKind): Readonly<Record<string, PackyProviderConfig>> {
    return this.providers[kind];
  }

  set(kind: ProviderKind, providerId: string, config: PackyProviderConfig): void {
    this.providers[kind][providerId] = config;
  }

  async persist(kind: ProviderKind): Promise<void> {
    const statePath = this.statePath(kind);
    if (!statePath) return;
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({
      version: 1,
      providers: this.providers[kind],
    }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, statePath);
  }

  private async loadKind(kind: ProviderKind): Promise<void> {
    const statePath = this.statePath(kind);
    if (!statePath) return;
    try {
      const raw = recordValue(JSON.parse(await readFile(statePath, "utf8")));
      this.providers[kind] = Object.fromEntries(
        Object.entries(recordValue(raw.providers)).filter((entry): entry is [string, PackyProviderConfig] =>
          (kind !== "aggregator" || entry[0].startsWith("aggregate-"))
          && Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1])),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private statePath(kind: ProviderKind): string | null {
    return this.stateDir ? path.join(this.stateDir, `${kind}-providers.json`) : null;
  }
}
