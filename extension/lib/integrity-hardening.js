/* global AIExporter */
var AIExporter = AIExporter || {};

(() => {
  const exporter = AIExporter.exporter;
  if (!exporter || exporter._p0IntegrityHardeningApplied) return;

  const checkpointKey = (provider = AIExporter.platform?.id || "unknown") =>
    `exportCheckpointV2:${provider}`;

  const normalizeCheckpoint = (value = {}) => ({
    lastSuccessfulExport: Number(value.lastSuccessfulExport) || 0,
    failedConversationIds: [
      ...new Set(
        (Array.isArray(value.failedConversationIds) ? value.failedConversationIds : [])
          .filter(Boolean)
          .map(String)
      ),
    ],
    updatedAt: value.updatedAt || null,
  });

  async function getExportCheckpoint(provider = AIExporter.platform?.id || "unknown") {
    const key = checkpointKey(provider);
    const stored = await AIExporter.browser.storageGet([key]);
    return normalizeCheckpoint(stored[key]);
  }

  async function saveExportCheckpoint(
    checkpoint,
    provider = AIExporter.platform?.id || "unknown"
  ) {
    const key = checkpointKey(provider);
    const normalized = normalizeCheckpoint({
      ...checkpoint,
      updatedAt: new Date().toISOString(),
    });
    await AIExporter.browser.storageSet({ [key]: normalized });
    return normalized;
  }

  exporter.getExportCheckpoint = getExportCheckpoint;
  exporter.saveExportCheckpoint = saveExportCheckpoint;
  exporter.getLastExportTime = async function getLastExportTime() {
    const checkpoint = await getExportCheckpoint();
    return checkpoint.lastSuccessfulExport;
  };

  const originalFilterConversations = exporter.filterConversations.bind(exporter);
  exporter.filterConversations = async function filterConversations(list, options) {
    const filtered = await originalFilterConversations(list, options);
    if (options.scope !== "new") return filtered;

    const checkpoint = await getExportCheckpoint();
    const pending = new Set(checkpoint.failedConversationIds);
    if (!pending.size) return filtered;

    const eligible = await originalFilterConversations(list, {
      ...options,
      scope: "all",
    });
    const retryItems = eligible.filter((item) => pending.has(String(item.id)));
    this._hardeningPendingAttemptIds = retryItems.map((item) => String(item.id));

    const seen = new Set(filtered.map((item) => String(item.id)));
    return [
      ...filtered,
      ...retryItems.filter((item) => !seen.has(String(item.id))),
    ];
  };

  const originalRun = exporter.run.bind(exporter);
  exporter.run = async function runWithIntegrityCheckpoint(options = {}) {
    this._hardeningPendingAttemptIds = [];
    const provider = AIExporter.platform?.id || "unknown";
    const result = await originalRun(options);
    const checkpoint = await getExportCheckpoint(provider);
    const pending = new Set(checkpoint.failedConversationIds);

    const failedIds = (result?.errors || [])
      .map((entry) => entry?.id)
      .filter(Boolean)
      .map(String);
    for (const id of failedIds) pending.add(id);

    if (result?.success && !result.failed) {
      for (const id of this._hardeningPendingAttemptIds || []) pending.delete(String(id));
      for (const id of options.conversationIds || []) pending.delete(String(id));
    }

    const isCompleteBulkScope =
      result?.success === true &&
      (result.failed || 0) === 0 &&
      (result.count || 0) > 0 &&
      (options.scope === "all" || options.scope === "new" || options.scope == null) &&
      !options.conversationIds?.length &&
      !options.selectedMessageIds?.length &&
      !options.searchQuery &&
      pending.size === 0;

    await saveExportCheckpoint(
      {
        lastSuccessfulExport: isCompleteBulkScope
          ? Date.now() / 1000
          : checkpoint.lastSuccessfulExport,
        failedConversationIds: [...pending],
      },
      provider
    );

    return result;
  };

  exporter._p0IntegrityHardeningApplied = true;
})();
