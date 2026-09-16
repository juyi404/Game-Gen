import type { OpencodeClient } from "@opencode-ai/sdk";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelVerificationRecord, ModelVerificationRequest, ModelVerificationResult, PackyModelDefinition, PackyProviderConfig, ProviderCatalogItem } from "./contracts.js";
import { DIRECT_VERIFICATION_TTL_MS, MODEL_PROBE_FILE_SETTLE_MS, MODEL_PROBE_TIMEOUT_MS, OPENCODE_VERIFICATION_TTL_MS } from "./contracts.js";
import { delay, mapWithConcurrency, modelProbeError, modelVerificationKey, recordValue, waitForProbeMarker } from "./values.js";

export class ModelVerifier {
  private modelVerifications: Record<string, ModelVerificationRecord> = {};
  private loading: Promise<void> | null = null;
  constructor(
    private readonly getClient: () => OpencodeClient | null,
    private readonly listProviders: () => Promise<ProviderCatalogItem[]>,
    private readonly agent: string,
    private readonly stateDir?: string,
  ) {}

  async listModelVerifications(): Promise<ModelVerificationRecord[]> {
    await this.load();
    return Object.values(this.modelVerifications)
      .sort((left, right) => right.verifiedAt - left.verifiedAt);
  }

  async verifyModels(
    requests: ModelVerificationRequest[],
    force = false,
  ): Promise<ModelVerificationResult[]> {
    await this.load();
    const providers = await this.listProviders();
    const providerById = new Map(providers.map((provider) => [provider.id, provider]));
    const now = Date.now();
    const results = new Array<ModelVerificationResult>(requests.length);
    const pending: Array<{ index: number; request: ModelVerificationRequest }> = [];
    for (const [index, request] of requests.entries()) {
      const provider = providerById.get(request.providerId);
      const model = provider?.models.find((item) => item.id === request.modelId);
      const existing = this.modelVerifications[modelVerificationKey(request.providerId, request.modelId, request.reasoningEffort)];
      if (!provider) {
        results[index] = { ...request, ready: false, cached: false, error: "供应商不存在" };
      } else if (!model) {
        results[index] = { ...request, ready: false, cached: false, error: "模型不存在" };
      } else if (!model.toolCall) {
        results[index] = { ...request, ready: false, cached: false, error: "模型不支持工具调用" };
      } else if (!provider.connected) {
        results[index] = { ...request, ready: false, cached: false, error: "供应商尚未连接凭据" };
      } else if (!force && existing?.method === "opencode" && existing.expiresAt > now) {
        results[index] = { ...request, ready: true, cached: true, error: "", record: existing };
      } else {
        pending.push({ index, request });
      }
    }

    // Capability probes create real OpenCode sessions and write to the shared
    // OpenCode database. Keeping this lower than generation concurrency avoids
    // probe-only database contention while providers are being configured.
    const probed = await mapWithConcurrency(pending, 2, async ({ index, request }) => ({
      index,
      result: await this.probeModelThroughOpenCode(request),
    }));
    let changed = false;
    for (const { index, result } of probed) {
      results[index] = result;
      const key = modelVerificationKey(result.providerId, result.modelId, result.reasoningEffort);
      if (result.ready && result.record) this.modelVerifications[key] = result.record;
      else delete this.modelVerifications[key];
      changed = true;
    }
    if (changed) await this.persistModelVerifications();
    return results;
  }

