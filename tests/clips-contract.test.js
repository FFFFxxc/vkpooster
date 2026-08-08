"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const clips = fs.readFileSync(path.join(root, "clips.js"), "utf8");

test("clips coordinator uses one active normal tab and no cookie automation", () => {
  assert.equal(manifest.permissions.includes("tabs"), true);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.equal(manifest.permissions.includes("scripting"), false);
  assert.match(background, /chrome\.tabs\.create\(\{ url: clipUrl, active: true \}\)/);
  assert.doesNotMatch(background, /chrome\.windows\.create/);
  assert.doesNotMatch(background, /focused:\s*false/);
  assert.match(background, /vkr_clips_source/);
  assert.match(background, /vkr_clip_upload_tab/);
});

test("clip files remain in memory and are transferred in bounded chunks", () => {
  assert.match(clips, /const fileRegistry = new Map\(\)/);
  assert.match(background, /CLIP_CHUNK_BYTES = 128 \* 1024/);
  assert.doesNotMatch(clips, /storage\.(?:local|session)\.set\([^)]*(?:fileRegistry|fileData|dataUrl)/s);
  assert.doesNotMatch(background, /groupToken.*clip|clip.*groupToken/i);
});
