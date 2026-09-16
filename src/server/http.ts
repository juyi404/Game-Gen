import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ZodError } from "zod";
import { InputError, NotFoundError } from "../application/errors.js";
import { ExperimentConflictError, StageAdvanceError } from "../application/experiment-manager.js";
import { RequestGuardError, securityHeaders } from "./security.js";

export async function readJson(request: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
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

export async function sendFile(
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

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...securityHeaders("dashboard"),
  });
  response.end(payload);
}

export function positiveIntegerQuery(
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

export function mimeType(filePath: string): string {
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

export function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "输入"}: ${issue.message}`)
      .join("；");
  }
  return error instanceof Error ? error.message : String(error);
}

export function errorStatus(error: unknown): number {
  if (error instanceof NotFoundError) return 404;
  if (error instanceof RequestGuardError) return 403;
  if (error instanceof RequestBodyError) return error.status;
  if (error instanceof InputError || error instanceof ZodError) return 400;
  if (error instanceof StageAdvanceError || error instanceof ExperimentConflictError) return 409;
  if (error instanceof Error && error.message.includes("已有一个生成实验在运行")) return 409;
  return 500;
}

export class RequestBodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
