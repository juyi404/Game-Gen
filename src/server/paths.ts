import { lstat } from "node:fs/promises";
import path from "node:path";

export function isContainedRelativePath(relative: string): boolean {
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function containsPrivateArtifactSegment(relative: string): boolean {
  return relative.split(path.sep).some((segment) => segment === ".benchmark");
}

export async function assertNoSymbolicLinks(root: string, relative: string): Promise<void> {
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("symbolic links are forbidden");
  }
}
