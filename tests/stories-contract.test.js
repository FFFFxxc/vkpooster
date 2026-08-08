"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

const scheduled = fs.readFileSync(path.join(root, "scheduled.js"), "utf8");
const stories = fs.readFileSync(path.join(root, "stories.js"), "utf8");
const app = fs.readFileSync(path.join(root, "server", "src", "app.js"), "utf8");

test("story media is uploaded raw and scheduled cards use captured previews", () => {
  assert.match(stories, /raw\s*:\s*selectedFile/);
  assert.match(app, /express\.raw/);
  assert.match(scheduled, /job\.previewDataUrl/);
  assert.doesNotMatch(scheduled, /wall\.getById|stories\.getById|analyze_activity/);
});

test("story UI requires a locally configured community token", () => {
  assert.match(stories, /vkr_group_tokens/);
  assert.match(stories, /groupToken\s*:\s*group\.token/);
  assert.doesNotMatch(stories, /vk_token/);
});
