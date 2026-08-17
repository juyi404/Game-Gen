import type { HarnessRunContext } from "./types.js";

export function buildEffectiveSystemPrompt(
  benchmarkSystemPrompt: string,
  modelSystemPrompt?: string,
): string {
  return [benchmarkSystemPrompt, modelSystemPrompt]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

export function renderRoundPrompt(
  prompt: string,
  context: Pick<HarnessRunContext, "task" | "model" | "workspacePath">,
  roundIndex: number,
): string {
  return prompt
    .replaceAll("{{task.id}}", context.task.id)
    .replaceAll("{{task.title}}", context.task.title)
    .replaceAll("{{model.id}}", context.model.id)
    .replaceAll("{{round.index}}", String(roundIndex + 1))
    .replaceAll("{{workspace}}", context.workspacePath);
}
