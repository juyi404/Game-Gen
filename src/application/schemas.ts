import { z } from "zod";
import { PACKY_PROTOCOLS } from "../providers/contracts.js";

export const identifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "仅允许字母、数字、点、下划线和短横线");

export const datasetImportSchema = z.object({
  name: z.string().trim().min(1).max(160),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        content: z.string().max(10 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(20_000),
});

export const experimentModelSchema = z.object({
  id: identifierSchema,
  model: z.string().regex(/^[^/]+\/.+$/, "模型必须使用 provider/model 格式"),
  enabled: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(1_000),
  roundTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  reasoningEffort: identifierSchema.optional(),
});

export const experimentInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  datasetId: identifierSchema,
  harness: z.enum(["opencode", "mock"]).default("opencode"),
  stageMode: z.enum(["all", "manual"]).default("all"),
  models: z
    .array(experimentModelSchema)
    .min(1)
    .max(100),
  globalConcurrency: z.number().int().min(1).max(1_000),
  providerConcurrency: z.record(z.string(), z.number().int().min(1).max(1_000)).default({}),
  maxAttempts: z.number().int().min(1).max(10).default(2),
  roundTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).default(0),
  initialBuildSoftTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  initialBuildWrapUpMs: z.number().int().min(1).max(60 * 60 * 1000).optional(),
  roundIdleTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000)
    .default(30 * 60 * 1000),
  retryBackoffMs: z.number().int().min(0).max(60 * 60 * 1000).default(10_000),
  systemPrompt: z.string().max(20_000).optional(),
});

export const modelAccessInputSchema = z.object({
  models: z.array(experimentModelSchema).min(1).max(100),
});

export const modelVerificationInputSchema = z.object({
  models: z.array(experimentModelSchema).min(1).max(100),
  force: z.boolean().default(false),
});

export const datasetDraftModelSchema = z.object({
  id: z.string().max(120),
  model: z.string().max(500),
  enabled: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(1_000),
  reasoningEffort: identifierSchema.optional(),
});

export const datasetModelSelectionInputSchema = z.object({
  // Dataset selections are editable drafts. The stricter provider/model and ID
  // checks still run when an experiment is created.
  models: z.array(datasetDraftModelSchema).max(100),
});

export const apiKeySchema = z.object({
  providerId: identifierSchema,
  key: z.string().trim().min(1).max(20_000),
});

export const oauthSchema = z.object({
  providerId: identifierSchema,
  method: z.number().int().nonnegative(),
  code: z.string().trim().max(20_000).optional(),
});

export const packyModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "模型 ID 只能包含字母、数字、点、下划线、冒号和短横线");

export const packyProviderSchema = z.object({
  providerId: identifierSchema,
  protocol: z.enum(PACKY_PROTOCOLS),
  baseUrl: z.url().refine((value) => new URL(value).protocol === "https:", {
    message: "PackyAPI 地址必须使用 HTTPS",
  }),
  apiKey: z.string().trim().min(1).max(20_000),
  models: z
    .array(z.object({
      id: packyModelIdSchema,
      name: z.string().trim().min(1).max(200).optional(),
    }))
    .min(1)
    .max(100)
    .refine((models) => new Set(models.map((model) => model.id)).size === models.length, {
      message: "模型 ID 不能重复",
    }),
});

export const packyGroupConnectionSchema = z.object({
  group: identifierSchema,
  apiKey: z.string().trim().min(1).max(20_000),
  protocol: z.enum(PACKY_PROTOCOLS).optional(),
  targetModelId: packyModelIdSchema.optional(),
});

export const aggregatorConnectionSchema = z.object({
  providerId: identifierSchema
    .refine((value) => value.startsWith("aggregate-"), {
      message: "聚合供应商标识必须以 aggregate- 开头",
    })
    .optional(),
  name: z.string().trim().min(1).max(160).optional(),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  }, {
    message: "API Base URL 必须是无账号、查询参数和片段的 HTTPS 地址",
  }),
  apiKey: z.string().trim().min(1).max(20_000),
});

export const manifestSchema = z.object({
  id: identifierSchema,
  name: z.string(),
  createdAt: z.number(),
  fileCount: z.number(),
  taskCount: z.number(),
  roundCount: z.number(),
  totalBytes: z.number(),
  preview: z.array(z.object({ id: z.string(), title: z.string(), rounds: z.number() })),
});

export type DatasetSummary = z.infer<typeof manifestSchema>;

export type ExperimentInput = z.infer<typeof experimentInputSchema>;

export type DatasetModelSelection = z.infer<typeof datasetModelSelectionInputSchema> & {
  datasetId: string;
  updatedAt: number;
};
