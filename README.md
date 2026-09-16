# Game-Gen：游戏批量生成操作台

Game-Gen（界面名称为 **GameBench Studio**）用于批量调用多个模型生成游戏源码。你上传题库、选择模型并设置并发后，平台会自动展开 `题目 × 模型` 运行矩阵，通过 OpenCode 执行多轮 Prompt，并在网页中持续显示进度、日志、上下文和源码位置。

> **项目边界：只负责生成，不负责评测。** 本项目不包含自动评分、人工评分、质量排名或排行榜；生成结果应交给独立的 Benchmark 评测流程。

开发维护请参阅 [模块化架构说明](docs/architecture.md)，其中列出了各模块职责、依赖规则、功能修改入口和验证方式。

## 你可以用它完成什么

- 一次上传一个包含 1001 道题的聚合 JSON，或批量上传多个游戏 JSON。
- 为同一道题配置多轮 Prompt，并选择一次跑完或按阶段逐轮生成。
- 同时选择 GPT、Claude、DeepSeek、Kimi、Grok、GLM、PackyAPI 等 OpenCode 已接入模型。
- 分别限制全局、供应商和单模型并发，避免瞬间压垮模型渠道或本机 OpenCode。
- 在操作台中暂停派发、恢复任务、查看重试原因和每个游戏的实时状态。
- 按“游戏名称 / 模型 / 尝试次数”保存源码，并单独保存每一轮完整上下文。

## 开始之前

### 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | `24.0.0` 或更高版本，项目使用了 Node.js 内置 SQLite |
| npm | 随 Node.js 安装；推荐使用仓库中的 `package-lock.json` 执行 `npm ci` |
| 系统 | Windows 10/11 可直接使用；macOS 和 Linux 也可运行 Node.js 服务 |
| 浏览器 | Chrome、Edge 或其他现代浏览器 |
| 网络 | 能访问你所选择的模型供应商 API |
| 硬件 | 小批次没有特殊要求；高并发建议至少 16 GB 内存并预留足够磁盘空间 |

OpenCode CLI 和 SDK 已列为项目依赖，执行依赖安装时会一并安装，不需要再单独下载。真实生成还需要你自己的供应商账号、API Key 或 OAuth 登录；仅体验界面和流程时不需要任何 Key。

### 下载、安装和启动

Windows PowerShell 推荐使用以下命令。使用 `npm.cmd` 可以避开部分电脑的 PowerShell 脚本执行策略限制。

```powershell
git clone https://github.com/juyi404/Game-Gen.git
cd Game-Gen
node --version
npm.cmd ci
npm.cmd run build
npm.cmd start -- serve --port 8787
```

看到“监控面板”地址后，在浏览器打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。操作台只监听本机地址，不会默认暴露到局域网或公网。

如果 `8787` 已被占用，可以改用其他端口，例如：

```powershell
npm.cmd start -- serve --port 8793
```

开发时可跳过构建，直接运行 TypeScript 源码：

```powershell
npm.cmd run dev -- serve --port 8787
```

macOS 或 Linux 使用相同命令，将 `npm.cmd` 换成 `npm` 即可。停止前台服务时按 `Ctrl+C`；再次启动会恢复最近一个尚未结束的批次。

更新到仓库最新版本时，先暂停派发、等待正在运行的数量归零，再按 `Ctrl+C` 停止旧后端，然后执行：

```powershell
git pull --ff-only
npm.cmd ci
npm.cmd run build
npm.cmd start -- serve --port 8787
```

`.gamebench/` 和 `runs/` 不会被 `git pull` 覆盖；它们仍会保留你的题库、运行状态、上下文和游戏源码。更新前如果有重要批次，仍建议额外备份这两个目录。

### 端口和本地目录

| 用途 | 默认值 | 说明 |
| --- | --- | --- |
| 网页操作台 | `127.0.0.1:8787` | 可通过 `--port` 修改 |
| OpenCode 服务 | `127.0.0.1:4096` | 平台优先复用健康实例，否则自动启动 |
| 平台状态 | `.gamebench/platform/` | 题库、配置和 SQLite 数据库；不要提交到 Git |
| 游戏源码 | `runs/<实验 ID>/` | 页面会显示每一批和每个游戏的准确路径 |

正常使用操作台不要求预先设置环境变量，也不需要在项目根目录创建 `config.json`。请在网页中连接模型，或使用 OpenCode CLI 登录。`.env`、`config.json`、`.gamebench/` 和 `runs/` 已被 Git 忽略，但仍不要把真实 Key 写入题库或源码文件。

## 第一次使用建议

