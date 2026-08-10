"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const scheduled = fs.readFileSync(path.join(root, "scheduled.js"), "utf8");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const css = fs.readFileSync(path.join(root, "scheduled-fixes.css"), "utf8");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const shadow = fs.readFileSync(path.join(root, "content-shadow-dom.js"), "utf8");

test("scheduled comments use saved community labels", () => {
  assert.match(scheduled, /vkr_group_tokens/);
  assert.match(scheduled, /vkr_user_groups/);
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

test("post queue exposes live publication and photo-upload progress", () => {
  assert.match(background, /function syncPublishJobProgress/);
  assert.match(background, /activeGroupId/);
  assert.match(background, /activeGroupIndex/);
  assert.match(scheduled, /function publishProgressSnapshot/);
  assert.match(scheduled, /appendPostProgress\(body,job\)/);
  assert.match(scheduled, /role","progressbar/);
  assert.match(scheduled, /vkr_publish_queue/);
  assert.match(css, /\.publish-progress/);
  assert.match(css, /\.publish-progress-head/);
});

test("scheduled posts can run in VK without Chrome and can be cancelled", () => {
  assert.match(background, /scheduleMode = pubDate/);
  assert.match(background, /params\.publish_date/);
  assert.match(background, /async function cancelPublishJob/);
  assert.match(background, /cancel_publish_job/);
  assert.match(background, /publishCancellationRequested/);
  assert.match(scheduled, /Запланировано в VK/);
  assert.match(scheduled, /cancel_publish_job/);
  assert.match(content, /scheduleMode: scheduleMode/);
  assert.match(shadow, /id="vkr-schedule-mode"/);
  assert.match(css, /\.status\.scheduled/);
});
