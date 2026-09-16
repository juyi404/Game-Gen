import type { IncomingMessage } from "node:http";
import type { GenerationEvent } from "../domain/types.js";

export function lastEventId(request: IncomingMessage, url: URL): number {
  const rawHeader = request.headers["last-event-id"];
  return Math.max(
    safeEventId(url.searchParams.get("afterId")),
    safeEventId(typeof rawHeader === "string" ? rawHeader : null),
  );
}

export function safeEventId(raw: string | null): number {
  if (!raw || !/^\d+$/u.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function ssePayload(event: GenerationEvent): string {
  return `id: ${event.id}\nevent: generation\ndata: ${JSON.stringify(event)}\n\n`;
}
