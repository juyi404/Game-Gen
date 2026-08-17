# 游戏批量生成台

GameBench Studio 是一个只负责“批量生成游戏”的 Benchmark 操作平台。它把题库和模型展开为 `题目 × 模型` 运行矩阵，通过 OpenCode 维持每道题的多轮生成会话，并提供并发调度、失败重试、断点恢复和实时监控。

本项目不实现自动评分、人工评分、质量判断或排行榜；生成产物可交给独立评测系统处理。

## 启动操作台

要求 Node.js 24 或更高版本。

```powershell
npm.cmd install
npm.cmd run dev
```

浏览器打开 `http://127.0.0.1:8787`。生产构建可使用：

```powershell
npm.cmd run build
npm.cmd start
```

操作台默认提供两个工作区：

1. **新建任务**：上传题库、配置模型凭据、设置并发并启动整批生成。
2. **生成监控**：查看总体进度、模型进度、题目矩阵、日志、源码目录和游戏产物。

## 从网页启动一次生成

### 1. 批量上传题库

在“导入游戏题目 JSON”中可以：

- 直接上传一个包含全部游戏的聚合 `.json` 文件。
- 一次选择任意数量的 `.json` 文件。
- 直接选择包含全部题目的文件夹。
- 将多个 JSON 拖入上传区域。

平台会先校验全部文件，只有整个批次合法时才会保存。已导入题库保存在本机，下次启动无需再次上传。

支持以下两种格式。每个游戏使用一个 JSON 文件时，推荐格式为：

```json
{
  "id": "space-game-001",
  "title": "太空生存游戏",
  "rounds": [
    { "id": "initial", "prompt": "制作一个可运行的基础版本……" },
    { "id": "polish", "prompt": "优化操作手感、视觉反馈和完整度……" }
  ],
  "metadata": {
    "category": "action"
  }
}
```

也可以把全部游戏放在同一个聚合 JSON 中，无需手动拆分文件：

```json
{
  "dataset": "1001个游戏四轮prompt",
  "count": 1001,
  "games": [
    {
      "id": "game-0001",
      "title": "第一个游戏",
      "rounds": [
        { "id": "initial-build", "prompt": "制作一个可运行的基础版本……" },
        { "id": "add-and-polish", "prompt": "增加内容并优化完成度……" },
        { "id": "self-play-and-revise", "prompt": "自行试玩并修正问题……" },
        { "id": "final-pass", "prompt": "完成最终检查和打磨……" }
      ],
      "metadata": {}
    }
  ]
}
```

约束：

- `id` 在整个题库中必须唯一，只能包含字母、数字、点、下划线和短横线。
- `rounds` 至少包含一轮，字符串和 `{ "id", "prompt" }` 两种写法都支持。
- 聚合格式中的 `count` 必须等于 `games` 数组长度；运行顺序与 `games` 数组顺序一致。
- 同一道题的所有轮次会在同一个 OpenCode Session 中严格顺序执行。
- 网页批量上传适合 Prompt 全部写在 JSON 中的题库。CLI 目录模式仍支持 `promptFile`、`seedDir` 等外部文件。

### 2. 配置模型和凭据

页面不会预填可能已经过期的模型标识。点击“供应商与模型”后，可以在同一个窗口查看 OpenCode 实际返回的全部 Provider、登录状态和可生成模型；GPT、Claude、DeepSeek、Kimi、Grok、PackyAPI 都使用同一套模型加入和接入检查流程。“刷新接入状态”会重新读取本机 OpenCode，并同步 PackyAPI 官方实时模型目录。

模型标识必须使用 OpenCode 的 `provider/model` 格式。以下仅为格式示例，实际标识以页面同步结果为准：

```text
openai/gpt-5
anthropic/claude-sonnet-4-5
deepseek/deepseek-chat
moonshotai/kimi-k2.5
xai/grok-4
```

每个模型行会直接显示“可用 / 尚未登录 / 模型不存在 / 不能生成源码”等检查结果，并支持：

