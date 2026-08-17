#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { loadBenchmarkConfig } from "./config.js";
import { ControlPlane, type ControlPlaneOptions } from "./control-plane.js";
import { BenchmarkDatabase } from "./database.js";
import { OrchestratorManager } from "./manager.js";
import { DashboardServer } from "./server/dashboard.js";
import type { ResolvedBenchmarkConfig } from "./types.js";

interface CliOptions {
  configPath?: string;
  port?: number;
  hostname?: string;
}

async function main(): Promise<void> {
  const [command = "serve", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) {
    printHelp();
    return;
  }
  const options = parseOptions(args);
  const configPath = options.configPath ?? (command === "serve" ? undefined : "benchmark.json");
  const loaded = configPath ? await loadBenchmarkConfig(configPath) : null;
  if (command === "validate") {
    if (!loaded) throw new Error("validate 需要 Benchmark 配置文件");
    const enabledModels = loaded.config.models.filter((model) => model.enabled);
    console.log(`配置有效: ${loaded.config.name}`);
    console.log(`任务: ${loaded.tasks.length}`);
    console.log(`模型: ${enabledModels.length}`);
    console.log(`运行矩阵: ${loaded.tasks.length * enabledModels.length}`);
    console.log(`全局并发: ${loaded.config.runtime.globalConcurrency}`);
    return;
  }
  if (!['run', 'serve'].includes(command)) {
    throw new Error(`未知命令: ${command}`);
  }

  if (command === "run" && !loaded) throw new Error("run 需要 Benchmark 配置文件");
  const controlOptions = createControlPlaneOptions(loaded?.config, options);
  const db = new BenchmarkDatabase(path.join(controlOptions.dataDir, "benchmark.sqlite"));
  const manager = new OrchestratorManager(db);
  const controlPlane = new ControlPlane(manager, controlOptions);
  await controlPlane.initialize();
  const dashboard = new DashboardServer(db, manager, controlPlane, controlOptions.dashboard);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n正在安全关闭，未完成运行可在下次 serve 时恢复…");
    await manager.shutdown().catch(() => undefined);
    await dashboard.close().catch(() => undefined);
    controlPlane.close();
    db.close();
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(143)));

  const dashboardUrl = await dashboard.start();
  console.log(`监控面板: ${dashboardUrl}`);
  console.log(`状态数据库: ${db.filePath}`);

  if (command === "run") {
    if (!loaded) throw new Error("run 需要 Benchmark 配置文件");
    const runtimeConfig = await controlPlane.prepareForRecovery(loaded.config);
    const { experiment, orchestrator } = await manager.createAndStart(runtimeConfig, loaded.tasks);
    console.log(`实验 ID: ${experiment.id}`);
    console.log(`运行矩阵: ${experiment.totalRuns}`);
    const result = await orchestrator.waitForCompletion();
    console.log(`生成结束: ${result.status}`);
    console.log(`源码根目录: ${runtimeConfig.runtime.outputDir}`);
    if (result.status === "failed") process.exitCode = 1;
    await shutdown();
    return;
  }

  const recoverable = db.listRecoverableExperiments();
  const latest = recoverable[0];
  if (latest) {
    const runtimeConfig = await controlPlane.prepareForRecovery(latest.config);
    await manager.startExisting(latest.id, runtimeConfig);
    console.log(`已恢复实验: ${latest.id} (${latest.status})`);
  } else {
    console.log("当前没有待恢复实验，面板以历史查看模式运行。");
  }
  console.log("按 Ctrl+C 停止服务。 ");
}

function parseOptions(args: string[]): CliOptions {
  let configPath: string | undefined;
  let port: number | undefined;
  let hostname: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config" || argument === "-c") {
      configPath = requireValue(args, ++index, argument);
    } else if (argument === "--port") {
      port = Number(requireValue(args, ++index, argument));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port 无效");
    } else if (argument === "--hostname") {
      hostname = requireValue(args, ++index, argument);
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }
  const result: CliOptions = {};
  if (configPath !== undefined) result.configPath = configPath;
  if (port !== undefined) result.port = port;
  if (hostname !== undefined) result.hostname = hostname;
  return result;
}

function createControlPlaneOptions(
  config: ResolvedBenchmarkConfig | undefined,
  cli: CliOptions,
): ControlPlaneOptions {
  const projectRoot = process.cwd();
  const defaultTemplate = path.join(projectRoot, "examples", "template");
  const dashboard = {
    hostname: cli.hostname ?? config?.dashboard.hostname ?? "127.0.0.1",
    port: cli.port ?? config?.dashboard.port ?? 8787,
  };
  const opencode = config?.opencode ?? {
    hostname: "127.0.0.1",
    port: 4096,
    startupTimeoutMs: 30_000,
    agent: "build",
    config: {},
  };
  const options: ControlPlaneOptions = {
    projectRoot,
    dataDir: config?.runtime.dataDir ?? path.join(projectRoot, ".gamebench", "platform"),
    outputDir: config?.runtime.outputDir ?? path.join(projectRoot, "runs"),
    opencode,
    dashboard,
  };
  const workspaceTemplate = config?.runtime.workspaceTemplate ??
    (existsSync(defaultTemplate) ? defaultTemplate : undefined);
  if (workspaceTemplate) options.workspaceTemplate = workspaceTemplate;
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} 缺少参数值`);
  return value;
}

function printHelp(): void {
  console.log(`
Game Generation Benchmark

用法:
  npm run dev
  npm run dev -- run -c <benchmark.json>
  npm run dev -- serve [-c <benchmark.json>]
  npm run dev -- validate -c <benchmark.json>

命令:
  run       创建实验、启动生成并开启监控面板
  serve     开启操作台并恢复未完成实验（默认命令）
  validate  校验任务集与模型矩阵，不调用模型

参数:
  -c, --config <path>  可选配置文件；run/validate 默认 benchmark.json
  --hostname <host>    覆盖面板监听地址
  --port <port>        覆盖面板端口
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
