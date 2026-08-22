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
  assert.match(scheduled, /vkr_user_groups/);
  assert.match(scheduled, /groupName\(groupId\)/);
  assert.doesNotMatch(scheduled, /vkr_group_tokens|entry\.label/);
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

test("scheduled posts run on the server at photo time and can be cancelled", () => {
  assert.match(background, /serverRequest\("\/api\/scheduled-posts"/);
  assert.match(background, /scheduleMode:\s*"server_user"/);
  assert.doesNotMatch(background, /params\.publish_date/);
  assert.match(background, /async function cancelPublishJob/);
  assert.match(background, /cancel_publish_job/);
  assert.match(background, /publishCancellationRequested/);
  assert.match(scheduled, /list_scheduled_posts/);
  assert.match(scheduled, /cancel_scheduled_post/);
  assert.match(scheduled, /cancel_publish_job/);
  assert.match(content, /scheduleMode:\s*"server_user"/);
  assert.match(shadow, /id="vkr-schedule-mode"/);
  assert.match(css, /\.status\.scheduled/);
});

test("scheduled server posts and comments expose editing and per-community cancellation", () => {
  assert.match(background, /update_scheduled_post/);
  assert.match(background, /cancel_scheduled_post_group/);
  assert.match(background, /update_scheduled_comment/);
  assert.match(scheduled, /openPostEdit/);
  assert.match(scheduled, /openCommentEdit/);
  assert.match(scheduled, /Не публиковать/);
  assert.match(scheduled, /Редактировать/);
});
