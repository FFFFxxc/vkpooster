"use strict";

const { requirePositiveInteger } = require("./validation.js");

function safeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^[a-zA-Z0-9:_-]{8,200}$/.test(key)) {
    throw new Error("idempotencyKey must contain 8-200 safe characters");
  }
  return key;
}

function sourceOwnerId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number === 0) {
    throw new Error("sourceOwnerId must be a non-zero integer");
  }
  return number;
}

function normalizeGroups(value) {
  if (!Array.isArray(value)) throw new Error("groups must be a non-empty array");
  const groups = [...new Set(value.map((id) => Math.abs(Number(id))).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!groups.length || groups.length > 100) {
    throw new Error("groups must contain 1-100 positive community IDs");
  }
  return groups;
}

function cleanText(value, maximum) {
  const text = String(value || "").trim();
  if (text.length > maximum) throw new Error(`text must not exceed ${maximum} characters`);
  return text;
}

function normalizeLabels(rawLabels, groups) {
  const labels = {};
  const source = rawLabels && typeof rawLabels === "object" ? rawLabels : {};
  for (const groupId of groups) {
    labels[String(groupId)] = cleanText(source[String(groupId)] || `club${groupId}`, 160) || `club${groupId}`;
  }
  return labels;
}

function normalizePreviewImages(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((raw) => {
    try {
      const url = new URL(String(raw || ""));
      if (url.protocol !== "https:") return [];
      const host = url.hostname.toLowerCase();
      const allowed = ["userapi.com", "vkuserphoto.ru", "vk-cdn.net", "vk.com", "vk.ru"];
      if (!allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return [];
      return [url.toString()];
    } catch {
      return [];
    }
  });
}

function validateScheduledPostInput(input, { now = new Date() } = {}) {
  if (!input || typeof input !== "object") throw new Error("JSON body is required");
  const idempotencyKey = safeIdempotencyKey(input.idempotencyKey);
  const normalizedSourceOwnerId = sourceOwnerId(input.sourceOwnerId);
  const sourcePostId = requirePositiveInteger(input.sourcePostId, "sourcePostId");
  const groups = normalizeGroups(input.groups);
  const mode = input.mode === "repost" ? "repost" : input.mode === "copy" ? "copy" : "";
  if (!mode) throw new Error("mode must be copy or repost");
  const publishAt = new Date(input.publishAt);
  const current = new Date(now);
  if (!Number.isFinite(publishAt.getTime())) throw new Error("publishAt must be a valid date");
  if (publishAt.getTime() < current.getTime() + 15_000) {
    throw new Error("publishAt must be at least 15 seconds in the future");
  }
  if (publishAt.getTime() > current.getTime() + 180 * 24 * 60 * 60_000) {
    throw new Error("publishAt must be within 180 days");
  }
  const userToken = String(input.userToken || "").trim();
  if (userToken.length < 20 || userToken.length > 4096) {
    throw new Error("userToken has an invalid length");
  }
  const autoCommentText = cleanText(input.autoCommentText, 4096);
 const commentDelaySeconds = Math.min(86_400, Math.max(15, Number(input.commentDelaySeconds) || 60));
  const groupIntervalSeconds = Math.min(86_400, Math.max(15, Number(input.groupIntervalSeconds) || 15));
 const commentGroupIntervalSeconds = Math.min(3_600, Math.max(15, Number(input.commentGroupIntervalSeconds) || 30));

  return {
    idempotencyKey,
    sourceOwnerId: normalizedSourceOwnerId,
    sourcePostId,
    sourceUrl: `https://vk.ru/wall${normalizedSourceOwnerId}_${sourcePostId}`,
    groups,
    groupLabels: normalizeLabels(input.groupLabels, groups),
    mode,
    text: cleanText(input.text, 16_384),
    publishAt,
    userToken,
   autoCommentText,
    groupIntervalSeconds,
   commentDelaySeconds,
    commentGroupIntervalSeconds,
    previewImages: normalizePreviewImages(input.previewImages),
    label: cleanText(input.label, 160) || `Пост wall${normalizedSourceOwnerId}_${sourcePostId}`,
  };
}

function validateScheduledPostUpdate(input, { now = new Date(), current } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("JSON body is required");
  }
  const allowed = ["text", "autoCommentText", "mode", "publishAt"];
  if (!allowed.some((field) => Object.prototype.hasOwnProperty.call(input, field))) {
    throw new Error("At least one editable field is required");
  }
  const update = {};
  if (Object.prototype.hasOwnProperty.call(input, "text")) {
    update.text = cleanText(input.text, 16_384);
  }
  if (Object.prototype.hasOwnProperty.call(input, "autoCommentText")) {
    update.autoCommentText = cleanText(input.autoCommentText, 4096);
  }
  if (Object.prototype.hasOwnProperty.call(input, "mode")) {
    if (!['copy', 'repost'].includes(input.mode)) throw new Error("mode must be copy or repost");
    update.mode = input.mode;
  }
  if (Object.prototype.hasOwnProperty.call(input, "publishAt")) {
    const publishAt = new Date(input.publishAt);
    const currentTime = new Date(now);
    if (!Number.isFinite(publishAt.getTime())) throw new Error("publishAt must be a valid date");
    if (publishAt.getTime() < currentTime.getTime() + 15_000) {
      throw new Error("publishAt must be at least 15 seconds in the future");
    }
    if (publishAt.getTime() > currentTime.getTime() + 180 * 24 * 60 * 60_000) {
      throw new Error("publishAt must be within 180 days");
    }
    if ((Number(current?.nextGroupIndex) || 0) > 0 || (Array.isArray(current?.results) && current.results.length > 0)) {
      throw new Error("publishAt cannot be changed after publishing has started");
    }
    update.publishAt = publishAt;
  }
  return update;
}

function publicPostJob(document) {
  const source = document && typeof document.toObject === "function" ? document.toObject() : { ...(document || {}) };
  const groups = Array.isArray(source.groups) ? source.groups : [];
  const results = Array.isArray(source.results) ? source.results : [];
  const cancelledGroupIds = [...new Set((Array.isArray(source.cancelledGroupIds) ? source.cancelledGroupIds : [])
    .map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const ok = results.filter((item) => item?.ok === true).length;
  const cancelled = results.filter((item) => item?.cancelled === true).length;
  const fail = results.filter((item) => item?.ok === false && item?.cancelled !== true).length;
  return {
    id: String(source._id || source.id || ""),
    idempotencyKey: source.idempotencyKey,
    source: "server",
    sourceOwnerId: source.sourceOwnerId,
    sourcePostId: source.sourcePostId,
    sourceUrl: source.sourceUrl,
    groups,
    cancelledGroupIds,
    groupLabels: source.groupLabels || {},
    mode: source.mode,
    text: source.text || "",
    label: source.label || "",
    publishAt: source.publishAt,
    pubDate: source.publishAt,
    nextRunAt: source.nextRunAt,
    nextGroupIndex: Number(source.nextGroupIndex) || 0,
    previewImages: Array.isArray(source.previewImages) ? source.previewImages : [],
   autoCommentText: source.autoCommentText || "",
    groupIntervalSeconds: Number(source.groupIntervalSeconds) || 15,
   status: source.status,
    results,
    progress: {
      total: groups.length,
      current: Math.min(groups.length, ok + fail + cancelled),
      ok,
      fail,
      cancelled,
      percent: groups.length ? Math.round(((ok + fail + cancelled) / groups.length) * 100) : 0,
    },
    attempts: Number(source.attempts) || 0,
    lastError: source.lastError || null,
    lastErrorCode: source.lastErrorCode || null,
    error: source.lastError || null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    completedAt: source.completedAt || null,
  };
}

module.exports = {
  publicPostJob,
  validateScheduledPostInput,
  validateScheduledPostUpdate,
};
