"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { publicStoryJob, validateStoryDraftInput, validateStoryMedia } = require("../src/story-validation.js");

test("story draft accepts a future community story with an internal VK link", () => {
  const draft = validateStoryDraftInput({
    idempotencyKey: "story_1:42:abc12345", groupId: "42", groupName: "Test club",
    publishAt: "2026-08-09T12:00:00.000Z", groupToken: "x".repeat(40),
    linkUrl: "https://vk.com/club42", linkText: "go_to", previewDataUrl: "data:image/jpeg;base64,AA==",
  }, { now: new Date("2026-08-08T12:00:00.000Z") });
  assert.equal(draft.groupId, 42);
  assert.equal(draft.linkUrl, "https://vk.com/club42");
});

test("story rejects external CTA links and oversized media", () => {
  assert.throws(() => validateStoryDraftInput({
    idempotencyKey: "story_1:42:abc12345", groupId: 42, publishAt: "2026-08-09T12:00:00.000Z",
    groupToken: "x".repeat(40), linkUrl: "https://example.com",
  }, { now: new Date("2026-08-08T12:00:00.000Z") }), /vk\.com/i);
  assert.throws(() => validateStoryMedia({ fileName: "clip.mp4", mimeType: "video/mp4", byteLength: 25 * 1024 * 1024 + 1, maxBytes: 25 * 1024 * 1024 }), /maximum/i);
});

test("story normalizes the visible vk.ru host to the API-supported vk.com host", () => {
  const draft = validateStoryDraftInput({
    idempotencyKey: "story_vkru:42:abc12345", groupId: 42,
    publishAt: "2026-08-09T12:00:00.000Z", groupToken: "x".repeat(40),
    linkUrl: "https://vk.ru/club42", linkText: "go_to",
  }, { now: new Date("2026-08-08T12:00:00.000Z") });
  assert.equal(draft.linkUrl, "https://vk.com/club42");
});

test("public story serializer never exposes token or GridFS internals", () => {
  const job = publicStoryJob({ _id: "story-id", groupId: 42, status: "queued", tokenCiphertext: "c", tokenIv: "i", tokenTag: "t", mediaId: "grid" });
  assert.equal(job.id, "story-id");
  for (const field of ["tokenCiphertext", "tokenIv", "tokenTag", "mediaId"]) assert.equal(field in job, false);
});
