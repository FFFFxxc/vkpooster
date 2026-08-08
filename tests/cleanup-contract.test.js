"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");

test("cleanup uses ticketed sequential messages and never VK execute", () => {
  for (const type of ["cleanup_preview", "cleanup_start", "cleanup_stop"]) {
    assert.match(background, new RegExp(`type === ["']${type}["']`));
  }
  assert.match(background, /VkrCleanupCore/);
  assert.match(background, /VkrCleanupRunner/);
  assert.match(background, /type: "cleanup_progress"/);
  assert.doesNotMatch(background, /vkApi\(\s*["']execute["']/);
});