1. 连接聚合 API、PackyAPI 或 OpenCode 原生供应商，并至少让一个模型通过 OpenCode 端到端工具调用验证。
2. 导入并选择实际题库，再从可用模型池中勾选一个或多个本次运行模型。
3. 先启用“流程演练模式”，确认 JSON 能成功导入且保存目录符合预期。
4. 用 1–3 道题完成真实小批次测试；正式运行时先将全局并发设为 `4`，稳定后再提高到 `8`。
5. 确认选择了“分阶段生成”，避免一次性执行全部四轮并消耗大量 Token。
6. 临时停止时使用“暂停派发”；只有确定不再继续该批次时才使用“取消”。

## 从网页启动一次生成

页面创建任务的固定顺序是：连接并验证 API → 导入并选择题库 → 为题库多选模型 → 设置生成策略。第一步未验证出模型时，题库上传和选择区会锁定。API 验证只更新可用模型池，不会自动把全部模型绑定到任务；每个题库的模型选择会独立保存在本机，切换题库或刷新页面时会恢复对应配置。

### 题库格式与导入

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

### API、模型与凭据

页面不会预填可能已经过期的模型标识。聚合 API、PackyAPI 和 OpenCode 原生供应商使用同一个验证池；只有通过 OpenCode 正式链路写文件工具探针的模型才会进入第三步多选列表。点击“供应商与模型”可查看候选目录并逐个或批量验证；“刷新并复测”会重新读取目录，并对已有验证记录执行端到端复测。验证记录具有有效期，过期后必须重新通过探针。

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

推理强度不会使用一套写死的通用列表，而是按“供应商 + 模型”读取；同名模型通过不同渠道接入时，可选档位也可能不同。页面默认选择“供应商默认”，只有 OpenCode 确认支持的档位才允许选择；固定推理模型会明确标记为不可调整。`max`、`xhigh`、`ultra` 等名称并不保证在所有模型上具有相同含义，请以页面同步结果为准。你的选择会写入实验配置、生成信息、每轮上下文、单次结果和总清单，并在同一游戏的所有轮次保持一致。

#### 可选：聚合供应商自动发现

对于兼容 OpenAI API 的聚合供应商，可在“第一步 · API”点击“填写 API 并验证模型”，填写该供应商的 HTTPS API Base URL（例如 `https://gateway.example.com/v1`）和 API Key。平台先读取 `/models`，再以最多 4 路并发执行直连工具调用筛选；工具名称和参数 `ok=true` 都正确的候选模型才会写入 `aggregate-*` OpenCode Provider。配置完成后，平台还会通过 OpenCode 正式运行链路执行写文件探针，只有第二次验证成功的模型才会进入可用模型池。单次目录验证最多接受 50 个模型，单次直连请求最多等待 15 秒，并按 `Retry-After` 处理限流，避免超大目录形成无限扫描。验证不会自动绑定题库；导入题库后可在第三步多选，单次任务最多选择 100 个模型。

API Key 本身不包含供应商地址，因此无法仅凭 Key 安全判断应该请求哪个网站；Base URL 必须由用户明确提供。聚合目录通常不声明工具调用能力，因此平台不会仅凭 `/models` 的返回结果判定可用，而会以实际工具调用探针结果为准。

#### 可选：PackyAPI

如需使用，在供应商窗口点击“连接 PackyAPI 分组”，选择 Key 对应的分组并输入 Key。平台会同步这把 Key 实际有权限访问的源码生成候选模型；指定某个目标模型接入时会立即执行 OpenCode 端到端验证，整组接入时则可在供应商窗口逐个或批量验证。只有验证成功的 PackyAPI 模型才会进入普通多选流程。OpenCode 原生供应商同样可以在供应商窗口完成登录后逐个验证和选择，不再受聚合供应商前缀限制。

所有通过页面输入的 API Key 都交给本机 OpenCode 凭据库管理，不会写入题库、实验配置或 SQLite，也不会由网页接口返回。操作台默认只监听 `127.0.0.1`；当面板绑定到非本机地址时，网页密钥管理接口会自动禁用。

启动真实任务前，后端会再次强制检查验证记录；记录缺失或过期时会重新执行 OpenCode 端到端探针，然后再校验供应商、模型标识、推理档位、工具能力和凭据状态。直接绕过前端调用 `/api/experiments` 也不能提交未通过真实探针的模型。OpenCode 默认端口被占用时，平台会复用健康服务或自动选择可用端口。

也可以继续使用 OpenCode CLI 登录：

```powershell
npx.cmd opencode auth login
npx.cmd opencode models
```

不要把 API Key 发到聊天中，也不要放进游戏 JSON。

### 设置并发

网页可设置三层并发限制：

