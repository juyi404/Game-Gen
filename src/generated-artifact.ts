import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const PLACEHOLDER_MARKER = "Replace this page with the generated game.";

export async function validateGeneratedGameArtifacts(workspacePath: string): Promise<void> {
  const entryPath = path.join(workspacePath, "index.html");
  let html: string;
  try {
    html = await readFile(entryPath, "utf8");
  } catch (error) {
    throw new Error(`生成结果无效：缺少 index.html (${errorMessage(error)})`);
  }
  if (html.includes(PLACEHOLDER_MARKER)) {
    throw new Error("生成结果无效：index.html 仍是默认占位页");
  }
  const missingReferences: string[] = [];
  for (const reference of localEntryReferences(html)) {
    const resolved = resolveArtifactReference(workspacePath, reference);
    if (!resolved) {
      missingReferences.push(`${reference}（超出游戏目录）`);
      continue;
    }
    try {
      const fileInfo = await stat(resolved);
      if (!fileInfo.isFile()) missingReferences.push(reference);
    } catch {
      missingReferences.push(reference);
    }
  }
  if (missingReferences.length > 0) {
    throw new Error(`生成结果无效：index.html 引用了不存在的文件 ${missingReferences.join("、")}`);
  }
}

export function localEntryReferences(html: string): string[] {
  const references = new Set<string>();
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/giu)) {
    const tagName = match[1]!.toLowerCase();
    const tag = match[0];
    if (tagName === "script") {
      const source = attribute(tag, "src");
      if (source && isLocalReference(source)) references.add(source);
      continue;
    }
    const relation = attribute(tag, "rel")?.toLowerCase().split(/\s+/u) ?? [];
    const href = attribute(tag, "href");
    if (relation.includes("stylesheet") && href && isLocalReference(href)) references.add(href);
  }
  return [...references];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
