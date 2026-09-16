import type { GenerationHarness, HarnessRoundResult, HarnessRunContext, ResolvedBenchmarkConfig, RoundDefinition } from "../domain/types.js";
import { OpenCodeHarness } from "./opencode/harness.js";

export { HarnessFailure } from "../domain/harness-failure.js";
export type { HarnessFailureDetails, HarnessFailureKind, InfrastructureScope } from "../domain/harness-failure.js";
export type { GenerationHarness, HarnessRoundResult, HarnessRunContext } from "../domain/types.js";

export function createHarness(config: ResolvedBenchmarkConfig): GenerationHarness {
  if (config.runtime.harness === "mock") return new MockHarnessProxy(config);
  return new OpenCodeHarness(config.opencode, config.systemPrompt, {
    idleTimeoutMs: config.runtime.roundIdleTimeoutMs,
    initialBuildSoftTimeoutMs: config.runtime.initialBuildSoftTimeoutMs ?? 0,
    initialBuildWrapUpMs: config.runtime.initialBuildWrapUpMs ?? 900_000,
  });
}

export class MockHarnessProxy implements GenerationHarness {
  private delegate: GenerationHarness | null = null;

  constructor(private readonly config: ResolvedBenchmarkConfig) { }

  private async getDelegate(): Promise<GenerationHarness> {
    if (!this.delegate) {
      const { MockHarness } = await import("./mock.js");
      this.delegate = new MockHarness(this.config.mock);
    }
    return this.delegate;
  }

  async start(): Promise<void> {
    await (await this.getDelegate()).start();
  }

  async stop(): Promise<void> {
    await (await this.getDelegate()).stop();
  }

  async beginRun(context: HarnessRunContext): Promise<string> {
    return (await this.getDelegate()).beginRun(context);
  }

  async executeRound(
    context: HarnessRunContext,
    sessionId: string,
    round: RoundDefinition,
    roundIndex: number,
  ): Promise<HarnessRoundResult> {
    return (await this.getDelegate()).executeRound(context, sessionId, round, roundIndex);
  }

  async abortRun(sessionId: string, workspacePath: string): Promise<void> {
    await (await this.getDelegate()).abortRun(sessionId, workspacePath);
  }

  async releaseRun(
    sessionId: string | null,
    workspacePath: string,
    options?: { preserveSession?: boolean },
  ): Promise<void> {
    const delegate = await this.getDelegate();
    await delegate.releaseRun?.(sessionId, workspacePath, options);
  }
}