  load(): Promise<void> {
    this.loading ??= this.loadRecords().catch((error) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  private async loadRecords(): Promise<void> {
    const statePath = this.modelVerificationsPath();
    if (!statePath) return;
    try {
      const raw = recordValue(JSON.parse(await readFile(statePath, "utf8")));
      const records = Array.isArray(raw.records) ? raw.records : [];
      this.modelVerifications = Object.fromEntries(records.flatMap((value) => {
        const record = recordValue(value);
        if (typeof record.providerId !== "string"
          || typeof record.modelId !== "string"
          || typeof record.verifiedAt !== "number"
          || typeof record.expiresAt !== "number"
          || !["direct", "opencode"].includes(String(record.method))) return [];
        // Older caches did not record the variant, even for non-default probes.
        if (record.method === "opencode" && raw.version !== 2) return [];
        if (record.reasoningEffort !== undefined && typeof record.reasoningEffort !== "string") return [];
        const normalized = {
          providerId: record.providerId,
          modelId: record.modelId,
          ...(typeof record.reasoningEffort === "string" && record.reasoningEffort
            ? { reasoningEffort: record.reasoningEffort } : {}),
          verifiedAt: record.verifiedAt,
          expiresAt: record.expiresAt,
          method: record.method as ModelVerificationRecord["method"],
          latencyMs: typeof record.latencyMs === "number" ? record.latencyMs : 0,
        } satisfies ModelVerificationRecord;
        return [[modelVerificationKey(normalized.providerId, normalized.modelId, normalized.reasoningEffort), normalized]];
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistModelVerifications(): Promise<void> {
    const statePath = this.modelVerificationsPath();
    if (!statePath) return;
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({
      version: 2,
      records: Object.values(this.modelVerifications),
    }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, statePath);
  }

  private modelVerificationsPath(): string | null {
    return this.stateDir ? path.join(this.stateDir, "model-verifications.json") : null;
  }

  async recordDirectVerifications(
    providerId: string,
    models: PackyModelDefinition[],
  ): Promise<void> {
    await this.load();
    const verifiedAt = Date.now();
    for (const model of models) {
      this.modelVerifications[modelVerificationKey(providerId, model.id)] = {
        providerId,
        modelId: model.id,
        verifiedAt,
        expiresAt: verifiedAt + DIRECT_VERIFICATION_TTL_MS,
        method: "direct",
        latencyMs: 0,
      };
    }
    await this.persistModelVerifications();
  }

  async migrateManagedAggregatorVerifications(providers: Readonly<Record<string, PackyProviderConfig>>): Promise<void> {
    await this.load();
    const verifiedAt = Date.now();
    let changed = false;
    for (const [providerId, config] of Object.entries(providers)) {
      for (const modelId of Object.keys(config.models ?? {})) {
        const key = modelVerificationKey(providerId, modelId);
        if (this.modelVerifications[key]) continue;
        this.modelVerifications[key] = {
          providerId,
          modelId,
          verifiedAt,
          expiresAt: verifiedAt + DIRECT_VERIFICATION_TTL_MS,
          method: "direct",
          latencyMs: 0,
        };
        changed = true;
      }
    }
    if (changed) await this.persistModelVerifications();
  }

  private async probeModelThroughOpenCode(
    request: ModelVerificationRequest,
  ): Promise<ModelVerificationResult> {
    const probeRoot = this.stateDir
      ? path.join(this.stateDir, "model-probes")
      : path.join(process.cwd(), ".gamebench", "model-probes");
    await mkdir(probeRoot, { recursive: true });
    const workspace = await mkdtemp(path.join(probeRoot, "probe-"));
    const markerName = "gamebench-model-probe.txt";
    const markerPath = path.join(workspace, markerName);
    const marker = randomUUID();
    const startedAt = Date.now();
    let sessionId: string | null = null;
    try {
      const client = this.getClient();
      if (!client) throw new Error("OpenCode 服务尚未启动");
      const session = await client.session.create({
        query: { directory: workspace },
        body: { title: `model probe · ${request.providerId}/${request.modelId}` },
        signal: AbortSignal.timeout(10_000),
        throwOnError: true,
      });
      sessionId = session.data.id;
      await client.session.prompt({
        path: { id: sessionId },
        query: { directory: workspace },
        body: {
          model: { providerID: request.providerId, modelID: request.modelId },
          agent: this.agent,
          system: "This is a model capability probe. Use the write tool exactly once as instructed. Do not inspect other files or perform any other action.",
          ...(request.reasoningEffort ? { variant: request.reasoningEffort } : {}),
          parts: [{
            type: "text",
            text: `Use the write tool to create ${markerName} in the current directory with exactly this content: ${marker}`,
          }],
        },
        signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
        throwOnError: true,
      });
      await waitForProbeMarker(markerPath, marker, MODEL_PROBE_FILE_SETTLE_MS);
      const verifiedAt = Date.now();
      const record = {
        providerId: request.providerId,
        modelId: request.modelId,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        verifiedAt,
        expiresAt: verifiedAt + OPENCODE_VERIFICATION_TTL_MS,
        method: "opencode",
        latencyMs: verifiedAt - startedAt,
      } satisfies ModelVerificationRecord;
      return { ...request, ready: true, cached: false, error: "", record };
    } catch (error) {
      return {
        ...request,
        ready: false,
        cached: false,
        error: modelProbeError(error),
      };
    } finally {
      const client = this.getClient();
      if (client && sessionId) {
        // A timed-out prompt may still be finishing its tool call in OpenCode.
        // Abort it before deleting the session so late message writes cannot
        // race the session cascade and trigger SQLite foreign-key failures.
        await client.session.abort({
          path: { id: sessionId },
          query: { directory: workspace },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
        await delay(250);
        await client.session.delete({
          path: { id: sessionId },
          query: { directory: workspace },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      }
      if (client) {
        await client.instance.dispose({
          query: { directory: workspace },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
