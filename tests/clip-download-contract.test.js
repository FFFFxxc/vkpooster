"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const popupAuth = fs.readFileSync(path.join(root, "popup-auth.js"), "utf8");

function loadVideoUrlValidator() {
  const source = background.match(/function isAllowedVkVideoUrl\(rawUrl\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, "background.js must expose the clip URL validator");
  return Function(`return (${source})`)();
}

test("clip quality panel is packaged and bridged to validated direct downloads", () => {
  assert.equal(fs.existsSync(path.join(root, "injection.js")), true);
  assert.equal(manifest.permissions.includes("downloads"), true);
  const resources = manifest.web_accessible_resources.flatMap((item) => item.resources || []);
  assert.equal(resources.includes("injection.js"), true);
  assert.match(content, /VKR_REQUEST_VIDEO_QUALITIES/);
  assert.match(content, /VKR_DOWNLOAD_VIDEO/);
  assert.match(background, /vkr_get_video_qualities/);
  assert.match(background, /download_video_direct/);
  assert.match(background, /isAllowedVkVideoUrl/);
});

test("popup restores the clip download switch", () => {
  assert.match(popup, /id="video-download-toggle"/);
  assert.match(popupAuth, /vkr_video_download/);
  assert.match(popupAuth, /video-download-toggle/);
});

test("clip downloads accept VK okcdn media URLs without accepting lookalike hosts", () => {
  const isAllowedVkVideoUrl = loadVideoUrlValidator();

  assert.equal(
    isAllowedVkVideoUrl("https://vkvd630.okcdn.ru/video.mp4?sig=vk"),
    true,
  );
  assert.equal(
    isAllowedVkVideoUrl("https://vkvd630.okcdn.ru/video.m3u8?sig=vk"),
    true,
  );
  assert.equal(isAllowedVkVideoUrl("https://okcdn.ru.evil.example/video.mp4"), false);
  assert.equal(isAllowedVkVideoUrl("https://evilokcdn.ru/video.mp4"), false);
  assert.equal(isAllowedVkVideoUrl("http://vkvd630.okcdn.ru/video.mp4"), false);
});
