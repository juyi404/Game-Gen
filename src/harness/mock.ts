import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GenerationHarness,
  HarnessRoundResult,
  HarnessRunContext,
  MockConfig,
  RoundDefinition,
} from "../types.js";

export class MockHarness implements GenerationHarness {
  constructor(private readonly config: MockConfig) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async beginRun(context: HarnessRunContext): Promise<string> {
    context.emit("harness.session.created", "info", "模拟会话已创建");
    return `mock-${context.run.id}`;
  }

  async executeRound(
    context: HarnessRunContext,
    _sessionId: string,
    round: RoundDefinition,
    roundIndex: number,
  ): Promise<HarnessRoundResult> {
    context.emit("harness.tool.running", "info", "正在修改游戏文件", {
      tool: "write",
      roundIndex,
    });
    await abortableDelay(this.config.delayMs, context.signal);
    if (this.config.failTaskIds.includes(context.task.id)) {
      throw new Error(`模拟失败: ${context.task.id}`);
    }

    const htmlPath = path.join(context.workspacePath, "index.html");
    if (roundIndex === 0) {
      await writeFile(htmlPath, renderGame(context.task.title, context.model.id), "utf8");
    } else {
      const current = await readFile(htmlPath, "utf8");
      await writeFile(
        htmlPath,
        current.replace(
          "</body>",
          `<div class="round-note">Round ${roundIndex + 1}: ${escapeHtml(round.id)}</div></body>`,
        ),
        "utf8",
      );
    }
    context.emit("harness.file.edited", "info", "index.html 已更新", {
      file: "index.html",
      roundIndex,
    });
    context.emit("harness.tool.completed", "info", "游戏文件修改完成", {
      tool: "write",
      roundIndex,
    });
    return {
      response: `Mock model completed ${round.id}`,
      usage: {
        input: round.prompt.length,
        output: 128,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
    };
  }

  async abortRun(): Promise<void> {}
}

function renderGame(title: string, modelId: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f8fafc; background: radial-gradient(circle at 50% 20%, #1e3a5f, #07111f 60%); font-family: system-ui, sans-serif; }
    main { width: min(720px, 90vw); text-align: center; }
    canvas { width: 100%; aspect-ratio: 16/9; border: 1px solid #38bdf855; border-radius: 20px; background: #020617; box-shadow: 0 30px 80px #0008; }
    .round-note { position: fixed; left: 16px; bottom: 16px; color: #94a3b8; font-size: 12px; }
  </style>
</head>
<body>
  <main><p>${escapeHtml(modelId)}</p><h1>${escapeHtml(title)}</h1><canvas id="game" width="960" height="540"></canvas></main>
  <script>
    const canvas = document.querySelector('#game');
    const context = canvas.getContext('2d');
    let x = 80;
    function frame() {
      context.fillStyle = '#020617'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#38bdf8'; context.beginPath(); context.arc(x, 270, 28, 0, Math.PI * 2); context.fill();
      x = (x + 3) % canvas.width; requestAnimationFrame(frame);
    }
    frame();
  </script>
</body>
</html>\n`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, durationMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("运行已取消"));
      },
      { once: true },
    );
  });
}
