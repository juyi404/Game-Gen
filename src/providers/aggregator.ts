import type { AggregatorAddressResolver, PackyModelDefinition } from "./contracts.js";
import { AGGREGATOR_MAX_RESPONSE_BYTES, AGGREGATOR_PROBE_TIMEOUT_MS, MAX_DISCOVERED_AGGREGATOR_MODELS } from "./contracts.js";
import { assertSafeAggregatorEndpoint, readableFetchError, readBoundedResponseText, retryDelayMs } from "./network.js";
import { delay, recordValue } from "./values.js";

export function aggregatorProviderIdForBaseUrl(value: string): string {
  const url = new URL(value);
  const source = `${url.hostname}${url.port ? `-${url.port}` : ""}${url.pathname}`;
  const suffix = source
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 110);
  return `aggregate-${suffix || "provider"}`;
}

export function parseAggregatorModelList(raw: unknown): PackyModelDefinition[] {
  const root = recordValue(raw);
  const values = Array.isArray(raw)
    ? raw
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.models)
        ? root.models
        : null;
  if (!values) throw new Error("聚合供应商返回的模型目录格式无效");
  const models = values.flatMap((value) => {
    if (typeof value === "string" && value.trim()) {
      const id = value.trim();
      return [{ id, name: id }];
    }
    const model = recordValue(value);
    if (typeof model.id !== "string" || !model.id.trim()) return [];
    const id = model.id.trim();
    const name = typeof model.name === "string" && model.name.trim()
      ? model.name.trim()
      : id;
    return [{ id, name }];
  });
  const unique = [...new Map(models.map((model) => [model.id, model])).values()];
  if (unique.length === 0) throw new Error("该 API Key 当前没有可用模型");
  if (unique.length > MAX_DISCOVERED_AGGREGATOR_MODELS) {
    throw new Error(`该 API Key 返回 ${unique.length} 个模型，超过单次验证上限 ${MAX_DISCOVERED_AGGREGATOR_MODELS} 个；请使用更精确的模型分组 Key`);
  }
  return unique;
}

export interface AggregatorModelProbe {
  model: PackyModelDefinition;
  ready: boolean;
  error: string;
}

export async function probeAggregatorModel(
  baseUrl: string,
  apiKey: string,
  model: PackyModelDefinition,
  resolveAddresses: AggregatorAddressResolver,
): Promise<AggregatorModelProbe> {
  const root = baseUrl.replace(/\/+$/, "");
  const toolName = "gamebench_model_probe";
  const tool = {
    type: "function",
    function: {
      name: toolName,
      description: "Verify that this model can call a source-generation tool.",
      parameters: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  };
  const chat = await runAggregatorProbe(
    `${root}/chat/completions`,
    apiKey,
    {
      model: model.id,
      messages: [{
        role: "user",
        content: "Call gamebench_model_probe exactly once with ok=true. Do not answer with text.",
      }],
      tools: [tool],
      tool_choice: { type: "function", function: { name: toolName } },
      stream: false,
    },
    (raw) => {
      const response = recordValue(raw);
      if (!Array.isArray(response.choices)) return false;
      return response.choices.some((choice) => {
        const message = recordValue(recordValue(choice).message);
        const legacyCall = recordValue(message.function_call);
        if (legacyCall.name === toolName && validProbeArguments(legacyCall.arguments)) return true;
        return Array.isArray(message.tool_calls) && message.tool_calls.some((call) =>
          recordValue(recordValue(call).function).name === toolName
          && validProbeArguments(recordValue(recordValue(call).function).arguments));
      });
    },
    resolveAddresses,
  );
  if (chat.ready) return { model, ready: true, error: "" };
  if ([401, 403, 429].includes(chat.status ?? 0)) {
    return { model, ready: false, error: `${model.id}: ${chat.error}` };
  }

  const responsesTool = {
    type: "function",
    name: toolName,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
  const responses = await runAggregatorProbe(
    `${root}/responses`,
    apiKey,
    {
      model: model.id,
      input: "Call gamebench_model_probe exactly once with ok=true. Do not answer with text.",
      tools: [responsesTool],
      tool_choice: { type: "function", name: toolName },
      stream: false,
    },
    (raw) => {
      const response = recordValue(raw);
      return Array.isArray(response.output) && response.output.some((item) => {
        const output = recordValue(item);
        return output.type === "function_call"
          && output.name === toolName
          && validProbeArguments(output.arguments);
      });
    },
    resolveAddresses,
  );
  if (responses.ready) return { model, ready: true, error: "" };
  return {
    model,
    ready: false,
    error: `${model.id}: ${responses.error || chat.error}`,
  };
}

export async function runAggregatorProbe(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  accepts: (raw: unknown) => boolean,
  resolveAddresses: AggregatorAddressResolver,
): Promise<{ ready: boolean; status?: number; error: string }> {
  let lastError = "调用失败";
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await assertSafeAggregatorEndpoint(endpoint, resolveAddresses);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(AGGREGATOR_PROBE_TIMEOUT_MS),
      });
      lastStatus = response.status;
      const rawText = await readBoundedResponseText(response, AGGREGATOR_MAX_RESPONSE_BYTES);
      if (!response.ok) {
        lastError = aggregatorApiError(response.status, rawText);
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await delay(retryDelayMs(response.headers.get("retry-after")));
          continue;
        }
        return { ready: false, status: response.status, error: lastError };
      }
      let raw: unknown;
      try {
        raw = rawText ? JSON.parse(rawText) : {};
      } catch {
        return { ready: false, status: response.status, error: "响应不是有效 JSON" };
      }
      return accepts(raw)
        ? { ready: true, status: response.status, error: "" }
        : { ready: false, status: response.status, error: "响应未产生所需的工具调用" };
    } catch (error) {
      lastError = readableFetchError(error);
      // A timeout or transport error is unlikely to improve immediately and
      // retrying every model makes large catalog scans grow without bound.
      return { ready: false, ...(lastStatus ? { status: lastStatus } : {}), error: lastError };
    }
  }
  return { ready: false, ...(lastStatus ? { status: lastStatus } : {}), error: lastError };
}

export function aggregatorApiError(status: number, rawText: string): string {
  let message = "";
  try {
    const root = recordValue(JSON.parse(rawText));
    const error = recordValue(root.error);
    if (typeof error.message === "string") message = error.message;
    else if (typeof root.message === "string") message = root.message;
  } catch { }
  const compact = message.replace(/\s+/g, " ").trim().slice(0, 180);
  if ([401, 403].includes(status)) return `Key 无权限 (HTTP ${status})${compact ? `: ${compact}` : ""}`;
  if (status === 429) return `模型调用被限流 (HTTP 429)${compact ? `: ${compact}` : ""}`;
  return `模型调用失败 (HTTP ${status})${compact ? `: ${compact}` : ""}`;
}

export function validProbeArguments(value: unknown): boolean {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return recordValue(parsed).ok === true;
  } catch {
    return false;
  }
}
