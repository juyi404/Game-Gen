import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = resolve(process.argv[2] ?? "reports/c0b72452-stage1-report-source.json");
const outputPath = resolve(process.argv[3] ?? "reports/c0b72452-stage1-cost-report.html");
const runs = JSON.parse(readFileSync(sourcePath, "utf8"));

const experiment = {
  id: "c0b72452-0d1b-49dd-924a-ccbe1eaf4d5e",
  name: "30 questions - 6 models - clean OpenCode baseline - stage 1 - concurrency 18",
  stage: 1,
  totalRuns: 180,
  generatedAt: "2026-09-08T16:42:00+08:00",
};

// modelRatio/completionRatio come from the experiment's immutable billing snapshot.
// Group, cache and peak multipliers come from Packy's public pricing catalog.
const pricing = {
  "deepseek-v4-flash": {
    label: "DeepSeek V4 Flash", color: "#52e7b2", modelRatio: 0.75,
    completionRatio: 3, groupRatio: 1, modelGroupRatio: 0.8,
    cacheReadRatio: 0.0333, cacheWriteRatio: 1, peakFactor: 2,
    group: "deepseek-officially",
  },
  "kimi-k3": {
    label: "Kimi K3", color: "#8eb8ff", modelRatio: 10,
    completionRatio: 5, groupRatio: 0.95, modelGroupRatio: 1,
    cacheReadRatio: 0.1, cacheWriteRatio: 1, peakFactor: 1,
    group: "kimi-officially",
  },
  "glm-5-3": {
    label: "GLM-5.3", color: "#bca0ff", modelRatio: 4,
    completionRatio: 3.5, groupRatio: 1, modelGroupRatio: 0.5,
    cacheReadRatio: 0.25, cacheWriteRatio: 1, peakFactor: 1,
    group: "glm-sale",
  },
  "claude-fable-5": {
    label: "Claude Fable 5", color: "#ffbd7a", modelRatio: 5,
    completionRatio: 5, groupRatio: 2, modelGroupRatio: 1,
    cacheReadRatio: 0.1, cacheWriteRatio: 1.25, peakFactor: 1,
    group: "cc",
  },
  "claude-opus-5": {
    label: "Claude Opus 5", color: "#ff7f8e", modelRatio: 2.5,
    completionRatio: 5, groupRatio: 2, modelGroupRatio: 1,
    cacheReadRatio: 0.1, cacheWriteRatio: 1.25, peakFactor: 1,
    group: "cc",
  },
  "gpt-5-6-sol": {
    label: "GPT-5.6 Sol", color: "#6cd7ff", modelRatio: 2.5,
    completionRatio: 6, groupRatio: 0.5, modelGroupRatio: 1,
    cacheReadRatio: 0.1, cacheWriteRatio: 1.25, peakFactor: 1,
    group: "codex",
  },
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function costParts(run) {
  const p = pricing[run.model_id];
  const unit = (2 * p.modelRatio * p.groupRatio * p.modelGroupRatio) / 1_000_000;
  const parts = {
    input: number(run.input_tokens) * unit,
    output: number(run.output_tokens) * p.completionRatio * unit,
    reasoning: number(run.reasoning_tokens) * p.completionRatio * unit,
    cacheRead: number(run.cache_read_tokens) * p.cacheReadRatio * unit,
    cacheWrite: number(run.cache_write_tokens) * p.cacheWriteRatio * unit,
    peakUplift: 0,
  };
  if (p.peakFactor > 1) {
    parts.peakUplift = (p.peakFactor - 1) * unit * (
      number(run.peak_input_tokens)
      + number(run.peak_output_tokens) * p.completionRatio
      + number(run.peak_reasoning_tokens) * p.completionRatio
      + number(run.peak_cache_read_tokens) * p.cacheReadRatio
      + number(run.peak_cache_write_tokens) * p.cacheWriteRatio
    );
  }
  parts.total = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return parts;
}

for (const run of runs) {
  run.pricing = costParts(run);
  run.estimated_cost = run.pricing.total;
  run.total_tokens = ["input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens"]
    .reduce((sum, key) => sum + number(run[key]), 0);
  run.final_total_tokens = ["final_input_tokens", "final_output_tokens", "final_reasoning_tokens", "final_cache_read_tokens", "final_cache_write_tokens"]
    .reduce((sum, key) => sum + number(run[key]), 0);
  run.extra_tokens = Math.max(0, run.total_tokens - run.final_total_tokens);
}

const totals = runs.reduce((summary, run) => {
  summary.estimatedCost += run.estimated_cost;
  summary.recordedCost += number(run.recorded_cost);
  summary.elapsedMs += number(run.elapsed_ms);
  summary.steps += number(run.step_count);
  summary.retries += number(run.retry_events);
  summary.dispatches += number(run.dispatch_count);
  summary.totalTokens += run.total_tokens;
  summary.finalTokens += run.final_total_tokens;
  for (const key of ["input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens"]) {
    summary[key] += number(run[key]);
  }
  for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "peakUplift"]) {
    summary.costParts[key] += run.pricing[key];
  }
  return summary;
}, {
  estimatedCost: 0, recordedCost: 0, elapsedMs: 0, steps: 0, retries: 0, dispatches: 0,
  totalTokens: 0, finalTokens: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
  cache_read_tokens: 0, cache_write_tokens: 0,
  costParts: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, peakUplift: 0 },
});

