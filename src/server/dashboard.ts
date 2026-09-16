import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { InputError, type ControlPlane } from "../control-plane.js";
import type { BenchmarkDatabase } from "../database.js";
import { StageAdvanceError, type OrchestratorManager } from "../manager.js";
import { RUN_STATUSES, type ExperimentRecord, type GenerationEvent, type RunStatus } from "../types.js";
import {
  experimentManifestPath,
  experimentOutputDir,
  roundContextDirectory,
  roundContextPath,
} from "../workspace.js";

export interface DashboardServerOptions {
  hostname: string;
  port: number;
}

export class DashboardServer {
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, errorStatus(error), { error: errorMessage(error) });
      } else {
        response.end();
      }
    });
  });
  private readonly streams = new Set<{ experimentId: string; response: ServerResponse }>();
  private readonly publicDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../public",
  );
  private keepAlive: NodeJS.Timeout | null = null;
  private readonly csrfToken = randomBytes(32).toString("base64url");
  private readonly onEvent = (event: GenerationEvent) => this.broadcast(event);

  constructor(
    private readonly db: BenchmarkDatabase,
    private readonly manager: OrchestratorManager,
    private readonly controlPlane: ControlPlane,
    private readonly options: DashboardServerOptions,
  ) {}

  async start(): Promise<string> {
    this.db.on("event", this.onEvent);
    this.keepAlive = setInterval(() => {
      for (const stream of this.streams) stream.response.write(": keepalive\n\n");
    }, 15_000);
    this.keepAlive.unref();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.hostname, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    return `http://${this.options.hostname}:${port}`;
  }

  async close(): Promise<void> {
    this.db.off("event", this.onEvent);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    for (const stream of this.streams) stream.response.end();
    this.streams.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (isStateChangingMethod(request.method)) this.assertWriteRequest(request);

    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true, now: Date.now() });
      return;
    }
    if (request.method === "GET" && pathname === "/api/setup") {
      const [datasets, modelSelections] = await Promise.all([
        this.controlPlane.listDatasets(),
        this.controlPlane.listDatasetModelSelections(),
      ]);
      sendJson(response, 200, {
        datasets,
        modelSelections,
        activeExperimentId: this.manager.activeExperimentId,
        credentialStorage: "opencode",
        localCredentialManagement: isLoopbackHost(this.options.hostname),
        csrfToken: this.csrfToken,
        outputDir: this.controlPlane.options.outputDir,
      });
      return;
    }
    if (request.method === "POST" && pathname === "/api/datasets/import") {
      const dataset = await this.controlPlane.importDataset(await readJson(request, 128 * 1024 * 1024));
      sendJson(response, 201, dataset);
      return;
    }
    const datasetModelsMatch = pathname.match(/^\/api\/datasets\/([^/]+)\/models$/);
    if (request.method === "PUT" && datasetModelsMatch) {
      sendJson(
        response,
        200,
        await this.controlPlane.saveDatasetModelSelection(
          datasetModelsMatch[1]!,
          await readJson(request),
        ),
      );
      return;
    }
    if (request.method === "GET" && pathname === "/api/providers") {
      sendJson(response, 200, await this.controlPlane.listProviders());
      return;
    }
    if (request.method === "GET" && pathname === "/api/providers/packy") {
      sendJson(response, 200, await this.controlPlane.listPackyProviders());
      return;
    }
    if (request.method === "GET" && pathname === "/api/providers/aggregators") {
      sendJson(response, 200, await this.controlPlane.listAggregatorProviders());
      return;
    }
    if (request.method === "GET" && pathname === "/api/providers/packy/catalog") {
      sendJson(
        response,
        200,
        await this.controlPlane.listPackyCatalog(url.searchParams.get("refresh") === "1"),
      );
      return;
    }
    if (request.method === "POST" && pathname === "/api/providers/packy") {
      this.assertLocalCredentialManagement();
      sendJson(
        response,
        201,
        await this.controlPlane.configurePackyProvider(await readJson(request)),
      );
      return;
    }
    if (request.method === "POST" && pathname === "/api/providers/packy/connect") {
      this.assertLocalCredentialManagement();
      sendJson(
        response,
        201,
        await this.controlPlane.connectPackyGroup(await readJson(request)),
      );
      return;
    }
    if (request.method === "POST" && pathname === "/api/providers/aggregators/connect") {
      this.assertLocalCredentialManagement();
      sendJson(
        response,
        201,
        await this.controlPlane.connectAggregator(await readJson(request)),
      );
      return;
    }
    if (request.method === "POST" && pathname === "/api/models/validate") {
      sendJson(response, 200, {
        checks: await this.controlPlane.validateModels(await readJson(request)),
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/models/verifications") {
      sendJson(response, 200, await this.controlPlane.listModelVerifications());
      return;
    }
    if (request.method === "POST" && pathname === "/api/models/verify") {
      sendJson(response, 200, {
        results: await this.controlPlane.verifyModelsActually(await readJson(request)),
      });
      return;
    }
    if (request.method === "POST" && pathname === "/api/auth/api-key") {
      this.assertLocalCredentialManagement();
      await this.controlPlane.setApiKey(await readJson(request));
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && pathname === "/api/auth/oauth/start") {
      this.assertLocalCredentialManagement();
      sendJson(response, 200, await this.controlPlane.startOAuth(await readJson(request)));
      return;
    }
    if (request.method === "POST" && pathname === "/api/auth/oauth/complete") {
      this.assertLocalCredentialManagement();
      await this.controlPlane.completeOAuth(await readJson(request));
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && pathname === "/api/experiments") {
      sendJson(
        response,
        200,
        this.db.listExperiments().map((experiment) => ({
          ...publicExperiment(experiment),
          summary: this.db.getSummary(experiment.id),
        })),
      );
      return;
    }
    if (request.method === "POST" && pathname === "/api/experiments") {
      const { experiment } = await this.controlPlane.createExperiment(await readJson(request));
      sendJson(response, 201, publicExperiment(experiment));
      return;
    }

    const experimentMatch = pathname.match(/^\/api\/experiments\/([^/]+)$/);
    if (request.method === "GET" && experimentMatch) {
      const experiment = this.db.getExperiment(experimentMatch[1]!);
      if (!experiment) return sendJson(response, 404, { error: "生成实验不存在" });
      const page = positiveIntegerQuery(url.searchParams.get("page"), "page", 1, 1_000_000);
      const pageSize = positiveIntegerQuery(url.searchParams.get("pageSize"), "pageSize", 100, 200);
      const statusValue = url.searchParams.get("status") ?? "";
      if (statusValue && !RUN_STATUSES.includes(statusValue as RunStatus)) {
        throw new InputError(`运行状态筛选无效: ${statusValue}`);
      }
      const runPage = this.db.listRunPage(experiment.id, {
        page,
        pageSize,
        search: (url.searchParams.get("search") ?? "").slice(0, 200),
        ...(statusValue ? { status: statusValue as RunStatus } : {}),
      });
      const roundSummary = this.db.getRoundSummary(experiment.id);
      const openedRoundSummary = this.db.getRoundSummary(experiment.id, { openedOnly: true });
      sendJson(response, 200, {
        experiment: publicExperiment(experiment),
        summary: this.db.getSummary(experiment.id),
        roundSummary: {
          ...roundSummary,
          reachableTotal: openedRoundSummary.total,
        },
        runs: runPage.runs,
        runPage: {
          page: runPage.page,
          pageSize: runPage.pageSize,
          totalTasks: runPage.totalTasks,
          totalPages: runPage.totalPages,
          hasNextPage: runPage.hasNextPage,
        },
        modelSummaries: this.db.getModelRunSummaries(experiment.id),
        events: this.db.listRecentEvents(experiment.id, 120),
      });
      return;
    }

    const actionMatch = pathname.match(/^\/api\/experiments\/([^/]+)\/(pause|resume|cancel)$/);
    if (request.method === "POST" && actionMatch) {
      const [, experimentId, action] = actionMatch;
      if (action === "pause") this.manager.pause(experimentId!);
      if (action === "resume") this.manager.resume(experimentId!);
      if (action === "cancel") await this.manager.cancel(experimentId!);
      sendJson(response, 200, { ok: true });
      return;
    }

    const advanceStageMatch = pathname.match(/^\/api\/experiments\/([^/]+)\/advance-stage$/);
    if (request.method === "POST" && advanceStageMatch) {
      const experiment = this.db.getExperiment(advanceStageMatch[1]!);
      if (!experiment) return sendJson(response, 404, { error: "生成实验不存在" });
      const runtimeConfig = await this.controlPlane.prepareForRecovery(experiment.config);
      await this.manager.advanceStage(experiment.id, runtimeConfig);
      sendJson(response, 200, { ok: true });
      return;
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) {
      const run = this.db.getRun(runMatch[1]!);
      if (!run) return sendJson(response, 404, { error: "运行不存在" });
      const rounds = this.db.getRounds(run.id);
      sendJson(response, 200, {
        run,
        resultPath: run.workspacePath
          ? path.join(run.workspacePath, ".benchmark", "result.json")
          : null,
        roundContextDirectory: run.workspacePath
          && existsSync(roundContextDirectory(run.workspacePath))
            ? roundContextDirectory(run.workspacePath)
            : null,
        rounds: rounds.map((round) => ({
          ...round,
          contextPath: run.workspacePath
            && existsSync(roundContextPath(run.workspacePath, round.roundIndex, round.roundId))
              ? roundContextPath(run.workspacePath, round.roundIndex, round.roundId)
              : null,
        })),
        ...this.runEventPage(run.experimentId, run.id),
      });
      return;
    }

    const retryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
    if (request.method === "POST" && retryMatch) {
      const run = this.db.getRun(retryMatch[1]!);
      if (!run) return sendJson(response, 404, { error: "运行不存在" });
      const experiment = this.db.getExperiment(run.experimentId);
      if (!experiment) return sendJson(response, 404, { error: "生成实验不存在" });
      const runtimeConfig = await this.controlPlane.prepareForRecovery(experiment.config);
      await this.manager.retryRun(run.id, runtimeConfig);
      sendJson(response, 200, { ok: true });
      return;
    }

    const finalizeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/finalize$/);
    if (request.method === "POST" && finalizeMatch) {
      await this.manager.finalizeRun(finalizeMatch[1]!);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && pathname === "/api/stream") {
      const experimentId = url.searchParams.get("experimentId");
      if (!experimentId || !this.db.getExperiment(experimentId)) {
        return sendJson(response, 400, { error: "experimentId 无效" });
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("retry: 2000\n\n");
      let afterId = lastEventId(request, url);
      while (true) {
        const page = this.db.listEventPage({ experimentId, afterId, limit: 2_000 });
        for (const event of page.events) response.write(ssePayload(event));
        afterId = page.events.at(-1)?.id ?? afterId;
        if (!page.hasMore) break;
      }
      const stream = { experimentId, response };
      this.streams.add(stream);
      request.on("close", () => this.streams.delete(stream));
      return;
    }

    const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)(?:\/(.*))?$/);
    if (request.method === "GET" && artifactMatch) {
      await this.serveArtifact(artifactMatch[1]!, artifactMatch[2] ?? "", response);
      return;
    }

    if (request.method === "GET") {
      const staticName = pathname === "/" ? "index.html" : pathname.slice(1);
      if (["index.html", "app.js", "styles.css"].includes(staticName)) {
        await sendFile(path.join(this.publicDir, staticName), response, "dashboard");
        return;
      }
    }
    sendJson(response, 404, { error: "Not found" });
  }

  private assertLocalCredentialManagement(): void {
    if (!isLoopbackHost(this.options.hostname)) {
      throw new InputError("密钥管理只允许在 127.0.0.1 或 localhost 面板中使用");
    }
  }

  private assertWriteRequest(request: IncomingMessage): void {
    if (!isLoopbackHost(this.options.hostname)) {
      throw new RequestGuardError("写操作只允许通过 127.0.0.1、localhost 或 SSH 本地端口转发访问");
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") {
      throw new RequestGuardError("已拒绝跨站写请求");
    }
    const origin = request.headers.origin;
    if (origin && !sameRequestOrigin(origin, request.headers.host)) {
      throw new RequestGuardError("写请求来源与操作台不一致");
    }
    const token = request.headers["x-gamebench-csrf"];
    if (typeof token !== "string" || !constantTimeEqual(token, this.csrfToken)) {
      throw new RequestGuardError("操作台会话校验失败，请刷新页面后重试");
    }
  }

  private runEventPage(experimentId: string, runId: string): {
    events: GenerationEvent[];
    eventPage: { limit: number; hasMore: boolean; oldestEventId: number | null; newestEventId: number | null };
  } {
    const page = this.db.listEventPage({ experimentId, runId, limit: 1_000, newest: true });
    const retained = page.events;
    return {
      events: retained,
      eventPage: {
        limit: 1_000,
        hasMore: page.hasMore,
        oldestEventId: retained[0]?.id ?? null,
        newestEventId: retained.at(-1)?.id ?? null,
      },
    };
  }

  private broadcast(event: GenerationEvent): void {
    const payload = ssePayload(event);
    for (const stream of this.streams) {
      if (stream.experimentId === event.experimentId) stream.response.write(payload);
    }
  }

  private async serveArtifact(
    runId: string,
    requestedPath: string,
    response: ServerResponse,
  ): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run?.workspacePath) return sendJson(response, 404, { error: "运行产物不存在" });
    const workspaceRoot = await realpath(run.workspacePath).catch(() => null);
    if (!workspaceRoot) return sendJson(response, 404, { error: "运行产物不存在" });
    const relativeRequest = requestedPath || "index.html";
    let filePath = path.resolve(workspaceRoot, relativeRequest);
    let relative = path.relative(workspaceRoot, filePath);
    if (!isContainedRelativePath(relative) || containsPrivateArtifactSegment(relative)) {
      return sendJson(response, 403, { error: "禁止访问该路径" });
    }
    try {
      await assertNoSymbolicLinks(workspaceRoot, relative);
      if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, "index.html");
      relative = path.relative(workspaceRoot, filePath);
      await assertNoSymbolicLinks(workspaceRoot, relative);
      const resolvedFile = await realpath(filePath);
      if (!isContainedRelativePath(path.relative(workspaceRoot, resolvedFile))) {
        return sendJson(response, 403, { error: "禁止访问该路径" });
      }
      filePath = resolvedFile;
    } catch {
      return sendJson(response, 404, { error: "文件不存在" });
    }
    await sendFile(filePath, response, "artifact");
  }
}

