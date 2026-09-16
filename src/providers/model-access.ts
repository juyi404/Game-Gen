import type { ModelAccessCheck, ModelAccessStatus, ProviderCatalogItem } from "./contracts.js";

export function validateModelAccess(
  models: Array<{ id: string; model: string; reasoningEffort?: string | undefined }>,
  providers: ProviderCatalogItem[],
): ModelAccessCheck[] {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  return models.map((model) => {
    const slash = model.model.indexOf("/");
    const providerId = slash > 0 ? model.model.slice(0, slash) : "";
    const modelId = slash > 0 ? model.model.slice(slash + 1) : "";
    const provider = providerById.get(providerId);
    if (!provider) {
      return accessCheck(model, providerId, modelId, "provider_missing", "供应商不存在");
    }
    const catalogModel = provider.models.find((item) => item.id === modelId);
    if (!catalogModel) {
      return accessCheck(model, providerId, modelId, "model_missing", "OpenCode 中找不到该模型");
    }
    if (!catalogModel.toolCall) {
      return accessCheck(model, providerId, modelId, "tools_unsupported", "模型不支持工具调用，无法生成源码");
    }
    if (model.reasoningEffort
      && !catalogModel.reasoningEfforts.includes(model.reasoningEffort)) {
      const available = catalogModel.reasoningEfforts.length > 0
        ? catalogModel.reasoningEfforts.join("、")
        : "无可调档位";
      return accessCheck(
        model,
        providerId,
        modelId,
        "reasoning_effort_unsupported",
        `模型不支持推理强度 ${model.reasoningEffort}；当前可选：${available}`,
      );
    }
    if (!provider.connected) {
      return accessCheck(model, providerId, modelId, "credential_missing", "尚未连接 API Key 或登录凭据");
    }
    return accessCheck(model, providerId, modelId, "ready", "可用于游戏生成");
  });
}

export function accessCheck(
  model: { id: string; model: string },
  providerId: string,
  modelId: string,
  status: ModelAccessStatus,
  message: string,
): ModelAccessCheck {
  return {
    id: model.id,
    model: model.model,
    providerId,
    modelId,
    status,
    ready: status === "ready",
    message,
  };
}
