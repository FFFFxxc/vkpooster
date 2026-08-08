"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const markup = fs.readFileSync(path.join(root, "content-shadow-dom.js"), "utf8");
const css = fs.readFileSync(path.join(root, "modal.css"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("group-set core loads before the modal content script", () => {
  assert.deepEqual(manifest.content_scripts[0].js.slice(0, 3), [
    "group-sets-core.js",
    "content-shadow-dom.js",
    "content.js",
  ]);
});

test("post modal exposes create, apply, edit and delete controls", () => {
  for (const id of [
    "vkr-group-set-new",
    "vkr-group-sets-list",
    "vkr-group-set-editor",
    "vkr-group-set-name",
    "vkr-group-set-save",
    "vkr-group-set-delete",
    "vkr-group-set-cancel",
  ]) {
    assert.match(markup, new RegExp(`id=["']${id}["']`));
  }
  assert.match(content, /const GROUP_SETS_STORAGE_KEY = "vkr_group_sets_v1"/);
  assert.match(content, /async function applyGroupSet/);
  assert.match(content, /async function saveGroupSetFromEditor/);
  assert.match(content, /async function deleteEditingGroupSet/);
  assert.match(content, /await chrome\.storage\.local\.set\(\{ \[GROUP_SETS_STORAGE_KEY\]: groupSets \}\)/);
});

test("saved names render as text and unavailable communities are reported", () => {
  assert.match(content, /name\.textContent = set\.name/);
  assert.match(content, /groupSetsCore\.resolveAvailableGroups/);
  assert.match(content, /недоступно или скрыто/);
  assert.match(content, /function unavailableIdsFromEditingSet/);
  assert.match(content, /\.\.\.unavailableIdsFromEditingSet\(\)/);
  assert.match(content, /chrome\.storage\.local\.set\(\{ vkr_groups: resolved\.selectedIds \}\)/);
});

test("group sets have active, editor and narrow-layout styles", () => {
  assert.match(css, /\.vkr-group-set-chip\.active/);
  assert.match(css, /\.vkr-group-set-editor\[hidden\]/);
  assert.match(css, /#vkr-group-set-new/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.vkr-group-sets-head/);
});
