"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const background = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"),
  "utf8",
);

test("service-worker lifecycle shutdowns do not become unhandled errors", () => {
  assert.match(background, /function isServiceWorkerLifecycleError\(/);
  assert.match(background, /function runInBackground\(/);
  assert.match(background, /No SW/);
  assert.doesNotMatch(background, /void processPublishQueue\(\)/);
  assert.doesNotMatch(background, /void recoverQueue\(\)/);
});

test("every alarm creation is awaited so runtime.lastError is consumed", () => {
  const alarmCreationLines = background
    .split(/\r?\n/)
    .filter((line) => line.includes("chrome.alarms.create("));
  assert.ok(alarmCreationLines.length >= 3);
  for (const line of alarmCreationLines) {
    assert.match(line, /await chrome\.alarms\.create\(/);
  }
});
