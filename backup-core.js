(function initBackupCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VkrBackupCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function backupFactory() {
  "use strict";

  const FORMAT = "vk-reposter-backup";
  const FORMAT_VERSION = 1;
  const SECRET_KEYS = new Set([
    "vk_token",
    "vkr_group_tokens",
    "vkr_server_api_secret",
    "vkr_twiboost_api_key",
  ]);
  const ACTIVITY_KEYS = new Set([
    "vkr_account_errors",
    "vkr_active_upload_id",
    "vkr_autolike_log",
    "vkr_automation_tab",
    "vkr_cleanup_photo_ledger_v1",
    "vkr_clips_history",
    "vkr_clips_queue",
    "vkr_clip_job",
    "vkr_clips_source",
    "vkr_group_analytics_cache",
    "vkr_last_sync_ts",
    "vkr_posts_history",
    "vkr_publish_due",
    "vkr_publish_queue",
    "vkr_queue_pause",
    "vkr_safe_jobs",
    "vkr_scheduled_comments",
    "vkr_scheduled_deletions",
    "vkr_token_health",
    "vkr_waiting_posts",
  ]);

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isExtensionStorageKey(key) {
    return key === "vk_token" || /^vkr_[a-z0-9_]+$/i.test(key);
  }

  function copyJsonValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function selectBackupData(storage, { scope = "settings", includeSecrets = true } = {}) {
    if (!isPlainObject(storage)) throw new TypeError("Storage must be an object.");
    const full = scope === "full";
    const data = Object.create(null);
    for (const [key, value] of Object.entries(storage)) {
      if (!isExtensionStorageKey(key)) continue;
      if (!full && ACTIVITY_KEYS.has(key)) continue;
      if (!includeSecrets && SECRET_KEYS.has(key)) continue;
      if (value === undefined) continue;
      data[key] = copyJsonValue(value);
    }
    return data;
  }

  function createBackup(storage, options = {}) {
    const scope = options.scope === "full" ? "full" : "settings";
    const includeSecrets = options.includeSecrets !== false;
    const createdAt = new Date(options.now || Date.now()).toISOString();
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      extensionVersion: String(options.extensionVersion || "unknown"),
      createdAt,
      scope,
      includesSecrets: includeSecrets,
      data: selectBackupData(storage, { scope, includeSecrets }),
    };
  }

  function validateBackup(backup) {
    if (!isPlainObject(backup)) throw new Error("Файл резервной копии повреждён.");
    if (backup.format !== FORMAT || backup.formatVersion !== FORMAT_VERSION) {
      throw new Error("Это не резервная копия VK Reposter Pro или её формат не поддерживается.");
    }
    if (!isPlainObject(backup.data)) throw new Error("В резервной копии отсутствуют данные.");
    const data = Object.create(null);
    for (const [key, value] of Object.entries(backup.data)) {
      if (!isExtensionStorageKey(key)) continue;
      if (value === undefined) continue;
      data[key] = copyJsonValue(value);
    }
    if (!Object.keys(data).length) throw new Error("В резервной копии нет подходящих данных.");
    return {
      ...backup,
      scope: backup.scope === "full" ? "full" : "settings",
      includesSecrets: Boolean(backup.includesSecrets),
      data,
    };
  }

  function prepareImport(backup, { importSecrets = true } = {}) {
    const checked = validateBackup(backup);
    const data = Object.create(null);
    for (const [key, value] of Object.entries(checked.data)) {
      if (!importSecrets && SECRET_KEYS.has(key)) continue;
      data[key] = copyJsonValue(value);
    }
    if (!Object.keys(data).length) throw new Error("После выбранных исключений нечего импортировать.");
    return data;
  }

  return Object.freeze({
    ACTIVITY_KEYS,
    FORMAT,
    FORMAT_VERSION,
    SECRET_KEYS,
    createBackup,
    isExtensionStorageKey,
    prepareImport,
    selectBackupData,
    validateBackup,
  });
});
