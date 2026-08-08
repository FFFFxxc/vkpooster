"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const scheduled = fs.readFileSync(path.join(root, "scheduled.js"), "utf8");
const html = fs.readFileSync(path.join(root, "scheduled.html"), "utf8");
const css = fs.readFileSync(path.join(root, "scheduled-fixes.css"), "utf8");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");

test("scheduled post cards render every photo as an accessible carousel", () => {
  assert.match(scheduled, /function postPhotos\(/);
  assert.match(scheduled, /item\.photoDataUrls/);
  assert.match(scheduled, /gallery-arrow previous/);
  assert.match(scheduled, /gallery-arrow next/);
  assert.match(scheduled, /gallery-dots/);
  assert.match(scheduled, /ArrowLeft/);
  assert.match(scheduled, /pointerup/);
  assert.match(css, /perspective:\s*850px/);
  assert.match(css, /rotateY\(var\(--gallery-tilt-y\)\)/);
  assert.match(css, /prefers-reduced-motion/);
});

test("queue pause always explains the safety stop and exposes the right action", () => {
  assert.match(html, /id="pause-title"/);
  assert.match(html, /id="pause-technical"/);
  assert.match(html, /id="pause-open-job"/);
  assert.match(scheduled, /function describePause\(/);
  assert.match(scheduled, /старую паузу без текста причины/);
  assert.match(scheduled, /comment:"Расширение поставило отложенный комментарий на паузу"/);
  assert.match(scheduled, /pause\.reason==="ambiguous_repost"/);
  assert.match(scheduled, /result\.requiresDecision/);
  assert.match(scheduled, /state\.pause=null;updatePauseAlert\(\)/);
  assert.match(scheduled, /chrome\.storage\.onChanged\.addListener/);
  assert.match(css, /\.pause-alert\[hidden\]/);
  assert.match(background, /setQueuePause\(error, job\.id, "post"\)/);
  assert.match(background, /setQueuePause\(error, null, "comment"\)/);
});

test("data maintenance exposes scoped cleanup without deleting active jobs", () => {
  assert.match(html, /id="cleanup-data"/);
  assert.match(html, /id="maintenance-dialog"/);
  assert.match(html, /id="maintenance-errors"/);
  assert.match(html, /id="maintenance-completed"/);
  assert.match(html, /id="maintenance-all"/);
  assert.match(scheduled, /type:"purge_maintenance",scope/);
  assert.match(scheduled, /Ожидающие, выполняющиеся и приостановленные задания удалены не будут/);
  assert.match(background, /type === "purge_maintenance"/);
  assert.match(background, /purgeLocalMaintenanceRecords/);
  assert.match(background, /scheduled-comments\?scope=/);
  assert.match(background, /scheduled-stories\?scope=/);
  assert.match(css, /\.maintenance-stats/);
  assert.match(css, /\.maintenance-danger/);
});
