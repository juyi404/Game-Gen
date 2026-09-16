import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlPlane } from "../application/control-plane.js";
import { InputError } from "../application/errors.js";
import type { OrchestratorManager } from "../application/experiment-manager.js";
import type { GenerationEvent } from "../domain/types.js";
import type { BenchmarkDatabase } from "../persistence/database.js";
import { lastEventId, ssePayload } from "./events.js";
import { errorMessage, errorStatus, sendFile, sendJson } from "./http.js";
import { assertNoSymbolicLinks, containsPrivateArtifactSegment, isContainedRelativePath } from "./paths.js";
import type { RouteContext } from "./routes/context.js";
import { handleExperimentRoutes } from "./routes/experiments.js";
import { handleProviderRoutes } from "./routes/providers.js";
import { handleRunRoutes } from "./routes/runs.js";
import { handleSetupRoutes } from "./routes/setup.js";
import { constantTimeEqual, isLoopbackHost, isStateChangingMethod, RequestGuardError, sameRequestOrigin } from "./security.js";
import { serveDashboardAsset } from "./static-assets.js";

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
    _manager: OrchestratorManager,
    private readonly controlPlane: ControlPlane,
    private readonly options: DashboardServerOptions,
  ) { }

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

    const context: RouteContext = {
      db: this.db, controlPlane: this.controlPlane,
      options: this.options, csrfToken: this.csrfToken,
      assertLocalCredentialManagement: () => this.assertLocalCredentialManagement(),
      runEventPage: (experimentId, runId) => this.runEventPage(experimentId, runId),
    };
    for (const route of [handleSetupRoutes, handleProviderRoutes, handleExperimentRoutes, handleRunRoutes]) {
      if (await route(context, request, response, url, pathname) !== false) return;
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

    if (request.method === "GET" && await serveDashboardAsset(this.publicDir, pathname, response)) return;
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
