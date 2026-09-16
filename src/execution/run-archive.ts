import type { GenerationHarness, HarnessRoundResult, HarnessRunContext, ModelConfig, ResolvedBenchmarkConfig, RoundDefinition, TaskDefinition } from "../domain/types.js";
import type { BenchmarkDatabase } from "../persistence/database.js";
import { writeAttemptResult, writeRoundContext } from "../persistence/workspace.js";
import { errorMessage } from "./errors.js";

/** Persists execution results and captures context without owning scheduling state. */
export class RunArchive {
  constructor(
    private readonly db: BenchmarkDatabase,
    private readonly config: ResolvedBenchmarkConfig,
    private readonly modelById: Map<string, ModelConfig>,
    private readonly harness: GenerationHarness,
    private readonly emitRunEvent: (runId: string, type: string, level: "error", message: string, data: Record<string, unknown>) => void,
  ) { }
  async writeAttemptResultSafely(
    runId: string,
    workspacePath: string | null,
    status: string,
    error: string | null,
    willRetry = false,
  ): Promise<void> {
    if (!workspacePath) return;
    const run = this.db.getRun(runId);
    if (!run) return;
    try {
      await writeAttemptResult(
        workspacePath,
        run,
        this.modelById.get(run.modelId),
        this.db.getRounds(runId),
        status,
        error,
        willRetry,
      );
    } catch (writeError) {
      this.emitRunEvent(runId, "run.result.failed", "error", "本次运行结果清单写入失败", {
        error: errorMessage(writeError),
        workspacePath,
      });
    }
  }

  async archiveRoundContext(
    runId: string,
    workspacePath: string,
    task: TaskDefinition,
    model: ModelConfig,
    round: RoundDefinition,
    roundIndex: number,
    sessionId: string,
    usage?: HarnessRoundResult["usage"],
    harnessContext?: unknown,
  ): Promise<string> {
    const run = this.db.getRun(runId);
    const allRounds = this.db.getRounds(runId);
    const roundRecord = allRounds[roundIndex];
    if (!run || !roundRecord) throw new Error(`轮次上下文来源不存在: ${runId}#${roundIndex + 1}`);
    return writeRoundContext({
      config: this.config,
      workspacePath,
      run,
      task,
      model,
      round,
      roundRecord,
      allRounds,
      sessionId,
      usage,
      harnessContext,
    });
  }

  async captureHarnessRoundContext(
    context: HarnessRunContext,
    sessionId: string,
    round: RoundDefinition,
    roundIndex: number,
  ): Promise<unknown> {
    if (!this.harness.captureRoundContext) return null;
    try {
      return await this.harness.captureRoundContext(context, sessionId, round, roundIndex);
    } catch (error) {
      return {
        type: "harness.context.capture-error",
        capturedAt: new Date().toISOString(),
        error: errorMessage(error),
      };
    }
  }
}
