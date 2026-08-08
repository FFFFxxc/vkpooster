"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("copy mode uploads photos into every target community before wall.post", () => {
  assert.match(background, /function prepareOwnedCopyAttachments\(/);
  assert.match(background, /photos\.getWallUploadServer/);
  assert.match(background, /photos\.saveWallPhoto/);
  assert.match(background, /buildUploadedPhotoAttachment\(saved\[0\], photo\)/);
  assert.match(background, /attachments\.filter\(\(attachment\) => attachment\?\.type !== "photo"\)/);
  assert.match(background, /const attachments = await prepareOwnedCopyAttachments\(/);
  assert.match(background, /operation: "upload"/);
  assert.match(background, /mediaCredential\?\.token \|\| credential\.token/);
  assert.doesNotMatch(background, /buildReusableAttachments\(job\.post\.attachments\)/);
});

test("local user token uploads copied photos before the final wall.post", () => {
  const uploadSelection = background.indexOf('operation: "upload"');
  const attachmentPreparation = background.indexOf("prepareOwnedCopyAttachments(", uploadSelection);
  const wallPost = background.indexOf('vkApi("wall.post"', attachmentPreparation);
  assert.ok(uploadSelection >= 0);
  assert.ok(attachmentPreparation > uploadSelection);
  assert.ok(wallPost > attachmentPreparation);
  assert.match(
    background.slice(uploadSelection, wallPost),
    /userToken: credentials\.userToken/,
  );
  assert.match(
    background.slice(attachmentPreparation, wallPost + 80),
    /vkApi\("wall\.post", params, credential\.token\)/,
  );
});

test("posts with copied photos use local user auth through the final wall.post", () => {
  assert.match(background, /const photoPostUsesUser = job\.mode === "copy" && sourcePhotos\.length > 0/);
  assert.match(background, /const postWithUser = publishWithUser \|\| photoPostUsesUser/);
  assert.match(background, /allowUserFallback: postWithUser/);
});

test("VK group-auth photo error is explained as a local user-token problem", () => {
  assert.match(background, /async function vkPhotoApi\(/);
  assert.match(background, /code === 27/);
  assert.match(background, /токен сообщества для загрузки фотографий не подходит/i);
});

test("photo preparation is restart-safe and never falls back after upload validation failure", () => {
  assert.match(background, /job\.preparedMedia/);
  assert.match(background, /current\?\.version === 2/);
  assert.match(background, /current\.photos\.every\(isUploadedPhotoAttachment\)/);
  assert.match(background, /await persistJob\(job\)/);
  assert.match(background, /error\.nonRetryable = true/);
  assert.match(background, /reason: "media"/);
  assert.match(background, /delete job\.preparedMedia/);
});

test("manifest grants only narrow VK CDN access needed to download source photos", () => {
  for (const permission of [
    "https://*.userapi.com/*",
    "https://*.vkuserphoto.ru/*",
    "https://*.vk-cdn.net/*",
  ]) {
    assert.equal(manifest.host_permissions.includes(permission), true);
  }
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});