- 输入 API Key 并保存到本机 OpenCode 凭据库。
- 对 OpenCode 提供 OAuth 方法的供应商发起账号登录。
- 检查供应商是否已经通过 OpenCode CLI、环境变量或网页连接。
- 按模型选择 OpenCode 实际返回的推理强度；不同模型会分别显示自己的 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra` 等可用子集。

推理强度不会使用一套写死的通用列表，而是按“供应商 + 模型”读取；同名模型经不同供应商接入时，可选档位也可能不同。页面默认选择“供应商默认”；只有 OpenCode 确认该模型支持的档位才允许选择。固定推理模型会标记为“固定推理（不可调）”。所选档位会保存到实验配置、源码目录中的生成信息、每轮上下文文件、单次结果和总清单中，并在同一游戏的所有 Prompt 轮次保持一致。

[OpenAI 官方 GPT-5.6 Sol API 模型页](https://developers.openai.com/api/docs/models/gpt-5.6-sol)说明其 `reasoning.effort` 支持 `none`、`low`、`medium`、`high`、`xhigh`、`max`。[Codex 模型说明](https://learn.chatgpt.com/docs/models)中的 `ultra` 是会启用子代理的执行模式，不是模型 API 的推理强度。因此 PackyAPI/OpenAI 路径不会被强行添加一个无效的 `ultra`；GPT-5.6 Sol/Terra 的下拉框旁会明确显示这条边界提示。如果以后 OpenCode 为某个模型真实返回 `ultra` variant，操作台会自动把它显示为可选档位并透传。

#### PackyAPI

PackyAPI 在操作台中只显示为一个独立供应商，与 OpenAI、Anthropic、DeepSeek 等供应商同级。平台读取 `https://www.packyapi.ai/api/pricing` 的官方实时目录，并展示全部模型、厂商、可用分组和协议能力；图像、审核等不适合生成源码的模型仍会显示，但不会允许加入游戏生成任务。目录在服务端缓存 5 分钟，也可以在页面手动刷新。

使用时点击“连接 PackyAPI 分组”，选择 API Key 所属分组并输入 Key。无需再填写 Provider ID、Base URL 或模型 ID，平台会：

- 自动同步该分组当前全部游戏生成模型。
- 保存前通过 PackyAPI 的 `/v1/models` 做零 Token Key 校验；从某个模型发起连接时，会强制确认 Key 包含该目标模型，并自动选择最匹配的分组。
- 根据模型分组自动选择 OpenAI、Anthropic 或 Google AI SDK 协议，并启用 PackyAPI 要求的 `setCacheKey`。
- 在后台维护分组对应的 OpenCode Provider；这些底层渠道在操作台里会统一聚合到 PackyAPI，不会作为多个供应商重复展示。
- 将不含 Key 的 PackyAPI Provider 配置持久化到平台数据目录，并在新增分组后自动重载平台自管的 OpenCode 实例。
- 把 API Key 保存到 OpenCode 本机凭据库，不写入 Provider 配置。
- 在主模型下拉中置顶展示 PackyAPI 全部实时模型；未接入模型可从该行直接连接对应分组 Key。
- 允许逐个选择模型，也可以一键把所有已接入模型加入本次任务。

PackyAPI 的每把 Key 只对应一个模型分组；要同时使用多个分组，需要分别连接对应 Key。可用分组和模型以页面同步到的 PackyAPI 实时目录为准。这个聚合由本框架完成，不需要修改或 fork OpenCode 源码。

API Key 不会写入题库、Benchmark 配置或 SQLite，也不会由网页接口返回。操作台默认只监听 `127.0.0.1`；当面板绑定到非本机地址时，网页密钥管理接口会自动禁用。

启动真实任务前，后端还会再次强制校验供应商、模型标识、工具调用能力和凭据状态，避免把无效模型加入运行矩阵。OpenCode 默认端口被占用时，平台会复用健康服务或自动选择可用端口。

也可以继续使用 OpenCode CLI 登录：

```powershell
npx.cmd opencode auth login
npx.cmd opencode models
```

不要把 API Key 发到聊天中，也不要放进游戏 JSON。

### 3. 设置并发

网页可设置三层并发限制：

- **全局并发**：整批任务最多同时运行多少个游戏生成任务。
- **供应商并发**：同一供应商下所有模型共享的上限。
- **单模型并发**：每个模型行单独的上限。

实际并发满足：

```text
有效并发 = min(全局剩余, 供应商剩余, 单模型剩余)
```

建议先用 2–8 的全局并发跑一个小批次，再根据各供应商 RPM、TPM、账号额度以及本机 CPU、内存、磁盘和网络压力逐步提高。高并发不仅消耗 API 配额，OpenCode 的工具调用、依赖安装和游戏构建也会占用本机资源。

