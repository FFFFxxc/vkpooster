"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const clips = fs.readFileSync(path.join(root, "clips.js"), "utf8");
const clipsHtml = fs.readFileSync(path.join(root, "clips.html"), "utf8");
const clipsCss = fs.readFileSync(path.join(root, "clips-fixes.css"), "utf8");
const clipUpload = fs.readFileSync(path.join(root, "clip-upload-content.js"), "utf8");
const meshText = fs.readFileSync(path.join(root, "mesh-text.js"), "utf8");

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

test("clip uploader preserves the community route and verifies the author", () => {
  assert.match(background, /group\.screen_name/);
  assert.match(background, /clips\/\$\{encodeURIComponent\(screenName\)\}/);
  assert.doesNotMatch(background, /clips\/club\$\{job\.groupId\}/);
  assert.match(clipUpload, /assertCommunityRoute\(options\)/);
  assert.match(clipUpload, /ensureCommunityAuthor\(options\)/);
});

test("clip interval and long filenames are visible in the UI", () => {
  assert.match(clips, /intervalMinutes/);
  assert.match(clips, /createClipTimeline/);
  assert.match(clips, /formatScheduleTime/);
  assert.match(clipsHtml, /id="schedule-preview"/);
  assert.match(clipsHtml, /id="clear-files"/);
  assert.match(clipsHtml, /id="clear-history"/);
  assert.doesNotMatch(clipsHtml, /Новая очередь|Очередь и история/);
  assert.match(clips, /copy\.className = "file-copy"/);
  assert.match(clips, /name\.title = entry\.file\.name/);
  assert.match(clipsCss, /\.file-copy/);
});

test("ready clip queue gets a lightweight accessible flame action", () => {
  assert.match(clipsHtml, /id="start-flame" class="flame-wrap"/);
  assert.match(clips, /classList\.toggle\("is-active", canStart\)/);
  assert.match(clipsCss, /@keyframes flame-border-turn/);
  assert.match(clipsCss, /@keyframes flame-spark-rise/);
  assert.match(clipsCss, /prefers-reduced-motion: reduce/);
});

test("clip title has a progressive WebGL mesh hover with a text fallback", () => {
  assert.match(clipsHtml, /id="clips-mesh-title"/);
  assert.match(clipsHtml, /<h1>Загрузка клипов<\/h1>/);
  assert.match(clipsHtml, /<canvas aria-hidden="true"><\/canvas>/);
  assert.match(meshText, /getContext\("webgl2"/);
  assert.match(meshText, /pointermove/);
  assert.match(meshText, /maximumMotion > 0\.00008/);
  assert.match(clipsCss, /prefers-reduced-motion: reduce/);
});

test("clip results can be cleared without deleting current queue files", () => {
  assert.match(background, /type === "clips_clear_history"/);
  assert.match(background, /chrome\.storage\.local\.remove\(CLIP_HISTORY_KEY\)/);
  assert.match(clips, /selectedFilesAreLocked/);
});

test("stale automation state cannot hide controls on a community page", () => {
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.match(content, /const isAutomationTab = Boolean\(clipAutomationJobId\)/);
  assert.doesNotMatch(content, /sessionStorage\.getItem\(['"]vkr_automation_tab['"]\) === ['"]1['"]/);
});
