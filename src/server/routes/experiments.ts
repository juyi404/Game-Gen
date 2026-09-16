import type { IncomingMessage, ServerResponse } from "node:http";
import { InputError } from "../../application/errors.js";
import type { RunStatus } from "../../domain/types.js";
import { RUN_STATUSES } from "../../domain/types.js";
import { positiveIntegerQuery, readJson, sendJson } from ".././http.js";
import { publicExperiment } from ".././presenters.js";
import type { RouteContext } from "./context.js";

export async function handleExperimentRoutes(
  context: RouteContext, request: IncomingMessage, response: ServerResponse, url: URL, pathname: string,
): Promise<false | void> {
  if (request.method === "GET" && pathname === "/api/experiments") {
    sendJson(
      response,
      200,
      context.db.listExperiments().map((experiment) => ({
        ...publicExperiment(experiment),
        summary: context.db.getSummary(experiment.id),
      })),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/experiments") {
    const { experiment } = await context.controlPlane.createExperiment(await readJson(request));
    sendJson(response, 201, publicExperiment(experiment));
    return;
  }

  const experimentMatch = pathname.match(/^\/api\/experiments\/([^/]+)$/);
  if (request.method === "GET" && experimentMatch) {
    const experiment = context.db.getExperiment(experimentMatch[1]!);
    if (!experiment) return sendJson(response, 404, { error: "生成实验不存在" });
    const page = positiveIntegerQuery(url.searchParams.get("page"), "page", 1, 1_000_000);
    const pageSize = positiveIntegerQuery(url.searchParams.get("pageSize"), "pageSize", 100, 200);
    const statusValue = url.searchParams.get("status") ?? "";
    if (statusValue && !RUN_STATUSES.includes(statusValue as RunStatus)) {
      throw new InputError(`运行状态筛选无效: ${statusValue}`);
    }
    const runPage = context.db.listRunPage(experiment.id, {
      page,
      pageSize,
      search: (url.searchParams.get("search") ?? "").slice(0, 200),
      modelId: (url.searchParams.get("modelId") ?? "").slice(0, 120),
      ...(statusValue ? { status: statusValue as RunStatus } : {}),
    });
    const roundSummary = context.db.getRoundSummary(experiment.id);
    const openedRoundSummary = context.db.getRoundSummary(experiment.id, { openedOnly: true });
    sendJson(response, 200, {
      experiment: publicExperiment(experiment),
      summary: context.db.getSummary(experiment.id),
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
      modelSummaries: context.db.getModelRunSummaries(experiment.id),
      events: context.db.listRecentEvents(experiment.id, 120),
    });
    return;
  }

  const actionMatch = pathname.match(/^\/api\/experiments\/([^/]+)\/(pause|resume|cancel)$/);
  if (request.method === "POST" && actionMatch) {
    const [, experimentId, action] = actionMatch;
    if (action === "pause") context.controlPlane.pause(experimentId!);
    if (action === "resume") context.controlPlane.resume(experimentId!);
    if (action === "cancel") await context.controlPlane.cancel(experimentId!);
    sendJson(response, 200, { ok: true });
    return;
  }

  const advanceStageMatch = pathname.match(/^\/api\/experiments\/([^/]+)\/advance-stage$/);
  if (request.method === "POST" && advanceStageMatch) {
    await context.controlPlane.advanceStage(advanceStageMatch[1]!);
    sendJson(response, 200, { ok: true });
    return;
  }


  return false;
}
