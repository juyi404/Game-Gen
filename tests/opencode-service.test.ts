import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPackyProviderConfig,
  isPackyBaseUrl,
  OpenCodeService,
  PACKY_PROTOCOL_DEFAULTS,
  packyProviderIdForGroup,
  parsePackyCatalog,
  parsePackyModelList,
} from "../src/opencode-service.js";

describe("PackyAPI OpenCode provider config", () => {
  it.each([
    ["openai", "@ai-sdk/openai"],
    ["anthropic", "@ai-sdk/anthropic"],
    ["google", "@ai-sdk/google"],
  ] as const)("maps %s to the correct AI SDK provider", (protocol, npm) => {
    const config = createPackyProviderConfig({
      name: `Packy ${protocol}`,
      protocol,
      baseUrl: `${PACKY_PROTOCOL_DEFAULTS[protocol].baseUrl}/`,
      models: [{ id: "model-one", name: "Model One" }],
    });

    expect(config).toMatchObject({
      name: `Packy ${protocol}`,
      npm,
      options: {
        baseURL: PACKY_PROTOCOL_DEFAULTS[protocol].baseUrl,
        setCacheKey: true,
        timeout: false,
      },
      models: {
        "model-one": {
          id: "model-one",
          name: "Model One",
          tool_call: true,
          status: "active",
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("apiKey");
  });

  it("recognizes PackyAPI endpoint aliases without matching unrelated hosts", () => {
    expect(isPackyBaseUrl("https://www.packyapi.com/v1")).toBe(true);
    expect(isPackyBaseUrl("https://api.packyapi.ai/v1")).toBe(true);
    expect(isPackyBaseUrl("https://www.packycode.com/v1")).toBe(true);
    expect(isPackyBaseUrl("https://cf.api.fan/v1")).toBe(true);
    expect(isPackyBaseUrl("https://packyapi.com.example.org/v1")).toBe(false);
    expect(isPackyBaseUrl("not-a-url")).toBe(false);
  });

  it("persists model-specific reasoning variants without credentials", () => {
    const config = createPackyProviderConfig({
      name: "Packy reasoning",
      protocol: "openai",
      baseUrl: PACKY_PROTOCOL_DEFAULTS.openai.baseUrl,
      models: [{
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        reasoning: true,
        variants: {
          high: { reasoningEffort: "high" },
          xhigh: { reasoningEffort: "xhigh" },
          max: { reasoningEffort: "max" },
        },
      }],
    });

    expect(config.models?.["gpt-5.6-sol"]).toMatchObject({
      reasoning: true,
      variants: {
        high: { reasoningEffort: "high" },
        xhigh: { reasoningEffort: "xhigh" },
        max: { reasoningEffort: "max" },
      },
    });
    expect(JSON.stringify(config)).not.toContain("apiKey");
  });

  it("normalizes the live PackyAPI pricing catalog for group-based setup", () => {
    const catalog = parsePackyCatalog({
      success: true,
      inactive_groups: [],
      usable_group: {
        "aws-q": "AWS Claude 渠道",
        codex: "Codex 专用",
        "kimi-officially": "Kimi 官方渠道",
        image: "图片模型",
      },
      vendors: [
        { id: 1, name: "Anthropic" },
        { id: 2, name: "OpenAI" },
        { id: 7, name: "Moonshot" },
      ],
      data: [
        {
          model_name: "claude-sonnet-test",
          vendor_id: 1,
          enable_groups: ["aws-q"],
          supported_endpoint_types: ["anthropic", "openai"],
        },
        {
          model_name: "gpt-5.5",
          vendor_id: 2,
          enable_groups: ["codex"],
          supported_endpoint_types: ["openai-response", "openai"],
        },
        {
          model_name: "kimi-k3",
          vendor_id: 7,
          enable_groups: ["kimi-officially"],
          supported_endpoint_types: ["anthropic"],
        },
        {
          model_name: "gpt-image-2",
          vendor_id: 2,
          enable_groups: ["image"],
          supported_endpoint_types: ["openai", "image-generation"],
        },
      ],
    }, 1234);

    expect(catalog).toMatchObject({ fetchedAt: 1234, models: expect.any(Array) });
    expect(catalog.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "gpt-5.5",
        vendor: "OpenAI",
        protocols: ["openai"],
        sourceGeneration: true,
      }),
      expect.objectContaining({
        id: "kimi-k3",
        protocols: ["anthropic"],
        sourceGeneration: true,
      }),
      expect.objectContaining({ id: "gpt-image-2", sourceGeneration: false }),
    ]));
    expect(catalog.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "aws-q", sourceModelCount: 1, defaultProtocol: "anthropic" }),
      expect.objectContaining({ id: "codex", sourceModelCount: 1, defaultProtocol: "openai" }),
      expect.objectContaining({
        id: "kimi-officially",
        sourceModelCount: 1,
        defaultProtocol: "anthropic",
      }),
      expect.objectContaining({ id: "image", sourceModelCount: 0, defaultProtocol: null }),
    ]));
    expect(packyProviderIdForGroup("kimi-officially")).toBe("packy-kimi-officially");
  });

  it("normalizes the models actually authorized by a PackyAPI key", () => {
    expect(parsePackyModelList({
      object: "list",
      data: [{ id: "gpt-5.5" }, { id: "gpt-5.5" }, { id: "grok-4.6" }],
    })).toEqual(["gpt-5.5", "grok-4.6"]);
    expect(() => parsePackyModelList({ data: [] })).toThrow("没有可用模型");
  });

  it("loads persisted PackyAPI providers into a managed OpenCode instance", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "gamebench-packy-provider-"));
    const providerConfig = createPackyProviderConfig({
      name: "PackyAPI · Managed Test",
      protocol: "openai",
      baseUrl: "https://www.packyapi.com/v1",
      models: [{
        id: "managed-test-model",
        name: "Managed Test Model",
        reasoning: true,
        variants: {
          high: { reasoningEffort: "high" },
          xhigh: { reasoningEffort: "xhigh" },
          max: { reasoningEffort: "max" },
        },
      }, {
        id: "managed-second-model",
        name: "Managed Second Model",
        reasoning: true,
        variants: {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
        },
      }],
    });
    if (providerConfig.options) delete providerConfig.options.timeout;
    await writeFile(path.join(stateDir, "packy-providers.json"), JSON.stringify({
      version: 1,
      providers: { "packy-managed-test": providerConfig },
    }), "utf8");
    const service = new OpenCodeService({
      hostname: "127.0.0.1",
      port: 0,
      startupTimeoutMs: 30_000,
      agent: "build",
      config: {},
    }, stateDir);
    try {
      const providers = await service.listProviders();
      const provider = providers.find((item) => item.id === "packy-managed-test");
      expect(provider).toBeDefined();
      expect(provider?.models.find((model) => model.id === "managed-test-model")).toMatchObject({
        toolCall: true,
        reasoning: true,
        reasoningEfforts: expect.arrayContaining(["high", "xhigh", "max"]),
      });
      expect(provider?.models.find((model) => model.id === "managed-second-model")).toMatchObject({
        toolCall: true,
        reasoning: true,
        reasoningEfforts: expect.arrayContaining(["low", "high"]),
      });
      const persisted = JSON.parse(await readFile(
        path.join(stateDir, "packy-providers.json"),
        "utf8",
      )) as { providers: Record<string, { options?: { timeout?: number | false } }> };
      expect(persisted.providers["packy-managed-test"]?.options?.timeout).toBe(false);
    } finally {
      service.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 45_000);
});
