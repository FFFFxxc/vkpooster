"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("copy mode uploads photos into every target community before wall.post", () => {
  assert.match(background, /function prepareOwnedCopyAttachments\(/);
  assert.match(background, /photos\.getWallUploadServer/);
  assert.match(background, /photos\.saveWallPhoto/);
  assert.match(background, /buildOwnedPhotoAttachment\(saved\[0\], groupId\)/);
  assert.match(background, /attachments\.filter\(\(attachment\) => attachment\?\.type !== "photo"\)/);
  assert.match(background, /const attachments = await prepareOwnedCopyAttachments\(/);
  assert.doesNotMatch(background, /buildReusableAttachments\(job\.post\.attachments\)/);
});

test("photo preparation is restart-safe and never falls back after ownership failure", () => {
  assert.match(background, /job\.preparedMedia/);
  assert.match(background, /await persistJob\(job\)/);
  assert.match(background, /error\.nonRetryable = true/);
  assert.match(background, /reason: "media"/);
  assert.match(background, /delete job\.preparedMedia/);
});

test("manifest grants only narrow VK CDN access needed to download source photos", () => {
  for (const permission of [
    "https://*.userapi.com/*",
    "https://*.vkuserphoto.ru/*",
    "https://*.vk-cdn.net/*",
  ]) {
    assert.equal(manifest.host_permissions.includes(permission), true);
  }
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});
