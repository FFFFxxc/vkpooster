"use strict";

const { requirePositiveInteger } = require("./validation.js");

const ALLOWED_STORY_MIME_TYPES = new Set(["image/jpeg", "image/png", "video/mp4", "video/quicktime", "video/webm"]);
const ALLOWED_STORY_LINK_TEXTS = new Set([
  "to_store", "vote", "more", "book", "order", "enroll", "fill", "signup", "buy", "ticket",
  "write", "open", "learn_more", "view", "go_to", "contact", "watch", "play", "install", "read",
  "calendar", "market_online_booking", "market_link", "message_to_bc",
]);

function cleanText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, limit);
}

function validateStoryDraftInput(input, { now = new Date() } = {}) {
  if (!input || typeof input !== "object") throw new Error("JSON body is required");
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!/^[a-zA-Z0-9:_-]{8,200}$/.test(idempotencyKey)) throw new Error("idempotencyKey must contain 8-200 safe characters");
  const groupId = requirePositiveInteger(input.groupId, "groupId");
  const groupName = cleanText(input.groupName, 160) || `Сообщество ${groupId}`;
  const publishAt = new Date(input.publishAt);
  const current = new Date(now);
  if (!Number.isFinite(publishAt.getTime())) throw new Error("publishAt must be a valid date");
  if (publishAt.getTime() < current.getTime() + 60_000) throw new Error("publishAt must be at least 60 seconds in the future");
  if (publishAt.getTime() > current.getTime() + 180 * 24 * 60 * 60_000) throw new Error("publishAt must be within 180 days");
  const groupToken = String(input.groupToken || "").trim();
  if (groupToken.length < 20 || groupToken.length > 4096) throw new Error("groupToken has an invalid length");
  let linkUrl = String(input.linkUrl || "").trim();
  let linkText = String(input.linkText || "").trim();
  if (linkUrl) {
    if (linkUrl.length > 2048) throw new Error("linkUrl is too long");
    let url;
    try { url = new URL(linkUrl); } catch { throw new Error("linkUrl must be an internal HTTPS vk.com or vk.ru URL"); }
    if (url.protocol !== "https:" || !["vk.com", "www.vk.com", "vk.ru", "www.vk.ru"].includes(url.hostname)) {
      throw new Error("linkUrl must be an internal HTTPS vk.com or vk.ru URL");
    }
    // VK's public API schema still accepts CTA links on vk.com only, even when
    // the visible site uses vk.ru. Normalize the equivalent first-party host.
    if (url.hostname === "vk.ru") url.hostname = "vk.com";
    if (url.hostname === "www.vk.ru") url.hostname = "www.vk.com";
    linkUrl = url.toString();
    if (!ALLOWED_STORY_LINK_TEXTS.has(linkText)) throw new Error("linkText is invalid for a VK story");
  } else {
    if (linkText) throw new Error("linkText requires linkUrl");
    linkText = "";
  }
  const previewDataUrl = String(input.previewDataUrl || "");
  if (previewDataUrl && (!/^data:image\/(?:jpeg|png);base64,/i.test(previewDataUrl) || previewDataUrl.length > 180_000)) {
    throw new Error("previewDataUrl must be a small JPEG or PNG data URL");
  }
  return { idempotencyKey, groupId, groupName, publishAt, groupToken, linkUrl, linkText, previewDataUrl };
}

function validateStoryMedia({ fileName, mimeType, byteLength, maxBytes }) {
  const safeName = cleanText(fileName, 200).replace(/[\\/:*?"<>|]/g, "_");
  const type = String(mimeType || "").toLowerCase();
  const length = Number(byteLength);
  const maximum = Number(maxBytes);
  if (!safeName) throw new Error("fileName is required");
  if (!ALLOWED_STORY_MIME_TYPES.has(type)) throw new Error("mimeType is not supported for VK stories");
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("byteLength must be a positive integer");
  if (!Number.isSafeInteger(maximum) || maximum < 1 || length > maximum) throw new Error(`Media exceeds the maximum of ${maximum} bytes`);
  return { fileName: safeName, mimeType: type, byteLength: length, kind: type.startsWith("image/") ? "photo" : "video" };
}

function publicStoryJob(document) {
  const source = document && typeof document.toObject === "function" ? document.toObject() : { ...(document || {}) };
  return {
    id: String(source._id || source.id || ""), idempotencyKey: source.idempotencyKey,
    groupId: source.groupId, groupName: source.groupName, publishAt: source.publishAt,
    linkUrl: source.linkUrl || "", linkText: source.linkText || "", previewDataUrl: source.previewDataUrl || "",
    kind: source.kind || null, fileName: source.fileName || null, mimeType: source.mimeType || null,
    byteLength: source.byteLength || null, status: source.status, attempts: source.attempts || 0,
    lastError: source.lastError || null, lastErrorCode: source.lastErrorCode || null,
    storyId: source.storyId || null, createdAt: source.createdAt, updatedAt: source.updatedAt,
    completedAt: source.completedAt || null,
  };
}

module.exports = { ALLOWED_STORY_LINK_TEXTS, ALLOWED_STORY_MIME_TYPES, publicStoryJob, validateStoryDraftInput, validateStoryMedia };
