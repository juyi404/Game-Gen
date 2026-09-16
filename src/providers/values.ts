import { readFile } from "node:fs/promises";

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function modelVerificationKey(providerId: string, modelId: string, reasoningEffort?: string): string {
  return JSON.stringify([providerId, modelId, reasoningEffort || null]);
}

export function modelProbeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return "OpenCode 端到端工具调用验证超时";
  const message = error.message.replace(/\s+/g, " ").trim();
  return message || "OpenCode 端到端工具调用验证失败";
}

export async function waitForProbeMarker(
  markerPath: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let observed: string | null = null;
  do {
    try {
      observed = await readFile(markerPath, "utf8");
      if (observed.trim() === expected) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(100);
  } while (Date.now() < deadline);
  if (observed !== null) throw new Error("模型响应完成，但写文件内容不正确");
  throw new Error("模型响应完成，但没有执行写文件工具");
}

export function portFromUrl(value: string): number | null {
  const port = Number(new URL(value).port);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
