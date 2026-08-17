import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenCodeConfig } from "./types.js";

interface OpenCodeProcess {
  url: string;
  close(): void;
}

export interface OpenCodeRuntime {
  client: OpencodeClient;
  server: OpenCodeProcess | null;
  url: string;
}

export interface OpenCodeRuntimeOptions {
  reuseExisting?: boolean;
}

export function configuredOpenCodeUrl(config: OpenCodeConfig): string {
  if (config.serverUrl) return config.serverUrl;
  const hostname = config.hostname.includes(":") ? `[${config.hostname}]` : config.hostname;
  return `http://${hostname}:${config.port}`;
}

export async function connectOrStartOpenCode(
  config: OpenCodeConfig,
  options: OpenCodeRuntimeOptions = {},
): Promise<OpenCodeRuntime> {
  if (config.serverUrl) {
    const client = await connect(config.serverUrl, config.startupTimeoutMs);
    return { client, server: null, url: config.serverUrl };
  }

  const expectedUrl = configuredOpenCodeUrl(config);
  if (options.reuseExisting !== false) {
    const existing = await tryConnect(expectedUrl, Math.min(config.startupTimeoutMs, 2_000));
    if (existing) return { client: existing, server: null, url: expectedUrl };
  }

  ensureLocalOpenCodeOnPath();
  const launchConfig = withPermissionDefaults(config.config);
  let port = await findAvailablePort(config.hostname, config.port);
  try {
    return await launch(config, launchConfig, port);
  } catch (error) {
    if (port !== config.port || !isPortConflict(error)) throw error;
    port = await findAvailablePort(config.hostname, 0);
    return launch(config, launchConfig, port);
  }
}

export function ensureLocalOpenCodeOnPath(): void {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const binDirectory = path.join(directory, "node_modules", ".bin");
    const executable = path.join(
      binDirectory,
      process.platform === "win32" ? "opencode.cmd" : "opencode",
    );
    if (existsSync(executable)) {
      const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
      const entries = (process.env[pathKey] ?? "").split(path.delimiter);
      if (!entries.includes(binDirectory)) {
        process.env[pathKey] = [binDirectory, ...entries].filter(Boolean).join(path.delimiter);
      }
      return;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

async function launch(
  config: OpenCodeConfig,
  launchConfig: Record<string, unknown>,
  port: number,
): Promise<OpenCodeRuntime> {
  const instance = await createOpencode({
    hostname: config.hostname,
    port,
    timeout: config.startupTimeoutMs,
    config: launchConfig,
  });
  const client = createOpencodeClient({
    baseUrl: instance.server.url,
    throwOnError: true,
  });
  try {
    await assertHealthy(client, config.startupTimeoutMs);
    return { client, server: instance.server, url: instance.server.url };
  } catch (error) {
    instance.server.close();
    throw error;
  }
}

async function connect(url: string, timeoutMs: number): Promise<OpencodeClient> {
  const client = createOpencodeClient({ baseUrl: url, throwOnError: true });
  await assertHealthy(client, timeoutMs);
  return client;
}

async function tryConnect(url: string, timeoutMs: number): Promise<OpencodeClient | null> {
  try {
    return await connect(url, timeoutMs);
  } catch {
    return null;
  }
}

async function assertHealthy(client: OpencodeClient, timeoutMs: number): Promise<void> {
  await client.config.get({
    signal: AbortSignal.timeout(Math.max(250, timeoutMs)),
    throwOnError: true,
  });
}

function withPermissionDefaults(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const permissionDefaults = {
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    doom_loop: "allow",
    external_directory: "deny",
  } as const;
  const rawPermission = rawConfig.permission;
  const permission =
    rawPermission && typeof rawPermission === "object" && !Array.isArray(rawPermission)
      ? { ...permissionDefaults, ...rawPermission }
      : permissionDefaults;
  return {
    share: "disabled",
    autoupdate: false,
    ...rawConfig,
    permission,
  };
}

function findAvailablePort(hostname: string, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (preferredPort !== 0 && error.code === "EADDRINUSE") {
        void findAvailablePort(hostname, 0).then(resolve, reject);
        return;
      }
      reject(error);
    });
    server.listen(preferredPort, hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : preferredPort;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function isPortConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRINUSE|address[^\n]*in use|ServeError/i.test(message);
}
