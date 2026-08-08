"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);
const background = fs.readFileSync(
  path.join(root, "background.js"),
  "utf8",
);
const scheduled = fs.readFileSync(
  path.join(root, "scheduled.js"),
  "utf8",
);
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");

test("manifest has no cookie interception, OAuth impersonation, or global hosts", () => {
  assert.equal(manifest.version, "4.3.1");
  for (const permission of [
    "cookies",
    "declarativeNetRequest",
    "webRequest",
    "webRequestBlocking",
    "downloads",
    "scripting",
  ]) {
    assert.equal(manifest.permissions.includes(permission), false);
  }
  assert.equal(manifest.permissions.includes("tabs"), true);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.equal(
    manifest.host_permissions.some((host) => host.includes("oauth.vk.")),
    false,
  );
});

test("active service worker contains no legacy account sync or like automation", () => {
  for (const forbidden of [
    "chrome.cookies",
    "declarativeNetRequest",
    "/api/accounts",
    "likes.add",
    "login.vk.com",
    "start_cookie_auth",
    "2685278",
    "vkr_get_video_qualities",
    "VKR_INJECT_MAIN_SCRIPT",
  ]) {
    assert.equal(
      background.includes(forbidden),
      false,
      `background.js must not contain ${forbidden}`,
    );
  }
});

test("video cookie automation is absent and queue cleanup goes through worker", () => {
  for (const forbidden of [
    "credentials: 'include'",
    'credentials: "include"',
    "al_video.php",
    "download_video_direct",
  ]) {
    assert.equal(content.includes(forbidden), false);
  }
  assert.equal(
    scheduled.includes(
      "chrome.storage.local.set({ vkr_publish_queue: queue })",
    ),
    false,
  );
  assert.match(scheduled, /type\s*:\s*"clear_finished_queue"/);
});