function publicExperiment(experiment: ExperimentRecord) {
  const { config, ...result } = experiment;
  const outputDir = experimentOutputDir(config, experiment.id);
  return {
    ...result,
    outputDir,
    manifestPath: experimentManifestPath(config, experiment.id),
    settings: {
      globalConcurrency: config.runtime.globalConcurrency,
      initialBuildSoftTimeoutMs: config.runtime.initialBuildSoftTimeoutMs ?? 0,
      initialBuildWrapUpMs: config.runtime.initialBuildWrapUpMs ?? 900_000,
      providerConcurrency: config.runtime.providerConcurrency,
      harness: config.runtime.harness,
      stageMode: config.runtime.stageMode,
      outputDir,
      models: config.models.map((model) => ({
        id: model.id,
        model: model.model,
        enabled: model.enabled,
        concurrency: model.concurrency,
        ...(model.roundTimeoutMs !== undefined ? { roundTimeoutMs: model.roundTimeoutMs } : {}),
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
      })),
    },
  };
}

async function readJson(request: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RequestBodyError("请求必须使用 application/json", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new RequestBodyError("上传内容超过大小限制", 413);
    chunks.push(buffer);
  }
  if (size === 0) throw new RequestBodyError("请求内容不能为空", 400);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestBodyError("JSON 请求格式无效", 400);
  }
}

