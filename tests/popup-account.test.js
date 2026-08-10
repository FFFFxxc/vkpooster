"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const auth = fs.readFileSync(path.join(root, "popup-auth.js"), "utf8");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");

test("connected user token is represented by a VK profile card", () => {
  assert.match(html, /id="user-profile-avatar"/);
  assert.match(html, /id="user-profile-name"/);
  assert.match(html, /id="replace-user-token"/);
  assert.match(auth, /function renderUserAccount/);
  assert.match(auth, /user\.photo_100 \|\| user\.photo_50/);
  assert.match(background, /photo_50,photo_100,screen_name/);
});

test("popup omits temporary safe-mode warnings and labels", () => {
  assert.doesNotMatch(html, /Cookie-вход|Kate Mobile|Первый тест сделайте|safe queue/);
  assert.doesNotMatch(html, /logo__badge">SAFE/);
});

test("popup exposes user-first communities and optional 24/7 group tokens", () => {
  assert.match(html, /id="managed-group-list"/);
  assert.match(html, /Мои сообщества/);
  assert.match(html, /Токены сообществ 24\/7 \(необязательно\)/);
  assert.match(html, /value="local_user"/);
  assert.match(auth, /list_managed_communities/);
  assert.match(auth, /vkr_comment_execution_mode/);
});
