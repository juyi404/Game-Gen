import { providerFromModel } from "./format.js";
import { packyVirtualModelPrefix } from "./state.js";

/** Pure queries over current setup snapshots; no DOM access, writes or feature calls. */
export function createSetupSelectors(state) {
  function enabledProviderIds() {
    return [...new Set(state.setup.models.filter((model) => model.enabled).map((model) => providerFromModel(model.model)).filter(Boolean))];
  }

  function getProvider(providerId) {
    return state.setup.providers.find((provider) => provider.id === providerId);
  }

  function getPackyProvider(providerId) {
    return state.setup.packyProviders.find((provider) => provider.providerId === providerId);
  }

  function getAggregatorProvider(providerId) {
    return state.setup.aggregatorProviders.find(
      (provider) => provider.providerId === providerId,
    );
  }

  function activeVerification(path, reasoningEffort) {
    return state.setup.modelVerifications.find((record) =>
      `${record.providerId}/${record.modelId}` === path
      && (record.reasoningEffort || "") === (reasoningEffort || "")
      && record.method === "opencode"
      && record.expiresAt > Date.now());
  }

  function verifiedModelOptions() {
    const records = new Map(state.setup.modelVerifications
      .filter((record) => record.method === "opencode" && record.expiresAt > Date.now())
      .map((record) => [`${record.providerId}/${record.modelId}`, record]));
    return state.setup.providers
      .filter((provider) => provider.connected)
      .flatMap((provider) => provider.models
        .filter((model) => model.toolCall && records.has(`${provider.id}/${model.id}`))
        .map((model) => ({
          provider,
          model,
          path: `${provider.id}/${model.id}`,
          verification: records.get(`${provider.id}/${model.id}`),
        })))
      .sort((left, right) => left.provider.name.localeCompare(right.provider.name)
        || left.model.name.localeCompare(right.model.name));
  }

  function getReasoningProfile(modelPath) {
    const packyModelId = packyModelIdFromPath(modelPath);
    if (packyModelId !== null) {
      return state.setup.providers
        .flatMap((provider) => provider.models.filter((model) => model.id === packyModelId))
        .sort((left, right) => (right.reasoningEfforts?.length ?? 0) - (left.reasoningEfforts?.length ?? 0))[0] ?? null;
    }
    const slash = modelPath.indexOf("/");
    if (slash <= 0 || slash === modelPath.length - 1) return null;
    return getProvider(modelPath.slice(0, slash))?.models
      .find((model) => model.id === modelPath.slice(slash + 1)) ?? null;
  }

  function packyModelIdFromPath(path) {
    return path.startsWith(packyVirtualModelPrefix) && path.length > packyVirtualModelPrefix.length
      ? path.slice(packyVirtualModelPrefix.length)
      : null;
  }

  function getPackyCatalogModel(modelId) {
    return state.setup.packyCatalog?.models.find((model) => model.id === modelId) ?? null;
  }

  function resolveSelectedModelPath(path) {
    const packyModelId = packyModelIdFromPath(path);
    if (packyModelId === null) return path;
    return resolvePackyModelRoute(packyModelId)?.path ?? path;
  }

  function resolvePackyModelRoute(modelId) {
    const profiles = state.setup.packyProviders
      .filter((profile) => profile.connected && profile.models.some((model) => model.id === modelId))
      .sort((left, right) => Number(Boolean(right.group)) - Number(Boolean(left.group)));
    for (const profile of profiles) {
      const provider = getProvider(profile.providerId);
      const model = provider?.models.find((item) => item.id === modelId && item.toolCall);
      if (provider?.connected && model) {
        return { providerId: provider.id, path: `${provider.id}/${modelId}` };
      }
    }
    return null;
  }

  function preferredPackyGroup(model) {
    const groups = state.setup.packyCatalog?.groups ?? [];
    return model.groups
      .map((groupId) => groups.find((group) => group.id === groupId))
      .find((group) => group?.sourceModelCount > 0 && group.defaultProtocol) ?? null;
  }

  function getPackyProviderByGroup(groupId) {
    return state.setup.packyProviders.find((provider) =>
      provider.group === groupId || provider.providerId === `packy-${groupId}`,
    );
  }

  function getPackyProfileForModel(modelId) {
    return state.setup.packyProviders.find((provider) =>
      provider.models.some((model) => model.id === modelId),
    );
  }

  function automaticModelId(modelPath, currentModel) {
    const slash = modelPath.indexOf("/");
    if (slash <= 0 || slash === modelPath.length - 1) return "";
    return uniqueModelId(modelPath.slice(slash + 1), currentModel);
  }

  function uniqueModelId(value, currentModel = null) {
    let base = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 120) || "packy-model";
    let candidate = base;
    let suffix = 2;
    while (state.setup.models.some((model) => model !== currentModel && model.id === candidate)) {
      const tail = `-${suffix++}`;
      candidate = `${base.slice(0, 120 - tail.length)}${tail}`;
    }
    return candidate;
  }
  return { enabledProviderIds, getProvider, getPackyProvider, getAggregatorProvider, activeVerification, verifiedModelOptions, getReasoningProfile, packyModelIdFromPath, getPackyCatalogModel, resolveSelectedModelPath, resolvePackyModelRoute, preferredPackyGroup, getPackyProviderByGroup, getPackyProfileForModel, automaticModelId, uniqueModelId };
}
