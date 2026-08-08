(function exposeMaintenanceCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VkrMaintenanceCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const FINAL_STATUSES = new Set(["completed", "done", "failed", "cancelled"]);
  const SCOPES = new Set(["errors", "completed", "all"]);

  function normalizeMaintenanceScope(scope) {
    const value = String(scope || "").trim().toLowerCase();
    if (!SCOPES.has(value)) throw new Error("Unknown maintenance scope");
    return value;
  }

  function isTerminalRecord(record) {
    return FINAL_STATUSES.has(String(record?.status || "").toLowerCase());
  }

  function recordHasErrors(record) {
    const status = String(record?.status || "").toLowerCase();
    if (status === "cancelled") return false;
    if (status === "failed") return true;
    if (Number(record?.fail) > 0 || Number(record?.progress?.fail) > 0) return true;
    if (Array.isArray(record?.results) && record.results.some((result) => result?.ok === false)) {
      return true;
    }
    return Boolean(String(record?.error || "").trim());
  }

  function shouldPurgeRecord(record, scope, { assumeTerminal = false } = {}) {
    const normalizedScope = normalizeMaintenanceScope(scope);
    if (!assumeTerminal && !isTerminalRecord(record)) return false;
    if (normalizedScope === "all") return true;
    const hasErrors = recordHasErrors(record);
    return normalizedScope === "errors" ? hasErrors : !hasErrors;
  }

  function purgeRecords(records, scope, options = {}) {
    const kept = [];
    const removed = [];
    for (const record of Array.isArray(records) ? records : []) {
      if (shouldPurgeRecord(record, scope, options)) removed.push(record);
      else kept.push(record);
    }
    return { kept, removed, removedCount: removed.length };
  }

  return Object.freeze({
    isTerminalRecord,
    normalizeMaintenanceScope,
    purgeRecords,
    recordHasErrors,
    shouldPurgeRecord,
  });
});
