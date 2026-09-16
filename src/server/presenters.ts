import type { ExperimentRecord } from "../domain/types.js";
import { experimentManifestPath, experimentOutputDir } from "../persistence/workspace.js";

export function publicExperiment(experiment: ExperimentRecord) {
  const { config, ...result } = experiment;
  const outputDir = experimentOutputDir(config, experiment.id);
  return {
    ...result,
    outputDir,
    manifestPath: experimentManifestPath(config, experiment.id),
    settings: {
      globalConcurrency: config.runtime.globalConcurrency,
      initialBuildSoftTimeoutMs: config.runtime.initialBuildSoftTimeoutMs ?? 0,
      initialBuildWrapUpMs: config.runtime.initialBuildWrapUpMs ?? 900_000,
      providerConcurrency: config.runtime.providerConcurrency,
      harness: config.runtime.harness,
      stageMode: config.runtime.stageMode,
      outputDir,
      models: config.models.map((model) => ({
        id: model.id,
        model: model.model,
        enabled: model.enabled,
        concurrency: model.concurrency,
        ...(model.roundTimeoutMs !== undefined ? { roundTimeoutMs: model.roundTimeoutMs } : {}),
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
      })),
    },
  };
}