async function sendFile(
  filePath: string,
  response: ServerResponse,
  mode: "dashboard" | "artifact" = "dashboard",
): Promise<void> {
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) return sendJson(response, 404, { error: "文件不存在" });
  response.writeHead(200, {
    "Content-Type": mimeType(filePath),
    "Content-Length": fileInfo.size,
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=60",
    ...securityHeaders(mode),
  });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(response);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...securityHeaders("dashboard"),
  });
  response.end(payload);
}

function positiveIntegerQuery(
  value: string | null,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new InputError(`${name} 必须是正整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new InputError(`${name} 必须在 1 到 ${maximum} 之间`);
  }
  return parsed;
}

function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".mp4": "video/mp4",
      ".wasm": "application/wasm",
    }[extension] ?? "application/octet-stream"
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "输入"}: ${issue.message}`)
      .join("；");
  }
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number {
  if (error instanceof RequestGuardError) return 403;
  if (error instanceof RequestBodyError) return error.status;
  if (error instanceof InputError || error instanceof ZodError) return 400;
  if (error instanceof StageAdvanceError) return 409;
  if (error instanceof Error && error.message.includes("已有一个生成实验在运行")) return 409;
  return 500;
}

function isLoopbackHost(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(hostname.toLowerCase());
}

class RequestBodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

