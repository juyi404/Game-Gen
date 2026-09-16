import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { roundContextDirectory, roundContextPath } from "../../persistence/workspace.js";
import { sendJson } from ".././http.js";
import type { RouteContext } from "./context.js";

export async function handleRunRoutes(
  context: RouteContext, request: IncomingMessage, response: ServerResponse, url: URL, pathname: string,
): Promise<false | void> {
  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch) {
    const run = context.db.getRun(runMatch[1]!);
    if (!run) return sendJson(response, 404, { error: "运行不存在" });
    const rounds = context.db.getRounds(run.id);
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
      ...context.runEventPage(run.experimentId, run.id),
    });
    return;
  }

  const retryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    await context.controlPlane.retryRun(retryMatch[1]!);
    sendJson(response, 200, { ok: true });
    return;
  }

  const finalizeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/finalize$/);
  if (request.method === "POST" && finalizeMatch) {
    await context.controlPlane.finalizeRun(finalizeMatch[1]!);
    sendJson(response, 200, { ok: true });
    return;
  }


  return false;
}
