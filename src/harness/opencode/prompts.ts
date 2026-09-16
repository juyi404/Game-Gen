import path from "node:path";
import type { HarnessRunContext, RoundDefinition } from "../../domain/types.js";
import { renderRoundPrompt } from "../../prompt-context.js";

export function buildWorkspaceSystemPrompt(systemPrompt: string, workspacePath: string): string {
  const boundary = [
    "工作区边界（必须遵守）：",
    `- 本次运行唯一允许读取、创建、修改或删除的目录是：${path.resolve(workspacePath)}`,
    "- 所有工具路径必须位于该目录或其子目录中；不要访问父目录、兄弟目录、Git 根目录或其他绝对路径。",
    "- 即使工具界面显示了更大的项目根目录，也只能操作上述本次运行目录。",
  ].join("\n");
  const artifactContract = [
    "离线游戏产物要求（必须遵守）：",
    "- 最终游戏必须能在受限沙箱中离线运行；HTML、JavaScript、CSS、字体、图片、音频和模型不得引用 http://、https:// 或 // 开头的外部资源。",
    "- 不要使用 CDN（包括 cdnjs、jsDelivr、unpkg、Tailwind CDN）。依赖必须保存到工作区内并以相对路径引用；无法本地化时改用原生 HTML/CSS/JavaScript。",
    "- 开始前先检查工作区现有文件。若目录中已有未完成产物，应在原文件上定向修复，不能用默认模板或占位页覆盖已有成果。",
    "- 结束前检查 index.html 不是占位页、所有本地引用确实存在，并清除损坏的合并标记、模板插值路径和不可解析的脚本。",
  ].join("\n");
  return [systemPrompt, boundary, artifactContract].filter(Boolean).join("\n\n");
}

export function isPathInsideWorkspace(workspacePath: string, editedPath: string): boolean {
  const workspace = path.resolve(workspacePath);
  const edited = path.resolve(workspace, editedPath);
  const relative = path.relative(workspace, edited);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative));
}

export const INITIAL_BUILD_WRAP_UP_PROMPT = [
  "本游戏的生成时间预算已用完，现在只做一次交付收尾。保留当前工作目录、会话和已有成果。",
  "停止新增功能、美术扩展、重构和反复优化；只补齐让当前游戏能够加载、进入核心玩法并运行所必需的缺失内容。",
  "修复阻断运行的语法错误、缺失文件和入口引用，做一次最小运行检查，然后立即结束并简述交付结果与尚存限制。",
  "不要重新生成、覆盖已有成果或重启设计。收尾最多十五分钟，优先立即交付现有可运行版本。",
].join("\n");

export const RETRY_RESUME_PROMPT = [
  "上一轮执行因临时错误中断。请在当前同一工作目录和会话中直接续跑。",
  "先检查已有文件与未完成内容，保留所有可用成果；不要从零重建、不要覆盖已完成部分，也不要重新规划或扩展需求。",
  "如果必须补写较大的源文件，请先建立可运行骨架，再用多次小范围编辑或追加逐块完成；不要在单次工具调用中写入整个大型文件，以免再次达到响应长度上限。",
  "继续完成当前轮原始任务，优先修复阻断加载、核心玩法和交付的事项，然后尽快结束。",
].join("\n");

export function buildResumePrompt(
  context: HarnessRunContext,
  round: RoundDefinition,
  roundIndex: number,
  emptySession: boolean,
): string {
  const restoringSession = context.run.sessionId === null || emptySession;
  const history = restoringSession ? context.task.rounds.slice(0, roundIndex).map((previous, index) =>
    `已完成第 ${index + 1} 轮需求（仅作为现有成果背景，不要重新执行）：\n${renderRoundPrompt(previous.prompt, context, index)}`,
  ) : [];
  return [
    RETRY_RESUME_PROMPT,
    ...(restoringSession ? ["当前会话没有可依赖的完整历史；以下是恢复任务所需的原始需求。"] : []),
    ...history,
    `当前第 ${roundIndex + 1} 轮原始需求：\n${renderRoundPrompt(round.prompt, context, roundIndex)}`,
  ].join("\n\n");
}

export const MAXIMUM_TRUNCATED_FINISH_CONTINUATIONS = 1;

export const TRUNCATED_FINISH_CONTINUATION_PROMPT = [
  "The previous model turn ended before the game was complete, possibly because it reached the provider output limit.",
  "Continue from the files already present in the current workspace and complete any interrupted tool or file write; do not restart or merely describe a plan.",
  "Finish the requested playable game, ensure index.html is no longer the placeholder, and verify every local file reference.",
  "Only finish your response after the implementation is complete.",
].join(" ");
