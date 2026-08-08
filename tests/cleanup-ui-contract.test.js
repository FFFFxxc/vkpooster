"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const content = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);
const css = fs.readFileSync(
  path.resolve(__dirname, "..", "content.css"),
  "utf8",
);

test("both cleanup buttons use the ticketed safe cleanup dialog", () => {
  assert.match(content, /function openBulkDeleteModal\(groupId\) \{ openSafeCleanupModal\(groupId, "wall"\); \}/);
  assert.match(content, /function openAlbumCleanModal\(groupId\) \{ openSafeCleanupModal\(groupId, "albums"\); \}/);
  assert.match(content, /sendMessage\("cleanup_preview"/);
  assert.match(content, /sendMessage\("cleanup_start"/);
  assert.match(content, /sendMessage\("cleanup_stop"/);
  assert.match(content, /document\.body\.appendChild\(deleteFab\)/);
  assert.match(content, /document\.body\.appendChild\(albumFab\)/);
});

test("safe cleanup dialog has preview, live progress, stop and finished states", () => {
  assert.match(content, /vkr-safe-cleanup-steps/);
  assert.match(content, /data-role="preview-posts"/);
  assert.match(content, /data-role="preview-photos"/);
  assert.match(content, /data-role="photo-budget"/);
  assert.match(content, /data-role="photo-budget-title"/);
  assert.match(content, /function renderPhotoBudget/);
  assert.match(content, /скользящие 24 часа/);
  assert.match(content, /data-role="progress-text"/);
  assert.match(content, /data-role="deleted-posts"/);
  assert.match(content, /data-role="deleted-photos"/);
  assert.match(content, /data-role="skipped"/);
  assert.match(content, /cancelButton\.textContent = "Стоп"/);
  assert.match(content, /message\.type === "cleanup_finished"/);
  assert.match(css, /\.vkr-safe-cleanup-dialog/);
  assert.match(css, /\.vkr-safe-cleanup-track/);
  assert.match(css, /\.vkr-safe-cleanup-budget/);
  assert.match(css, /\.vkr-safe-cleanup-budget\.is-cooldown/);
  assert.match(css, /\.vkr-safe-cleanup-progress\.is-completed/);
});