const firstStartedAt = Math.min(...runs.map((run) => number(run.first_started_at)).filter(Boolean));
const lastFinishedAt = Math.max(...runs.map((run) => number(run.finished_at)).filter(Boolean));
totals.wallClockMs = lastFinishedAt - firstStartedAt;
totals.extraTokens = totals.totalTokens - totals.finalTokens;

const modelSummaries = Object.keys(pricing).map((modelId) => {
  const subset = runs.filter((run) => run.model_id === modelId);
  const summary = {
    modelId, ...pricing[modelId], count: subset.length, estimatedCost: 0, elapsedMs: 0,
    steps: 0, retries: 0, totalTokens: 0, input_tokens: 0, output_tokens: 0,
    reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  };
  for (const run of subset) {
    summary.estimatedCost += run.estimated_cost;
    summary.elapsedMs += number(run.elapsed_ms);
    summary.steps += number(run.step_count);
    summary.retries += number(run.retry_events);
    summary.totalTokens += run.total_tokens;
    for (const key of ["input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens"]) {
      summary[key] += number(run[key]);
    }
  }
  summary.averageCost = summary.estimatedCost / Math.max(summary.count, 1);
  summary.averageElapsedMs = summary.elapsedMs / Math.max(summary.count, 1);
  return summary;
});

