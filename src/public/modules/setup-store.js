/**
 * @typedef {{ type: "models" | "model-edit" | "dataset" | "catalog" | "verification" | "provider-selection", datasetId?: string, revision?: number }} SetupChange
 */

/**
 * Owns setup business data. Views may read the frozen snapshots, but only these
 * commands can change datasets, selections or provider data. Transient dialog
 * state remains local to its existing view.
 */
export function createSetupStore(state) {
  /** @type {Set<(change: SetupChange) => void>} */
  const listeners = new Set();
  const revisions = new Map();
  const owned = ["datasets", "datasetId", "models", "modelSelections", "providers", "providersLoaded",
    "packyProviders", "aggregatorProviders", "modelVerifications", "packyCatalog", "packyCatalogError",
    "selectedProviderId", "providerModelSearch"];
  const values = Object.fromEntries(owned.map((key) => [key, snapshot(state.setup[key])]));
  for (const key of owned) {
    Object.defineProperty(state.setup, key, { enumerable: true, configurable: false, get: () => values[key] });
  }

  /** @param {SetupChange} change */
  function notify(change) {
    for (const listener of listeners) listener(change);
  }

  function replaceModels(models, change = "models") {
    values.models = snapshot(models);
    const datasetId = values.datasetId;
    if (datasetId) {
      const revision = (revisions.get(datasetId) ?? 0) + 1;
      revisions.set(datasetId, revision);
      values.modelSelections = snapshot({ ...values.modelSelections,
        [datasetId]: { datasetId, models: values.models, updatedAt: Date.now() } });
      notify({ type: change, datasetId, revision });
    } else notify({ type: change });
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    selectProvider(providerId, resetSearch = false) {
      const changed = values.selectedProviderId !== providerId || (resetSearch && values.providerModelSearch !== "");
      values.selectedProviderId = providerId;
      if (resetSearch) values.providerModelSearch = "";
      if (changed) notify({ type: "provider-selection" });
    },
    setProviderSearch(query) { values.providerModelSearch = query; },
    restore(setup) {
      values.datasets = snapshot(setup.datasets);
      values.modelSelections = snapshot(setup.modelSelections ?? {});
      values.datasetId = setup.datasets[0]?.id ?? null;
      values.models = snapshot(values.modelSelections[values.datasetId]?.models ?? []);
      notify({ type: "dataset" });
    },
    selectDataset(datasetId) {
      if (!values.datasets.some((dataset) => dataset.id === datasetId)) return false;
      values.datasetId = datasetId;
      values.models = snapshot(values.modelSelections[datasetId]?.models ?? []);
      notify({ type: "dataset" });
      return true;
    },
    importDataset(dataset) {
      values.datasets = snapshot([dataset, ...values.datasets]);
      values.datasetId = dataset.id;
      values.modelSelections = snapshot({ ...values.modelSelections,
        [dataset.id]: { datasetId: dataset.id, models: [], updatedAt: Date.now() } });
      values.models = snapshot([]);
      notify({ type: "dataset" });
    },
    replaceModels,
    updateModel(index, model) {
      if (!values.models[index]) return;
      replaceModels(values.models.map((current, itemIndex) => itemIndex === index ? model : current), "model-edit");
    },
    addModel(model) {
      if (values.models.length >= 100) return false;
      replaceModels([...values.models, model]);
      return true;
    },
    removeModel(index) { replaceModels(values.models.filter((_, itemIndex) => itemIndex !== index)); },
    resolveModelPaths(resolvePath) {
      const models = values.models.map((model) => ({ ...model, model: resolvePath(model.model) }));
      if (models.some((model, index) => model.model !== values.models[index].model)) replaceModels(models);
    },
    acceptSavedSelection(datasetId, revision, selection) {
      if (revisions.get(datasetId) !== revision) return;
      values.modelSelections = snapshot({ ...values.modelSelections, [datasetId]: selection });
    },
    setProviders(providers) {
      values.providers = snapshot(providers);
      values.providersLoaded = true;
      notify({ type: "catalog" });
    },
    setPackyProviders(providers) { values.packyProviders = snapshot(providers); notify({ type: "catalog" }); },
    setAggregatorProviders(providers) { values.aggregatorProviders = snapshot(providers); notify({ type: "catalog" }); },
    setVerifications(records) { values.modelVerifications = snapshot(records); notify({ type: "verification" }); },
    setPackyCatalog(catalog) {
      values.packyCatalog = snapshot(catalog);
      values.packyCatalogError = null;
      notify({ type: "catalog" });
    },
    setPackyCatalogError(message) { values.packyCatalogError = message; notify({ type: "catalog" }); },
  };
}

function snapshot(value) {
  return freeze(structuredClone(value));
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
