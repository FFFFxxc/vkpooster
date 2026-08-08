"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const content = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
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
