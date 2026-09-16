import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, sendJson } from ".././http.js";
import type { RouteContext } from "./context.js";

export async function handleProviderRoutes(
  context: RouteContext, request: IncomingMessage, response: ServerResponse, url: URL, pathname: string,
): Promise<false | void> {
  if (request.method === "GET" && pathname === "/api/providers") {
    sendJson(response, 200, await context.controlPlane.listProviders());
    return;
  }
  if (request.method === "GET" && pathname === "/api/providers/packy") {
    sendJson(response, 200, await context.controlPlane.listPackyProviders());
    return;
  }
  if (request.method === "GET" && pathname === "/api/providers/aggregators") {
    sendJson(response, 200, await context.controlPlane.listAggregatorProviders());
    return;
  }
  if (request.method === "GET" && pathname === "/api/providers/packy/catalog") {
    sendJson(
      response,
      200,
      await context.controlPlane.listPackyCatalog(url.searchParams.get("refresh") === "1"),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/providers/packy") {
    context.assertLocalCredentialManagement();
    sendJson(
      response,
      201,
      await context.controlPlane.configurePackyProvider(await readJson(request)),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/providers/packy/connect") {
    context.assertLocalCredentialManagement();
    sendJson(
      response,
      201,
      await context.controlPlane.connectPackyGroup(await readJson(request)),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/providers/aggregators/connect") {
    context.assertLocalCredentialManagement();
    sendJson(
      response,
      201,
      await context.controlPlane.connectAggregator(await readJson(request)),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/models/validate") {
    sendJson(response, 200, {
      checks: await context.controlPlane.validateModels(await readJson(request)),
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/models/verifications") {
    sendJson(response, 200, await context.controlPlane.listModelVerifications());
    return;
  }
  if (request.method === "POST" && pathname === "/api/models/verify") {
    sendJson(response, 200, {
      results: await context.controlPlane.verifyModelsActually(await readJson(request)),
    });
    return;
  }
  if (request.method === "POST" && pathname === "/api/auth/api-key") {
    context.assertLocalCredentialManagement();
    await context.controlPlane.setApiKey(await readJson(request));
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && pathname === "/api/auth/oauth/start") {
    context.assertLocalCredentialManagement();
    sendJson(response, 200, await context.controlPlane.startOAuth(await readJson(request)));
    return;
  }
  if (request.method === "POST" && pathname === "/api/auth/oauth/complete") {
    context.assertLocalCredentialManagement();
    await context.controlPlane.completeOAuth(await readJson(request));
    sendJson(response, 200, { ok: true });
    return;
  }

  return false;
}
