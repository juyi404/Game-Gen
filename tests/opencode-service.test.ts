import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  aggregatorProviderIdForBaseUrl,
  assertSafeAggregatorEndpoint,
  createPackyProviderConfig,
  isForbiddenAggregatorAddress,
  isPackyBaseUrl,
  OpenCodeService,
  PACKY_PROTOCOL_DEFAULTS,
  packyProviderIdForGroup,
  parsePackyCatalog,
  parsePackyModelList,
  parseAggregatorModelList,
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

  it("targets Packy's versioned Messages API for Anthropic-compatible models", () => {
    const config = createPackyProviderConfig({
      name: "Packy Anthropic",
      protocol: "anthropic",
      baseUrl: "https://www.packyapi.com/",
      models: [{ id: "kimi-k3", name: "Kimi K3" }],
    });

    expect(PACKY_PROTOCOL_DEFAULTS.anthropic.baseUrl).toBe("https://www.packyapi.com/v1");
    expect(config.options?.baseURL).toBe("https://www.packyapi.com/v1");
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
          quota_type: 0,
          model_ratio: "0.5",
          model_price: "0",
          completion_ratio: "4",
          tiers: [{ min: 0, max: 1_000_000 }],
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
        pricing: {
          quotaType: 0,
          modelRatio: "0.5",
          modelPrice: "0",
          completionRatio: "4",
          tiers: [{ min: 0, max: 1_000_000 }],
        },
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

  it("normalizes OpenAI-compatible aggregator model catalogs", () => {
    expect(parseAggregatorModelList({
      object: "list",
      data: [
        { id: "openai/gpt-5", name: "GPT 5" },
        { id: "openai/gpt-5", name: "Duplicate" },
        { id: "anthropic/claude-sonnet" },
      ],
    })).toEqual([
      { id: "openai/gpt-5", name: "Duplicate" },
      { id: "anthropic/claude-sonnet", name: "anthropic/claude-sonnet" },
    ]);
    expect(parseAggregatorModelList({ models: ["gpt-5", "claude-sonnet"] }))
      .toEqual([
        { id: "gpt-5", name: "gpt-5" },
        { id: "claude-sonnet", name: "claude-sonnet" },
      ]);
    expect(() => parseAggregatorModelList({ data: [] })).toThrow("没有可用模型");
    expect(aggregatorProviderIdForBaseUrl("https://gateway.example.com/v1/"))
      .toBe("aggregate-gateway.example.com-v1");
  });

  it("only discovers aggregator models that pass a real tool-call probe", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openai/gpt-5", name: "GPT 5" },
            { id: "responses/model", name: "Responses Model" },
            { id: "false-positive/model", name: "False Positive" },
            { id: "unavailable/model", name: "Unavailable" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const request = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (url.endsWith("/chat/completions") && request.model === "openai/gpt-5") {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                type: "function",
                function: { name: "gamebench_model_probe", arguments: "{\"ok\":true}" },
              }],
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/responses") && request.model === "responses/model") {
        return new Response(JSON.stringify({
          output: [{
            type: "function_call",
            name: "gamebench_model_probe",
            arguments: "{\"ok\":true}",
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/chat/completions") && request.model === "false-positive/model") {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                type: "function",
                function: { name: "gamebench_model_probe", arguments: "{\"ok\":false}" },
              }],
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "model is unavailable" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });
    const service = new OpenCodeService({
      hostname: "127.0.0.1",
      port: 0,
      startupTimeoutMs: 5_000,
      agent: "build",
      config: {},
    }, undefined, { resolveAggregatorAddresses: async () => ["8.8.8.8"] });
    try {
      await expect(service.discoverAggregatorModels(
        "https://gateway.example.com/v1/",
        "test-aggregator-secret",
      )).resolves.toEqual({
        models: [
          { id: "openai/gpt-5", name: "GPT 5" },
          { id: "responses/model", name: "Responses Model" },
        ],
        discoveredModelCount: 4,
        rejectedModelCount: 2,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://gateway.example.com/v1/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-aggregator-secret",
          }),
          redirect: "error",
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://gateway.example.com/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-aggregator-secret",
          }),
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects loopback, private, link-local and IPv4-mapped aggregator addresses", async () => {
    expect(isForbiddenAggregatorAddress("127.0.0.1")).toBe(true);
    expect(isForbiddenAggregatorAddress("10.20.30.40")).toBe(true);
    expect(isForbiddenAggregatorAddress("169.254.169.254")).toBe(true);
    expect(isForbiddenAggregatorAddress("::1")).toBe(true);
    expect(isForbiddenAggregatorAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isForbiddenAggregatorAddress("fd00:ec2::254")).toBe(true);
    expect(isForbiddenAggregatorAddress("8.8.8.8")).toBe(false);
    expect(isForbiddenAggregatorAddress("2606:4700:4700::1111")).toBe(false);

    await expect(assertSafeAggregatorEndpoint(
      "https://gateway.example.com/v1/models",
      async () => ["10.0.0.8"],
    )).rejects.toThrow("非公网 IP");
    await expect(assertSafeAggregatorEndpoint("https://localhost/v1/models"))
      .rejects.toThrow("不能指向本机或内网");
  });

  it("revalidates DNS before each aggregator endpoint to stop rebinding", async () => {
    let resolutions = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "model-one" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const service = new OpenCodeService({
      hostname: "127.0.0.1",
      port: 0,
      startupTimeoutMs: 5_000,
      agent: "build",
      config: {},
    }, undefined, {
      resolveAggregatorAddresses: async () => {
        resolutions += 1;
        return resolutions === 1 ? ["8.8.8.8"] : ["127.0.0.1"];
      },
    });
    try {
      await expect(service.discoverAggregatorModels(
        "https://gateway.example.com/v1",
        "test-secret",
      )).rejects.toThrow("没有模型通过真实工具调用验证");
      expect(resolutions).toBeGreaterThanOrEqual(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      service.close();
    }
  });

  it("rejects oversized aggregator responses before parsing them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(1024 * 1024 + 1) },
    }));
    const service = new OpenCodeService({
      hostname: "127.0.0.1",
      port: 0,
      startupTimeoutMs: 5_000,
      agent: "build",
      config: {},
    }, undefined, { resolveAggregatorAddresses: async () => ["8.8.8.8"] });
    try {
      await expect(service.discoverAggregatorModels(
        "https://gateway.example.com/v1",
        "test-secret",
      )).rejects.toThrow("响应超过");
    } finally {
      fetchMock.mockRestore();
      service.close();
    }
  });

  it("rejects aggregator catalogs that exceed the bounded validation batch", () => {
    expect(() => parseAggregatorModelList({
      data: Array.from({ length: 51 }, (_, index) => ({ id: `model-${index + 1}` })),
    })).toThrow("超过单次验证上限 50 个");
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
    const legacyAnthropicProviderConfig = createPackyProviderConfig({
      name: "PackyAPI · Legacy Anthropic",
      protocol: "anthropic",
      baseUrl: "https://www.packyapi.com/v1",
      models: [{ id: "kimi-k3", name: "Kimi K3" }],
    });
    if (legacyAnthropicProviderConfig.options) {
      legacyAnthropicProviderConfig.options.baseURL = "https://www.packyapi.com";
    }
    await writeFile(path.join(stateDir, "packy-providers.json"), JSON.stringify({
      version: 1,
      providers: {
        "packy-managed-test": providerConfig,
        "packy-legacy-anthropic": legacyAnthropicProviderConfig,
      },
    }), "utf8");
    const aggregatorProviderConfig = createPackyProviderConfig({
      name: "Managed Aggregator",
      protocol: "openai",
      baseUrl: "https://gateway.example.com/v1",
      models: [{ id: "aggregator/test-model", name: "Aggregator Test Model" }],
    });
    await writeFile(path.join(stateDir, "aggregator-providers.json"), JSON.stringify({
      version: 1,
      providers: { "aggregate-gateway.example.com-v1": aggregatorProviderConfig },
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
      expect(providers.find((item) => item.id === "aggregate-gateway.example.com-v1")?.models)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "aggregator/test-model", toolCall: true }),
        ]));
      expect(await service.listAggregatorProviders()).toEqual([
        expect.objectContaining({
          providerId: "aggregate-gateway.example.com-v1",
          name: "Managed Aggregator",
          baseUrl: "https://gateway.example.com/v1",
          models: [expect.objectContaining({ id: "aggregator/test-model", toolCall: true })],
        }),
      ]);
      const persisted = JSON.parse(await readFile(
        path.join(stateDir, "packy-providers.json"),
        "utf8",
      )) as {
        providers: Record<string, { options?: { baseURL?: string; timeout?: number | false } }>;
      };
      expect(persisted.providers["packy-managed-test"]?.options?.timeout).toBe(false);
      expect(persisted.providers["packy-legacy-anthropic"]?.options).toMatchObject({
        baseURL: "https://www.packyapi.com/v1",
        timeout: false,
      });
    } finally {
      service.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 45_000);
});
