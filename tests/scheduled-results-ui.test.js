"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const scheduled = fs.readFileSync(path.join(root, "scheduled.js"), "utf8");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const css = fs.readFileSync(path.join(root, "scheduled-fixes.css"), "utf8");

test("scheduled comments use saved community labels", () => {
  assert.match(scheduled, /vkr_group_tokens/);
  assert.match(scheduled, /groupName\(groupId\)/);
  assert.match(scheduled, /entry\.label/);
});

test("partial post failures are visible per community", () => {
  assert.match(scheduled, /appendPublishResults\(body,job\.results\)/);
  assert.match(scheduled, /result\.error/);
  assert.match(scheduled, /partial:"Частично"/);
  assert.match(css, /\.result-details/);
  assert.match(css, /\.result-item\.failure/);
});

test("extension action menu exposes schedules, clips and stories", () => {
  assert.match(background, /vkr-open-scheduled/);
  assert.match(background, /vkr-open-clips/);
  assert.match(background, /vkr-open-stories/);
});