const reportData = JSON.stringify({ experiment, pricing, runs, totals, modelSummaries, firstStartedAt, lastFinishedAt })
  .replaceAll("</script", "<\\/script");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GameBench 第一阶段生成成本报告</title>
  <meta name="description" content="GameBench 30 道题 × 6 个模型第一阶段生成耗时、Token 与应计费用报告">
  <style>
    :root{color-scheme:dark;--bg:#07100f;--panel:#0c1816;--panel2:#101f1c;--line:#203a34;--text:#edf8f4;--muted:#8fac9f;--green:#52e7b2;--amber:#ffbd7a;--red:#ff7f8e;--blue:#6cd7ff;--shadow:0 16px 48px #0007}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 12% -10%,#123b31 0,transparent 34rem),linear-gradient(180deg,#07110f,#050b0a 70%);color:var(--text);font-family:Inter,"Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;font-size:16px;line-height:1.55}
    button,input,select{font:inherit}.shell{width:min(1600px,calc(100% - 32px));margin:auto;padding:32px 0 64px}.eyebrow{margin:0 0 8px;color:var(--green);font-size:.78rem;letter-spacing:.16em;text-transform:uppercase}.topline{display:flex;gap:24px;align-items:flex-end;justify-content:space-between;margin-bottom:26px}h1{font-size:clamp(1.8rem,3vw,3.25rem);letter-spacing:-.045em;line-height:1.05;margin:0;max-width:900px}.period{text-align:right;color:var(--muted);font-size:.92rem}.period b{display:block;color:var(--text);font-size:1rem}
    .notice{border:1px solid #725729;background:#2b2213;color:#ffe0a8;border-radius:14px;padding:13px 16px;margin:18px 0 22px}.notice strong{color:#fff0c9}.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.card{background:linear-gradient(145deg,#10201d,#0a1513);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:var(--shadow)}.kpi .label{color:var(--muted);font-size:.82rem}.kpi .value{font-variant-numeric:tabular-nums;font-size:clamp(1.45rem,2.3vw,2.25rem);font-weight:760;letter-spacing:-.04em;margin:7px 0 2px}.kpi .sub{font-size:.78rem;color:var(--muted)}.money{color:var(--green)}
    section{margin-top:28px}h2{font-size:1.18rem;margin:0 0 13px;letter-spacing:-.02em}.section-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:13px}.section-head h2{margin:0}.section-note{color:var(--muted);font-size:.84rem}.model-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.model-card{position:relative;overflow:hidden}.model-card:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--model)}.model-name{display:flex;align-items:center;justify-content:space-between;gap:10px}.model-name strong{font-size:1rem}.model-cost{font-size:1.55rem;font-weight:760;color:var(--model);font-variant-numeric:tabular-nums}.rate-line{margin-top:9px;color:var(--muted);font-size:.72rem;line-height:1.45}.mini{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;border-top:1px solid var(--line);margin-top:13px;padding-top:12px}.mini span{display:block;color:var(--muted);font-size:.72rem}.mini b{font-size:.9rem;font-variant-numeric:tabular-nums}.bar{height:6px;border-radius:6px;background:#172925;margin-top:14px;overflow:hidden}.bar i{display:block;height:100%;width:var(--bar);background:var(--model);border-radius:inherit}
    .split{display:grid;grid-template-columns:1.25fr .75fr;gap:12px}.stack{display:grid;gap:10px}.cost-row{display:grid;grid-template-columns:125px 1fr 95px;gap:12px;align-items:center;font-size:.85rem}.cost-row .track{height:9px;background:#172925;border-radius:8px;overflow:hidden}.cost-row .fill{height:100%;background:linear-gradient(90deg,#3acb99,var(--green));border-radius:inherit}.cost-row b{text-align:right;font-variant-numeric:tabular-nums}.formula{font-size:.88rem;color:#c6d8d1}.formula code{display:block;white-space:normal;background:#07110f;border:1px solid var(--line);padding:11px;border-radius:10px;color:#bff4e0;margin:10px 0}.formula a{color:var(--blue)}
    .toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 220px 220px auto;gap:10px}.control{border:1px solid var(--line);background:#0b1715;color:var(--text);border-radius:11px;padding:10px 12px;min-height:44px}.control:focus{outline:2px solid #52e7b266;outline-offset:1px}.button{cursor:pointer;color:#06110e;background:var(--green);font-weight:700;border:0}.button:hover{filter:brightness(1.08)}.table-shell{overflow:auto;border:1px solid var(--line);border-radius:15px;background:#091412;max-height:70vh}.table-shell::-webkit-scrollbar{height:10px;width:10px}.table-shell::-webkit-scrollbar-thumb{background:#29473f;border-radius:8px}table{width:100%;border-collapse:separate;border-spacing:0;min-width:1540px;font-size:.79rem}th,td{padding:10px 11px;border-bottom:1px solid #172a26;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}th{position:sticky;top:0;z-index:2;background:#10201d;color:#a9c2b8;font-weight:650;font-size:.73rem}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}tbody tr:hover{background:#10201d}.task{max-width:210px;overflow:hidden;text-overflow:ellipsis}.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid color-mix(in srgb,var(--pill) 45%,#203a34);border-radius:99px;color:var(--pill);background:color-mix(in srgb,var(--pill) 8%,transparent)}.dot{width:6px;height:6px;border-radius:50%;background:currentColor}.cost-cell{color:var(--green);font-weight:750}.path{display:block;max-width:250px;overflow:hidden;text-overflow:ellipsis;color:#8fac9f}.empty{padding:40px;text-align:center;color:var(--muted)}
    .foot{display:grid;grid-template-columns:1fr 1fr;gap:12px}.foot h3{font-size:.95rem;margin:0 0 8px}.foot p,.foot li{color:var(--muted);font-size:.82rem}.foot ul{margin:8px 0;padding-left:20px}.raw{word-break:break-all;color:#9fc9ba;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.74rem}.good{color:var(--green)}.warn{color:var(--amber)}
    @media(max-width:1100px){.kpis{grid-template-columns:repeat(2,1fr)}.model-grid{grid-template-columns:repeat(2,1fr)}.split,.foot{grid-template-columns:1fr}.toolbar{grid-template-columns:1fr 1fr}.topline{align-items:flex-start;flex-direction:column}.period{text-align:left}}
    @media(max-width:650px){.shell{width:min(100% - 20px,1600px);padding-top:20px}.kpis,.model-grid,.toolbar{grid-template-columns:1fr}.card{padding:15px}.kpis .card:first-child{grid-column:auto}.cost-row{grid-template-columns:95px 1fr 78px}}
    @media print{body{background:white;color:#111}.shell{width:100%;padding:0}.card,.table-shell{box-shadow:none;background:white;border-color:#ccc}.toolbar{display:none}.table-shell{max-height:none;overflow:visible}table{min-width:0;font-size:8px}th{position:static;background:#eee;color:#111}.model-grid{grid-template-columns:repeat(3,1fr)}.notice{color:#442f00;background:#fff6d9}.path{max-width:140px}.foot p,.foot li,.section-note,.period,.kpi .label,.kpi .sub,.mini span{color:#444}}
  </style>
</head>
<body>
  <main class="shell">
    <div class="topline">
      <div><p class="eyebrow">GameBench / Stage 01 / Cost audit</p><h1>六模型游戏生成：耗时、Token 与应计费用</h1></div>
      <div class="period"><b id="period"></b><span>北京时间 · 30 道题 × 6 模型</span></div>
    </div>
    <div class="notice"><strong>费用口径：</strong>网关在本次实验中回传的 cost 全为 0，不能代表免费。本报告按全部 25,456 个可见模型步骤（包括失败尝试、重试和续跑）及倍率规则回算“应计费用”；最终扣款仍应以 Packy 消费明细为准。</div>
    <div class="kpis" id="kpis"></div>

    <section>
      <div class="section-head"><h2>模型汇总</h2><span class="section-note">模型卡按实验配置顺序排列；耗时为 30 个任务各自历时之和</span></div>
      <div class="model-grid" id="model-grid"></div>
    </section>

    <section class="split">
      <div class="card"><div class="section-head"><h2>费用构成</h2><span class="section-note">人民币金额与 Packy 额度数值按 1:1 展示</span></div><div class="stack" id="cost-parts"></div></div>
      <div class="card formula">
        <h2>核算公式</h2>
        <code>应计金额 = 2 × 模型倍率 × 分组倍率 × 模型组折扣 × [普通输入 + 输出/推理 × 输出倍率 + 缓存读取 × 缓存倍率 + 缓存写入 × 写入倍率] ÷ 1,000,000</code>
        <p>DeepSeek 在工作日 09:00–12:00、14:00–18:00 的相应步骤额外乘 2；时间依据事件的北京时间计算。</p>
        <p>倍率来源：实验创建时保存的模型/输出倍率快照，以及 Packy 公开计价目录中的分组、缓存、模型组折扣和峰时规则。计费公式参考 <a href="https://github.com/QuantumNous/new-api-docs/blob/main/docs/en/guide/console/settings/rate-settings.md">New API 官方文档</a>；人民币换算参考 <a href="https://docs.packyapi.com/docs/register/3-quota.html">Packy 购买额度说明</a>。</p>
      </div>
    </section>

    <section>
      <div class="section-head"><h2>180 项任务明细</h2><span class="section-note" id="result-count"></span></div>
      <div class="toolbar">
        <input class="control" id="search" type="search" placeholder="搜索题目、任务 ID 或运行 ID…" aria-label="搜索任务">
        <select class="control" id="model-filter" aria-label="筛选模型"><option value="">全部模型</option></select>
        <select class="control" id="sort" aria-label="排序"><option value="cost-desc">费用从高到低</option><option value="time-desc">耗时从长到短</option><option value="tokens-desc">Token 从高到低</option><option value="task-asc">题目名称</option></select>
        <button class="control button" id="export">导出当前 CSV</button>
      </div>
      <div style="height:10px"></div>
      <div class="table-shell">
        <table><thead><tr>
          <th>题目</th><th>模型</th><th>开始</th><th>完成</th><th>总历时</th><th>步骤</th><th>调度/重试</th>
          <th>普通输入</th><th>输出</th><th>推理</th><th>缓存读取</th><th>缓存写入</th><th>全链路 Token</th><th>额外 Token</th><th>应计金额</th><th>产物目录</th>
        </tr></thead><tbody id="run-body"></tbody></table>
      </div>
    </section>

    <section class="foot">
      <div class="card"><h3>如何理解 Token</h3><ul><li>“全链路 Token”来自所有 <span class="raw">harness.step.completed</span> 事件，覆盖最终成功、失败尝试、重试与续跑。</li><li>“额外 Token”= 全链路 Token − 数据库最终完成轮次 Token，用于识别重试/续跑造成的增量，但不等同于纯浪费。</li><li>缓存 Token 数量很大，但按较低缓存倍率收费；不要直接用 Token 总数乘输出单价。</li></ul></div>
      <div class="card"><h3>审计说明</h3><p>实验 ID：<span class="raw">${experiment.id}</span></p><p>数据源：远端 <span class="raw">benchmark.sqlite</span> 的 runs、rounds、events 表。180 项均为 <span class="good">awaiting_stage</span>，第一阶段完成 180/180。</p><p class="warn">本页是可复算的应计估算，不是 Packy 官方账单。若需财务对账，需要 Packy 的系统访问令牌与用户 ID 查询消费流水；普通 API Key 无法读取该明细。</p></div>
    </section>
  </main>
  <script id="report-data" type="application/json">${reportData}</script>
  <script>
    const data = JSON.parse(document.getElementById('report-data').textContent);
    const fmtInt = new Intl.NumberFormat('zh-CN');
    const fmtCompact = new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:2});
    const fmtMoney = new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',minimumFractionDigits:2,maximumFractionDigits:2});
    const fmtDate = ms => new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(ms));
    const duration = ms => { const total=Math.max(0,Math.round(ms/1000)),d=Math.floor(total/86400),h=Math.floor(total%86400/3600),m=Math.floor(total%3600/60),s=total%60; return [d&&d+'天',h&&h+'时',m&&m+'分',(!d&&!h&&s)&&s+'秒'].filter(Boolean).join(' ')||'0秒'; };
    const fullDuration = ms => { const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000); return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); };
    const pct = (n,d) => d ? (n/d*100).toFixed(1)+'%' : '0%';
    document.getElementById('period').textContent = fmtDate(data.firstStartedAt)+' — '+fmtDate(data.lastFinishedAt);
    const kpis = [
      ['应计费用',fmtMoney.format(data.totals.estimatedCost),'Packy 额度约 '+data.totals.estimatedCost.toFixed(2),'money'],
      ['第一阶段任务',fmtInt.format(data.runs.length),'180 / 180 已完成',''],
      ['全链路 Token',fmtCompact.format(data.totals.totalTokens),fmtInt.format(data.totals.totalTokens),''],
      ['整体墙钟时间',duration(data.totals.wallClockMs),'从首项启动到末项收尾',''],
      ['重试/续跑增量',fmtCompact.format(data.totals.extraTokens),pct(data.totals.extraTokens,data.totals.totalTokens)+' 的全链路 Token',''],
    ];
    document.getElementById('kpis').innerHTML = kpis.map(([label,value,sub,cls]) => '<div class="card kpi"><div class="label">'+label+'</div><div class="value '+cls+'">'+value+'</div><div class="sub">'+sub+'</div></div>').join('');
    const maxModelCost=Math.max(...data.modelSummaries.map(m=>m.estimatedCost));
    document.getElementById('model-grid').innerHTML=data.modelSummaries.map(m=>{const base=2*m.modelRatio*m.groupRatio*m.modelGroupRatio;return '<article class="card model-card" style="--model:'+m.color+';--bar:'+(m.estimatedCost/maxModelCost*100).toFixed(1)+'%"><div class="model-name"><strong>'+m.label+'</strong><span class="model-cost">'+fmtMoney.format(m.estimatedCost)+'</span></div><div class="rate-line">有效单价 / 百万 Token：输入 '+fmtMoney.format(base)+' · 输出/推理 '+fmtMoney.format(base*m.completionRatio)+' · 缓存读 '+fmtMoney.format(base*m.cacheReadRatio)+' · 缓存写 '+fmtMoney.format(base*m.cacheWriteRatio)+(m.peakFactor>1?' · 峰时 ×'+m.peakFactor:'')+'</div><div class="bar"><i></i></div><div class="mini"><div><span>平均 / 游戏</span><b>'+fmtMoney.format(m.averageCost)+'</b></div><div><span>平均历时</span><b>'+duration(m.averageElapsedMs)+'</b></div><div><span>Token</span><b>'+fmtCompact.format(m.totalTokens)+'</b></div><div><span>模型步骤</span><b>'+fmtInt.format(m.steps)+'</b></div><div><span>重试事件</span><b>'+fmtInt.format(m.retries)+'</b></div><div><span>任务</span><b>'+m.count+' / 30</b></div></div></article>'}).join('');
    const costLabels={input:'普通输入',output:'输出',reasoning:'推理',cacheRead:'缓存读取',cacheWrite:'缓存写入',peakUplift:'DeepSeek 峰时加价'};
    const maxPart=Math.max(...Object.values(data.totals.costParts));
    document.getElementById('cost-parts').innerHTML=Object.entries(data.totals.costParts).map(([key,value])=>'<div class="cost-row"><span>'+costLabels[key]+'</span><div class="track"><div class="fill" style="width:'+(value/maxPart*100).toFixed(2)+'%"></div></div><b>'+fmtMoney.format(value)+'</b></div>').join('');
    const filter=document.getElementById('model-filter');
    for(const m of data.modelSummaries){const o=document.createElement('option');o.value=m.modelId;o.textContent=m.label;filter.append(o)}
    const body=document.getElementById('run-body'),search=document.getElementById('search'),sort=document.getElementById('sort'),count=document.getElementById('result-count');
    let visible=[];
    function render(){
      const q=search.value.trim().toLowerCase(); visible=data.runs.filter(r=>(!filter.value||r.model_id===filter.value)&&(!q||[r.task_title,r.task_id,r.run_id].some(v=>String(v).toLowerCase().includes(q))));
      const mode=sort.value; visible.sort((a,b)=>mode==='cost-desc'?b.estimated_cost-a.estimated_cost:mode==='time-desc'?b.elapsed_ms-a.elapsed_ms:mode==='tokens-desc'?b.total_tokens-a.total_tokens:String(a.task_title).localeCompare(String(b.task_title),'zh-CN'));
      count.textContent='显示 '+visible.length+' / '+data.runs.length+' 项';
      body.innerHTML=visible.length?visible.map(r=>{const p=data.pricing[r.model_id];return '<tr><td class="task" title="'+escapeHtml(r.task_title)+'">'+escapeHtml(r.task_title)+'</td><td><span class="pill" style="--pill:'+p.color+'"><i class="dot"></i>'+p.label+'</span></td><td>'+fmtDate(r.first_started_at)+'</td><td>'+fmtDate(r.finished_at)+'</td><td title="'+duration(r.elapsed_ms)+'">'+fullDuration(r.elapsed_ms)+'</td><td>'+fmtInt.format(r.step_count)+'</td><td>'+fmtInt.format(r.dispatch_count)+' / '+fmtInt.format(r.retry_events)+'</td><td>'+fmtInt.format(r.input_tokens)+'</td><td>'+fmtInt.format(r.output_tokens)+'</td><td>'+fmtInt.format(r.reasoning_tokens)+'</td><td>'+fmtInt.format(r.cache_read_tokens)+'</td><td>'+fmtInt.format(r.cache_write_tokens)+'</td><td>'+fmtInt.format(r.total_tokens)+'</td><td>'+fmtInt.format(r.extra_tokens)+'</td><td class="cost-cell">'+fmtMoney.format(r.estimated_cost)+'</td><td><span class="path" title="'+escapeHtml(r.workspace_path)+'">'+escapeHtml(r.workspace_path)+'</span></td></tr>'}).join(''):'<tr><td colspan="16" class="empty">没有匹配的数据</td></tr>';
    }
    function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
    search.addEventListener('input',render);filter.addEventListener('change',render);sort.addEventListener('change',render);render();
    document.getElementById('export').addEventListener('click',()=>{const cols=['task_id','task_title','model_id','first_started_at','finished_at','elapsed_ms','step_count','dispatch_count','retry_events','input_tokens','output_tokens','reasoning_tokens','cache_read_tokens','cache_write_tokens','total_tokens','extra_tokens','estimated_cost','recorded_cost','workspace_path','run_id','session_id'];const rows=[cols.join(','),...visible.map(r=>cols.map(k=>{let v=r[k];if(k.endsWith('_at'))v=new Date(v).toISOString();if(k==='estimated_cost')v=Number(v).toFixed(6);return '"'+String(v??'').replaceAll('"','""')+'"'}).join(','))];const blob=new Blob(['\ufeff'+rows.join('\\n')],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='gamebench-stage1-cost-detail.csv';a.click();URL.revokeObjectURL(a.href)});
  </script>
</body>
</html>`;

writeFileSync(outputPath, html, "utf8");
console.log(JSON.stringify({ outputPath, rows: runs.length, totals, modelSummaries }, null, 2));