### 4. 分阶段生成

“分阶段生成”默认开启，适合四轮 Prompt 等需要人工控制成本和节奏的题库：

1. 首次点击“开始批量生成”只执行全部“题目 × 模型”的第 1 轮。
2. 本阶段全部成功后，任务进入“本阶段已完成”，不会自动消耗下一轮 Token。
3. 在监控页点击“开始第 2 阶段”，平台才会执行第 2 轮；后续阶段相同。
4. 每个运行始终沿用相同的运行 ID、`attempt-1` 源码目录、OpenCode `sessionId` 和已保存的历史上下文。

阶段之间可以关闭操作台，稍后重新启动后继续。若当前阶段有失败项，需要先重试失败项；全部运行到达当前阶段边界后才能启动下一阶段。关闭“分阶段生成”后，行为与旧版本一致，会在同一次运行中连续执行全部 Prompt。

### 5. 启动与监控

启动卡片会实时计算：

```text
总运行数 = 题目数 × 启用模型数
```

点击“开始批量生成”后，平台会创建完整运行矩阵并立即派发。监控页支持：

- 暂停派发新任务、继续运行、取消整批任务。
- 按模型和题目查看实时进度。
- 查看每轮 Prompt、模型响应、OpenCode 工具事件和错误。
- 查看并复制每一轮独立上下文 JSON 的保存路径。
- 查看当前阶段，并在整批完成后手动启动下一阶段。
- 重跑失败项。
- 打开生成的静态游戏或复制本次源码目录。

进程被关闭后，重新执行 `npm.cmd run dev` 会恢复最近一个未完成任务。暂停只停止派发新运行，不会强制中止当前正在生成的运行。

## 不花费 API 额度的流程测试

在“高级设置”中启用 **流程演练模式**，即可完整测试题库上传、矩阵创建、并发、监控、结果保存和产物预览，而不调用真实模型。

仓库也提供 CLI Mock 示例：

```powershell
npm.cmd run dev -- validate -c examples/benchmark.mock.json
npm.cmd run dev -- run -c examples/benchmark.mock.json
```

## CLI 配置模式

原有配置文件模式继续可用：

```powershell
npm.cmd run dev -- validate -c examples/benchmark.opencode.json
npm.cmd run dev -- run -c examples/benchmark.opencode.json
npm.cmd run dev -- serve -c examples/benchmark.opencode.json
```

核心配置示例：

```json
{
  "version": 1,
  "name": "My Game Benchmark",
  "dataset": { "dir": "./tasks", "include": [] },
  "models": [
    { "id": "gpt-high", "model": "openai/gpt-5", "reasoningEffort": "high", "concurrency": 8 },
    { "id": "claude", "model": "anthropic/claude-sonnet-4-5", "concurrency": 8 }
  ],
  "runtime": {
    "harness": "opencode",
    "stageMode": "all",
    "globalConcurrency": 16,
    "providerConcurrency": { "openai": 8, "anthropic": 8 },
    "workspaceTemplate": "./template",
    "outputDir": "../runs",
    "dataDir": "../.gamebench",
    "roundTimeoutMs": 0,
    "maxAttempts": 3,
    "retryBackoffMs": 15000
  }
}
```

`roundTimeoutMs` 固定归一为 `0`，表示每轮不限时。框架不会因为生成耗时而终止模型；仅在模型正常完成、供应商返回错误、用户主动取消或操作台关闭时结束当前调用。

## 数据目录

默认网页操作台使用：

```text
.gamebench/platform/
  benchmark.sqlite
  datasets/<dataset-id>/
  configs/<generated-config>.json

runs/<task-batch-id>/
  manifest.json                         整批运行结果清单
  <game-name>/                           使用题目中的游戏名称，支持中文
    <model-id>/attempt-N/                同一次尝试的全部 Prompt 轮次共用此源码目录
      .benchmark/generation.json        本次生成的输入元信息
      .benchmark/result.json            本次生成的最终状态与轮次结果
      .benchmark/round-contexts/
        001-<round-id>.json             第一轮完整上下文
        002-<round-id>.json             第二轮完整上下文
      index.html
      模型生成的其他源码文件
```

同一游戏的不同模型保存在各自的模型子目录中；如果题库里存在同名游戏，平台会仅为重名项追加题目 ID，防止源码相互覆盖。多轮 Prompt 不会创建多份源码：第 1 轮创建游戏，第 2 轮及后续轮次继续修改同一个 `index.html` 和相关文件，并沿用相同的 OpenCode Session 与历史上下文。`.benchmark/round-contexts/` 中分别保存的只是每轮上下文 JSON。

