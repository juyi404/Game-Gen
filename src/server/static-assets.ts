import { realpath } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { sendFile, sendJson } from "./http.js";
import { assertNoSymbolicLinks, isContainedRelativePath } from "./paths.js";

/** Only the dashboard entry points and its authored ES modules are public assets. */
export async function serveDashboardAsset(
  publicDir: string,
  pathname: string,
  response: ServerResponse,
): Promise<boolean> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!["index.html", "app.js", "styles.css"].includes(relative)
    && !/^modules\/[a-z0-9-]+\.js$/u.test(relative)) return false;
  try {
    const root = await realpath(publicDir);
    await assertNoSymbolicLinks(root, relative);
    const file = await realpath(path.join(root, relative));
    if (!isContainedRelativePath(path.relative(root, file))) {
      sendJson(response, 403, { error: "禁止访问该路径" });
      return true;
    }
    await sendFile(file, response, "dashboard");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    sendJson(response, 404, { error: "文件不存在" });
  }
  return true;
}
