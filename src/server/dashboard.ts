import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { InputError, type ControlPlane } from "../control-plane.js";
import type { BenchmarkDatabase } from "../database.js";
import { StageAdvanceError, type OrchestratorManager } from "../manager.js";
import type { ExperimentRecord, GenerationEvent } from "../types.js";
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

    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true, now: Date.now() });
      return;
    }
    if (request.method === "GET" && pathname === "/api/setup") {
      sendJson(response, 200, {
        datasets: await this.controlPlane.listDatasets(),
        activeExperimentId: this.manager.activeExperimentId,
        credentialStorage: "opencode",
        localCredentialManagement: isLoopbackHost(this.options.hostname),
        outputDir: this.controlPlane.options.outputDir,
      });
      return;
    }
    if (request.method === "POST" && pathname === "/api/datasets/import") {
      const dataset = await this.controlPlane.importDataset(await readJson(request, 128 * 1024 * 1024));
      sendJson(response, 201, dataset);
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
    if (request.method === "POST" && pathname === "/api/models/validate") {
      sendJson(response, 200, {
        checks: await this.controlPlane.validateModels(await readJson(request)),
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
      sendJson(response, 200, {
        experiment: publicExperiment(experiment),
        summary: this.db.getSummary(experiment.id),
        roundSummary: this.db.getRoundSummary(experiment.id),
        runs: this.db.listRuns(experiment.id),
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
        events: this.db.listEvents({
          experimentId: run.experimentId,
          runId: run.id,
          limit: 1_000,
        }),
      });
      return;
    }

    const retryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
    if (request.method === "POST" && retryMatch) {
      await this.manager.retryRun(retryMatch[1]!);
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
        await sendFile(path.join(this.publicDir, staticName), response);
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

  private broadcast(event: GenerationEvent): void {
    const payload = `id: ${event.id}\nevent: generation\ndata: ${JSON.stringify(event)}\n\n`;
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
    const relativeRequest = requestedPath || "index.html";
    const target = path.resolve(run.workspacePath, relativeRequest);
    const relative = path.relative(run.workspacePath, target);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(".benchmark")) {
      return sendJson(response, 403, { error: "禁止访问该路径" });
    }
    let filePath = target;
    try {
      if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, "index.html");
    } catch {
      return sendJson(response, 404, { error: "文件不存在" });
    }
    await sendFile(filePath, response);
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
      providerConcurrency: config.runtime.providerConcurrency,
      harness: config.runtime.harness,
      stageMode: config.runtime.stageMode,
      outputDir,
      models: config.models.map((model) => ({
        id: model.id,
        model: model.model,
        enabled: model.enabled,
        concurrency: model.concurrency,
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

async function sendFile(filePath: string, response: ServerResponse): Promise<void> {
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) return sendJson(response, 404, { error: "文件不存在" });
  response.writeHead(200, {
    "Content-Type": mimeType(filePath),
    "Content-Length": fileInfo.size,
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=60",
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
  });
  response.end(payload);
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
