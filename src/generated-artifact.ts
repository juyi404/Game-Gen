import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";

const PLACEHOLDER_MARKER = "Replace this page with the generated game.";

export async function validateGeneratedGameArtifacts(workspacePath: string): Promise<void> {
  const workspaceRoot = await realpath(workspacePath);
  const entryPath = path.join(workspacePath, "index.html");
  let html: string;
  try {
    if ((await lstat(entryPath)).isSymbolicLink()) throw new Error("index.html 不允许是符号链接");
    html = await readFile(entryPath, "utf8");
  } catch (error) {
    throw new Error(`生成结果无效：缺少 index.html (${errorMessage(error)})`);
  }
  if (html.includes(PLACEHOLDER_MARKER)) {
    throw new Error("生成结果无效：index.html 仍是默认占位页");
  }
  if (!hasVisibleSurface(html)) {
    throw new Error("生成结果无效：index.html 没有可见游戏内容或可执行游戏脚本");
  }
  const missingReferences: string[] = [];
  for (const reference of localEntryReferences(html)) {
    const resolved = resolveArtifactReference(workspaceRoot, reference);
    if (!resolved) {
      missingReferences.push(`${reference}（超出游戏目录）`);
      continue;
    }
    try {
      if ((await lstat(resolved)).isSymbolicLink()) {
        missingReferences.push(`${reference}（不允许符号链接）`);
        continue;
      }
      const fileInfo = await stat(resolved);
      const resolvedRealPath = await realpath(resolved);
      if (!isInside(workspaceRoot, resolvedRealPath)) {
        missingReferences.push(`${reference}（超出游戏目录）`);
      } else if (!fileInfo.isFile()) missingReferences.push(reference);
    } catch {
      missingReferences.push(reference);
    }
  }
  if (missingReferences.length > 0) {
    throw new Error(`生成结果无效：index.html 引用了不存在的文件 ${missingReferences.join("、")}`);
  }
  await validateEntryScripts(workspaceRoot, html);
}

export function localEntryReferences(html: string): string[] {
  const references = new Set<string>();
  for (const match of html.matchAll(
    /<(script|link|img|source|audio|video|track|iframe|input)\b(?:"[^"]*"|'[^']*'|[^'">])*>/giu,
  )) {
    const tagName = match[1]!.toLowerCase();
    const tag = match[0];
    if (tagName === "script") {
      const source = attribute(tag, "src");
      if (source && isLocalReference(source)) references.add(source);
      continue;
    }
    if (tagName === "link") {
      const relation = attribute(tag, "rel")?.toLowerCase().split(/\s+/u) ?? [];
      const href = attribute(tag, "href");
      if (relation.some((value) => ["stylesheet", "icon", "preload", "modulepreload"].includes(value))
        && href && isLocalReference(href)) references.add(href);
      continue;
    }
    for (const name of tagName === "video" ? ["src", "poster"] : ["src"]) {
      const source = attribute(tag, name);
      if (source && isLocalReference(source)) references.add(source);
    }
    const sourceSet = attribute(tag, "srcset");
    if (sourceSet) {
      for (const candidate of sourceSet.split(",").map((value) => value.trim().split(/\s+/u)[0]).filter(Boolean)) {
        if (isLocalReference(candidate!)) references.add(candidate!);
      }
    }
  }
  return [...references];
}

function hasVisibleSurface(html: string): boolean {
  const withoutHiddenContent = html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(head|script|style|template|noscript)\b[\s\S]*?<\/\1>/giu, " ");
  const visibleText = withoutHiddenContent
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(?:nbsp|#160|#x0*a0);/giu, " ")
    .replace(/&[a-z\d#]+;/giu, "x")
    .replace(/\s+/gu, " ")
    .trim();
  if (visibleText.length > 0) return true;
  if (/<(?:canvas|svg|img|video|audio|button|input|select|textarea)\b/iu.test(html)) return true;
  return /<script\b[^>]*(?:src\s*=)?[^>]*>[\s\S]*?<\/script>/iu.test(html);
}

async function validateEntryScripts(workspaceRoot: string, html: string): Promise<void> {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    const openingTag = `<script${match[1] ?? ""}>`;
    const type = attribute(openingTag, "type")?.toLowerCase() ?? "text/javascript";
    if (!["text/javascript", "application/javascript", "module"].includes(type)) continue;
    const source = attribute(openingTag, "src");
    let code = match[2] ?? "";
    let label = "index.html 内联脚本";
    if (source) {
      if (!isLocalReference(source)) {
        throw new Error(`生成结果无效：外部脚本 ${source} 会被安全预览策略阻止，请保存到游戏目录`);
      }
      const resolved = resolveArtifactReference(workspaceRoot, source);
      if (!resolved) continue;
      code = await readFile(resolved, "utf8");
      label = source;
    }
    if (!code.trim()) throw new Error(`生成结果无效：${label} 内容为空`);
    if (code.includes("\0") || /^(?:<{7}|={7}|>{7})/mu.test(code)) {
      throw new Error(`生成结果无效：${label} 包含损坏或未解决的合并内容`);
    }
    if (type !== "module") {
      try {
        new Script(code, { filename: label });
      } catch (error) {
        throw new Error(`生成结果无效：${label} 存在 JavaScript 语法错误 (${errorMessage(error)})`);
      }
    }
  }
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "iu",
  ));
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim() || null;
}

function isLocalReference(reference: string): boolean {
  return !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(reference);
}

function resolveArtifactReference(workspacePath: string, reference: string): string | null {
  const cleanReference = reference.split(/[?#]/u, 1)[0]!.replaceAll("/", path.sep);
  let decodedReference: string;
  try {
    decodedReference = decodeURIComponent(cleanReference);
  } catch {
    decodedReference = cleanReference;
  }
  const workspaceRoot = path.resolve(workspacePath);
  const relativeReference = decodedReference.replace(/^[/\\]+/u, "");
  const resolved = path.resolve(workspaceRoot, relativeReference);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