class RequestGuardError extends Error {}

function isStateChangingMethod(method: string | undefined): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method ?? "");
}

function sameRequestOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host === host;
  } catch {
    return false;
  }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function lastEventId(request: IncomingMessage, url: URL): number {
  const rawHeader = request.headers["last-event-id"];
  return Math.max(
    safeEventId(url.searchParams.get("afterId")),
    safeEventId(typeof rawHeader === "string" ? rawHeader : null),
  );
}

function safeEventId(raw: string | null): number {
  if (!raw || !/^\d+$/u.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function ssePayload(event: GenerationEvent): string {
  return `id: ${event.id}\nevent: generation\ndata: ${JSON.stringify(event)}\n\n`;
}

function isContainedRelativePath(relative: string): boolean {
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function containsPrivateArtifactSegment(relative: string): boolean {
  return relative.split(path.sep).some((segment) => segment === ".benchmark");
}

async function assertNoSymbolicLinks(root: string, relative: string): Promise<void> {
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("symbolic links are forbidden");
  }
}

function securityHeaders(mode: "dashboard" | "artifact"): Record<string, string> {
  const common = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  if (mode === "artifact") {
    return {
      ...common,
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": [
        "sandbox allow-scripts allow-pointer-lock",
        "default-src 'self' data: blob:",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
        "style-src 'self' 'unsafe-inline' data: blob:",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "worker-src 'self' data: blob:",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
    };
  }
  return {
    ...common,
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
}