- **全局并发**：整批任务最多同时运行多少个游戏生成任务。
- **供应商并发**：同一供应商下所有模型共享的上限。
- **单模型并发**：每个模型行单独的上限。

实际并发满足：

```text
有效并发 = min(全局剩余, 供应商剩余, 单模型剩余)
```

对于单机运行，推荐从全局并发 `4` 开始，确认稳定后再提高到 `8`。不要仅因为有两个模型就把全局并发设为两者上限之和：例如两个模型各设为 `6`、全局设为 `8` 时，整机同时最多仍是 `8` 个任务。是否继续提高应同时参考供应商 RPM/TPM、账号额度，以及本机 CPU、内存、磁盘和网络压力。

一次性设置 `32` 路或更高并发会让单个 OpenCode 进程同时维护大量会话、事件流和工具调用，可能造成连接中断和集中重试。框架将 OpenCode 本地连接故障作为全局熔断处理；供应商的 `429`、`502`、`503`、`504` 等故障则按 Provider 独立熔断，只暂停对应线路，并使用同一 Provider 的任务探测恢复。基础设施重试不消耗正常生成尝试额度，但每条运行最多重开 4 次或累计等待 30 分钟，超过后会进入明确的阻塞失败状态，避免永久重试。

### 分阶段生成

“分阶段生成”默认开启，适合四轮 Prompt 等需要人工控制成本和节奏的题库：

1. 首次点击“开始批量生成”只执行全部“题目 × 模型”的第 1 轮。
2. 本阶段全部成功后，任务进入“本阶段已完成”，不会自动消耗下一轮 Token。
3. 在监控页点击“开始第 2 阶段”，平台才会执行第 2 轮；后续阶段相同。
4. 每个运行始终沿用相同的运行 ID、当前成功的 `attempt-N` 源码目录、OpenCode `sessionId` 和已保存的历史上下文；如果前一阶段发生正式重试，则后续阶段会继续使用成功的新尝试目录。

阶段之间可以关闭操作台，稍后重新启动后继续。若当前阶段有失败项，需要先重试失败项；全部运行到达当前阶段边界后才能启动下一阶段。关闭“分阶段生成”后，行为与旧版本一致，会在同一次运行中连续执行全部 Prompt。

### 启动与监控

启动卡片会实时计算：

```text
总运行数 = 题目数 × 启用模型数
```

点击“开始批量生成”后，平台会创建完整运行矩阵并立即派发。监控页支持：

- 暂停派发新任务、继续运行，或永久取消整批任务。
- 按模型和题目查看实时进度。
- 查看每轮 Prompt、模型响应、OpenCode 工具事件和错误。
- 查看并复制每一轮独立上下文 JSON 的保存路径。
- 查看当前阶段，并在整批完成后手动启动下一阶段。
- 重跑失败项。
- 打开生成的静态游戏或复制本次源码目录。

进程被关闭后，重新执行启动命令会恢复最近一个未完成任务。**暂停**只停止派发新运行，已经在生成的任务会继续完成；**取消**会终止整个批次并把排队项标记为已取消，不能再通过“继续运行”恢复。需要暂时停下来时请使用“暂停”，不要使用“取消”。

## 常见问题

### 为什么降低并发后仍可能出现重试？

重试不一定代表并发失控。打开任务详情可以看到准确错误，常见情况分为两类：

- **基础设施故障**：例如 `fetch failed`、连接被拒绝、证书错误、`429` 或供应商 `5xx`。OpenCode 本地故障会熔断整批派发；网关故障只熔断对应 Provider，并使用同线路探针恢复。这类故障不扣减正常生成尝试额度，但有 4 次/30 分钟的独立终止上限。
- **生成结果无效**：模型正常结束但没有写文件、`index.html` 仍是占位页、缺少可运行脚本，或供应商返回 `0 token / finish=unknown` 的空结束。框架必须重新生成，否则保存下来的只是空白或不可玩的游戏。

因此平台无法承诺绝对零重试；它能保证的是限制重试范围、保留失败现场、避免基础设施故障形成重试风暴，并且不会把无效占位页当作成功游戏。某个任务显示“等待重试”时，如果全局并发已经占满，它会等到有空位后优先重新执行，并不是卡死。

### API Key 保存在哪里？

通过页面输入的 Key 交给本机 OpenCode 凭据库管理，不写入题库、实验配置、SQLite、游戏源码或 Git 仓库。不要把真实 Key 放进 `config.json`、`.env`、Prompt JSON、README、截图或聊天内容；如果 Key 曾以明文出现在这些位置，建议到供应商后台轮换。

### 游戏和每轮上下文保存在哪里？

