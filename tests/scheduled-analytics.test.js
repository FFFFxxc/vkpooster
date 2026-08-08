"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const scheduled = fs.readFileSync(path.join(root, "scheduled.js"), "utf8");
const html = fs.readFileSync(path.join(root, "scheduled.html"), "utf8");
const css = fs.readFileSync(path.join(root, "scheduled-fixes.css"), "utf8");

test("post queue uses deterministic time ordering", () => {
  assert.match(scheduled, /function sortPostJobs\(/);
  assert.match(scheduled, /firstFinal\?-difference:difference/);
  assert.match(scheduled, /for\(const job of sortPostJobs\(state\.posts\)\)/);
  assert.doesNotMatch(scheduled, /for\(const job of \[\.\.\.state\.posts\]\.reverse\(\)\)/);
});

test("history restores period analytics and per-group activity ranking", () => {
  assert.match(html, /id="analytics-panel"/);
  assert.match(html, /data-analytics-days="7"/);
  assert.match(html, /data-analytics-days="30"/);
  assert.match(html, /data-analytics-days="0"/);
  assert.match(scheduled, /function analyticsMetrics\(/);
  assert.match(scheduled, /interactions\/metrics\.posts/);
  assert.match(scheduled, /type:"get_group_analytics"/);
  assert.match(background, /GROUP_ANALYTICS_CACHE_TTL_MS = 15 \* 60_000/);
  assert.match(background, /filter: "owner"/);
  assert.match(background, /count: GROUP_ANALYTICS_POST_LIMIT/);
  assert.match(css, /\.analytics-group-stats/);
  assert.match(css, /\.analytics-meter/);
});
