"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");

test("TwiBoost is available through a narrowly scoped background integration", () => {
  assert.ok(manifest.host_permissions.includes("https://twiboost.com/*"));
  assert.match(background, /type === "twiboost_services"/);
  assert.match(background, /type === "twiboost_balance"/);
  assert.match(background, /type === "twiboost_order"/);
  assert.match(background, /method: "POST"/);
});

test("TwiBoost key stays local and is never embedded in tracked source", () => {
  assert.match(background, /TWIBOOST_KEY_STORAGE = "vkr_twiboost_api_key"/);
  assert.match(background, /key = await loadTwiBoostKey\(\)/);
  assert.doesNotMatch(background, /const TWIBOOST_KEY\s*=/);
  assert.match(gitignore, /twiboost-key\.local\.txt/);
  assert.match(content, /type: "twiboost_save_key"/);
  assert.match(content, /Ключ хранится только в этом браузере/);
});

test("TwiBoost service labels are rendered as text instead of API HTML", () => {
  assert.match(content, /name\.textContent = String\(s\.name/);
  assert.doesNotMatch(content, /<span style="flex: 1;">\$\{s\.name\}/);
});