每个逐轮上下文文件都是自包含的，记录题目、模型、尝试次数、系统提示词、原始与变量替换后的当前 Prompt、该轮开始前的历史用户/助手对话、本轮响应、Token 用量、状态、错误，以及 OpenCode Session 在该轮结束后的完整消息与工具调用快照。文件在该轮开始时先创建，成功或失败后再原子更新，因此异常轮次也会保留现场。

启动页会显示源码保存根目录，监控页会显示本批源码目录和 `manifest.json` 路径，单次运行详情会显示该次源码目录、`result.json`、逐轮上下文目录和每轮文件路径。`result.json` 的每个轮次和整批 `manifest.json` 也会引用对应上下文路径。数据库只有在所有结果文件落盘后才会把整批任务标记为完成。

每次自动或手动重试都会创建新的 `attempt-N`，失败产物不会被覆盖。当前版本由单进程主动调度一批任务；如果未来需要跨机器的数百个 Worker，可将运行队列迁移到 Redis/PostgreSQL 并复用现有控制台和数据模型。

## 开发检查

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

自动化测试包含网页控制 API 的完整演练链路，并验证完整题目 × 模型矩阵、同一 Session 的多轮顺序、全局/供应商/单模型三层并发、成功与失败轮次上下文，以及源码结果清单落盘。

### 一键全功能验收

操作台已运行且 PackyAPI 已连接时，可以执行本地测试、类型检查、构建和真实 Token 验收：

```powershell
$env:GAMEBENCH_BASE_URL = "http://127.0.0.1:8787"
npm.cmd run verify:all
```

如果操作台还没有连接 PackyAPI，可只在当前 PowerShell 进程中提供 Key。验收器会通过本机操作台连接分组，不会把 Key 写入报告、题库、实验配置或源码目录：

```powershell
$env:GAMEBENCH_BASE_URL = "http://127.0.0.1:8787"
$env:PACKY_GROUP = "codex"
$env:PACKY_API_KEY = "你的 PackyAPI Key"
npm.cmd run verify:all
Remove-Item Env:PACKY_API_KEY
```

真实验收会运行两层矩阵：

- 两道游戏题分别使用 GPT-5.6 Sol `xhigh`、Terra `high`、Luna `low`，验证 4 并发、多轮 Session、源码和逐轮上下文。
- 单独使用 GPT-5.6 Sol `max` 跑最小两轮工具用例，避免大型补丁的供应商长连接限制干扰档位接入判断。
- 自动检查实时 SSE、模型接入状态、OpenCode 快照中的真实 variant、输出目录、`result.json`、全部轮次上下文、`manifest.json`、游戏预览接口和内部路径保护。
- 遇到最终失败运行时，自动调用控制台的手动重跑接口，最多再重跑三轮，并检查失败 `attempt-N` 产物没有被覆盖。

报告默认保存在 `.gamebench/verification/<时间>/live-packy-report.json`，真实游戏源码仍保存在页面显示的 `runs/<实验 ID>/` 目录。

### 全部连接模型冒烟测试

需要逐个确认当前 OpenCode 中已连接的模型能否真正调用工具并生成游戏源码时，可运行：

```powershell
$env:GAMEBENCH_BASE_URL = "http://127.0.0.1:8793"
$env:GAMEBENCH_OPENCODE_URL = "http://127.0.0.1:10337"
npm.cmd run verify:models
```

测试器会为每个可工具调用模型创建隔离会话和目录，要求模型实际修改 `index.html`，并检查可玩脚本与连接标记。可通过 `GAMEBENCH_VERIFY_PROVIDERS`、`GAMEBENCH_VERIFY_MODELS`、`GAMEBENCH_VERIFY_EXCLUDE`、`GAMEBENCH_VERIFY_CONCURRENCY`、`GAMEBENCH_VERIFY_PROVIDER_CONCURRENCY`、`GAMEBENCH_VERIFY_TIMEOUT_MS` 和 `GAMEBENCH_VERIFY_REASONING_EFFORT` 缩小范围或调整并发。报告、会话上下文和测试源码保存在 `.gamebench/verification/connected-models-<时间>/`，不会混入正式 `runs/` 目录。