启动页和监控页都会显示绝对路径。默认源码根目录是 `runs/<实验 ID>/`，每个游戏的每个模型都有独立目录；多轮 Prompt 继续修改同一份源码，每轮完整上下文分别保存在 `.benchmark/round-contexts/`。

### 关闭浏览器会停止生成吗？

不会。生成由本机 Node.js 后端执行，关闭网页只会停止查看界面。关闭终端或结束后端进程才会中断服务；重新启动后端时，平台会从数据库恢复最近的未完成批次。

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
    { "id": "gpt-high", "model": "openai/gpt-5", "reasoningEffort": "high", "concurrency": 4 },
    { "id": "claude", "model": "anthropic/claude-sonnet-4-5", "concurrency": 4 }
  ],
  "runtime": {
    "harness": "opencode",
    "stageMode": "all",
    "globalConcurrency": 8,
    "providerConcurrency": { "openai": 4, "anthropic": 4 },
    "workspaceTemplate": "./template",
    "outputDir": "../runs",
    "dataDir": "../.gamebench",
    "roundTimeoutMs": 0,
    "roundIdleTimeoutMs": 1800000,
    "maxAttempts": 3,
    "retryBackoffMs": 60000
  }
}
```

`roundTimeoutMs` 是单轮硬时限（毫秒），`0` 表示不设硬时限；`roundIdleTimeoutMs` 是连续收不到模型事件时的空闲时限，默认 `1800000`（30 分钟），`0` 表示关闭。两者最大均为 24 小时，任一时限触发后本轮会按普通失败进入有限重试，不会被误判成网关故障并无限重试。

## 可选环境变量

日常通过网页生成游戏时没有必填环境变量。以下变量只用于仓库自带的验收脚本，建议仅在当前终端临时设置：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `GAMEBENCH_BASE_URL` | 验收脚本访问操作台的地址 | `http://127.0.0.1:8787` |
| `GAMEBENCH_OPENCODE_URL` | 全模型冒烟测试访问 OpenCode 的地址 | `http://127.0.0.1:4096` |
| `GAMEBENCH_VERIFY_PROVIDERS` | 用正则筛选要测试的供应商 | 全部已连接供应商 |
| `GAMEBENCH_VERIFY_MODELS` | 用正则筛选要测试的模型 | 全部可工具调用模型 |
| `GAMEBENCH_VERIFY_EXCLUDE` | 用正则排除供应商或模型 | 无 |
| `GAMEBENCH_VERIFY_CONCURRENCY` | 全模型冒烟测试的总并发 | `12` |
| `GAMEBENCH_VERIFY_PROVIDER_CONCURRENCY` | 冒烟测试的单供应商并发 | `3` |
| `GAMEBENCH_VERIFY_TIMEOUT_MS` | 单模型冒烟测试超时 | `300000` |
| `GAMEBENCH_VERIFY_REASONING_EFFORT` | 强制使用指定推理强度 | 按模型自动选择 |

PowerShell 示例：

```powershell
$env:GAMEBENCH_BASE_URL = "http://127.0.0.1:8793"
npm.cmd run verify:models
Remove-Item Env:GAMEBENCH_BASE_URL
```

## 数据目录

默认网页操作台使用：

```text
.gamebench/platform/
  benchmark.sqlite
  datasets/<dataset-id>/
  configs/<generated-config>.json

runs/<experiment-id>/
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

### 可选：全部连接模型冒烟测试

需要逐个确认当前 OpenCode 中已连接的模型能否真正调用工具并生成游戏源码时，可运行：

```powershell
$env:GAMEBENCH_BASE_URL = "http://127.0.0.1:8787"
$env:GAMEBENCH_OPENCODE_URL = "http://127.0.0.1:4096"
npm.cmd run verify:models
```

测试器会为每个可工具调用模型创建隔离会话和目录，要求模型实际修改 `index.html`，并检查可玩脚本与连接标记。它会消耗真实 Token 并增加 OpenCode 负载，不建议与正式批量生成同时运行。可通过 `GAMEBENCH_VERIFY_PROVIDERS`、`GAMEBENCH_VERIFY_MODELS`、`GAMEBENCH_VERIFY_EXCLUDE`、`GAMEBENCH_VERIFY_CONCURRENCY`、`GAMEBENCH_VERIFY_PROVIDER_CONCURRENCY`、`GAMEBENCH_VERIFY_TIMEOUT_MS` 和 `GAMEBENCH_VERIFY_REASONING_EFFORT` 缩小范围或调整并发。报告、会话上下文和测试源码保存在 `.gamebench/verification/connected-models-<时间>/`，不会混入正式 `runs/` 目录。
