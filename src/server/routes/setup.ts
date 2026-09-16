import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, sendJson } from ".././http.js";
import { isLoopbackHost } from ".././security.js";
import type { RouteContext } from "./context.js";

export async function handleSetupRoutes(
  context: RouteContext, request: IncomingMessage, response: ServerResponse, url: URL, pathname: string,
): Promise<false | void> {
  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, now: Date.now() });
    return;
  }
  if (request.method === "GET" && pathname === "/api/setup") {
    const [datasets, modelSelections] = await Promise.all([
      context.controlPlane.listDatasets(),
      context.controlPlane.listDatasetModelSelections(),
    ]);
    sendJson(response, 200, {
      datasets,
      modelSelections,
      activeExperimentId: context.controlPlane.activeExperimentId,
      credentialStorage: "opencode",
      localCredentialManagement: isLoopbackHost(context.options.hostname),
      csrfToken: context.csrfToken,
      outputDir: context.controlPlane.options.outputDir,
    });
    return;
  }
  if (request.method === "POST" && pathname === "/api/datasets/import") {
    const dataset = await context.controlPlane.importDataset(await readJson(request, 128 * 1024 * 1024));
    sendJson(response, 201, dataset);
    return;
  }
  const datasetModelsMatch = pathname.match(/^\/api\/datasets\/([^/]+)\/models$/);
  if (request.method === "PUT" && datasetModelsMatch) {
    sendJson(
      response,
      200,
      await context.controlPlane.saveDatasetModelSelection(
        datasetModelsMatch[1]!,
        await readJson(request),
      ),
    );
    return;
  }

  return false;
}
