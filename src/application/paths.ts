import { InputError } from "./errors.js";

export function normalizeAggregatorBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/models$/i, "") || "/";
  return url.toString().replace(/\/+$/, "");
}

export function safeUploadPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized.toLowerCase().endsWith(".json") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new InputError(`仅支持相对路径 JSON 文件: ${value}`);
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*\0]/.test(segment),
    )
  ) {
    throw new InputError(`文件路径无效: ${value}`);
  }
  return segments.join("/");
}
