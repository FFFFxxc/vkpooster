(function exposeClipQueueCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VkrClipQueueCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
  const ACTIVE_STATES = new Set(["opening_tab", "transferring", "uploading"]);
  const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
  const ALLOWED_EVENTS = {
    queued: new Set(["tab_opened", "cancel", "source_disconnected"]),
    opening_tab: new Set(["tab_ready", "pause", "fail", "cancel", "source_disconnected"]),
    transferring: new Set(["transfer_progress", "upload_started", "pause", "fail", "cancel", "source_disconnected"]),
    uploading: new Set(["upload_progress", "complete", "pause", "fail", "cancel", "source_disconnected"]),
    paused: new Set(["resume", "cancel", "source_disconnected"]),
  };

  function createId() {
    return `clip_${Date.now()}_${crypto.randomUUID()}`;
  }

  function safeText(value, limit) {
    return String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, limit);
  }

  function normalizeFiles(files) {
    const seen = new Set();
    return (Array.isArray(files) ? files : []).map((file) => {
      const id = safeText(file?.id, 120);
      const name = safeText(file?.name, 200);
      const size = Number(file?.size);
      const type = String(file?.type || "").toLowerCase();
      if (!id || !name || seen.has(id) || !Number.isSafeInteger(size) || size <= 0 || !VIDEO_TYPES.has(type)) {
        throw new Error("Некорректный видеофайл для клипа.");
      }
      seen.add(id);
      return { id, name, size, type };
    });
  }

  function normalizeGroups(groups) {
    const seen = new Set();
    return (Array.isArray(groups) ? groups : []).map((group) => {
      const id = Math.abs(Number(group?.id));
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) throw new Error("Некорректное сообщество.");
      seen.add(id);
      const screenName = safeText(group?.screenName, 100).replace(/[^a-zA-Z0-9_.]/g, "") || `club${id}`;
      return { id, name: safeText(group?.name, 160) || `Сообщество ${id}`, screenName };
    });
  }

  function createClipJobs({ sourceId, files, groups, defaults = {}, now = Date.now(), createId: idFactory = createId }) {
    const safeSourceId = safeText(sourceId, 120);
    if (!safeSourceId) throw new Error("Не найдена страница загрузчика клипов.");
    const normalizedFiles = normalizeFiles(files);
    const normalizedGroups = normalizeGroups(groups);
    if (!normalizedFiles.length || !normalizedGroups.length) throw new Error("Выберите хотя бы один файл и одно сообщество.");
    const description = safeText(defaults.description, 4096);
    const wallPost = defaults.wallPost === true;
    const firstPublishAt = Number(defaults.publishAt) || null;
    const intervalMinutes = defaults.intervalMinutes === undefined || defaults.intervalMinutes === null || defaults.intervalMinutes === ""
      ? 0
      : Number(defaults.intervalMinutes);
    if (firstPublishAt && firstPublishAt <= Number(now)) throw new Error("Время публикации клипа должно быть в будущем.");
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 10_080) {
      throw new Error("Интервал между клипами должен быть от 0 до 10080 минут.");
    }
    const jobs = [];
    for (let fileIndex = 0; fileIndex < normalizedFiles.length; fileIndex += 1) {
      const file = normalizedFiles[fileIndex];
      const offsetMs = fileIndex * intervalMinutes * 60_000;
      const publishAt = firstPublishAt
        ? firstPublishAt + offsetMs
        : fileIndex > 0 && intervalMinutes > 0
          ? Number(now) + offsetMs
          : null;
      for (const group of normalizedGroups) {
        jobs.push(Object.freeze({
          id: String(idFactory()), sourceId: safeSourceId, fileId: file.id, fileName: file.name,
          fileSize: file.size, fileType: file.type, groupId: group.id, groupName: group.name,
          groupScreenName: group.screenName, description, wallPost, publishAt, status: "queued", progress: 0,
          createdAt: Number(now), updatedAt: Number(now), error: null, tabId: null,
        }));
      }
    }
    return jobs;
  }

  function nextRunnableJob(jobs) {
    const all = Array.isArray(jobs) ? jobs : [];
    if (all.some((job) => ACTIVE_STATES.has(job?.status))) return null;
    return all.find((job) => job?.status === "queued") || null;
  }

  function safeError(value) {
    return safeText(value, 500) || "VK остановил операцию; проверьте открытую вкладку.";
  }

  function transitionClipJob(job, event, now = Date.now()) {
    if (!job?.id || !ALLOWED_EVENTS[job.status]?.has(event?.type)) {
      throw new Error(`Cannot transition clip job from ${job?.status || "unknown"} with ${event?.type || "unknown"}.`);
    }
    const next = { ...job, updatedAt: Number(now) };
    switch (event.type) {
      case "tab_opened": return { ...next, status: "opening_tab", tabId: Number(event.tabId), error: null };
      case "tab_ready": return { ...next, status: "transferring", progress: 0 };
      case "transfer_progress": return { ...next, progress: Math.max(0, Math.min(99, Number(event.progress) || 0)) };
      case "upload_started": return { ...next, status: "uploading", progress: 100 };
      case "upload_progress": return { ...next, progress: Math.max(0, Math.min(100, Number(event.progress) || 0)) };
      case "complete": return { ...next, status: "completed", progress: 100, completedAt: Number(now), error: null, tabId: null };
      case "pause": return { ...next, status: "paused", error: safeError(event.error), tabId: Number.isSafeInteger(event.tabId) ? event.tabId : job.tabId };
      case "fail": return { ...next, status: "failed", error: safeError(event.error), failedAt: Number(now), tabId: null };
      case "cancel": return { ...next, status: "cancelled", cancelledAt: Number(now), error: null, tabId: null };
      case "source_disconnected": return { ...next, status: "paused", error: "Страница загрузчика закрыта. Откройте её и возобновите очередь.", tabId: job.tabId || null };
      case "resume": return { ...next, status: "queued", error: null, tabId: null, progress: 0 };
      default: throw new Error("Cannot transition clip job.");
    }
  }

  function toClipHistory(job) {
    const record = {
      id: String(job?.id || ""), fileName: safeText(job?.fileName, 200), groupId: Number(job?.groupId) || null,
      groupName: safeText(job?.groupName, 160), description: safeText(job?.description, 4096),
      wallPost: job?.wallPost === true, publishAt: Number(job?.publishAt) || null, status: safeText(job?.status, 30),
      progress: Math.max(0, Math.min(100, Number(job?.progress) || 0)), error: safeText(job?.error, 500),
      createdAt: Number(job?.createdAt) || null, updatedAt: Number(job?.updatedAt) || null,
      completedAt: Number(job?.completedAt) || null,
    };
    return record;
  }

  return Object.freeze({ ACTIVE_STATES, TERMINAL_STATES, createClipJobs, nextRunnableJob, toClipHistory, transitionClipJob });
});
