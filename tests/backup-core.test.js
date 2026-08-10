"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Backup = require("../backup-core.js");

const root = path.resolve(__dirname, "..");
const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(root, "popup-auth.js"), "utf8");

const sample = {
  vk_token: "user-token",
  vkr_group_tokens: { 123: { token: "group-token" } },
  vkr_server_api_secret: "server-secret",
  vkr_server_url: "https://example.onrender.com",
  vkr_group_sets_v1: [{ id: "set-1", name: "Группа 1", groupIds: [123] }],
  vkr_publish_queue: [{ id: "job-1", status: "queued" }],
  unrelated_key: "skip-me",
};

test("settings export keeps configuration and optional secrets but skips activity", () => {
  const backup = Backup.createBackup(sample, {
    scope: "settings",
    includeSecrets: true,
    extensionVersion: "4.4.2",
    now: Date.UTC(2026, 7, 11, 8, 0, 0),
  });
  assert.equal(backup.format, "vk-reposter-backup");
  assert.equal(backup.extensionVersion, "4.4.2");
  assert.equal(backup.data.vk_token, "user-token");
  assert.deepEqual(backup.data.vkr_group_sets_v1[0].groupIds, [123]);
  assert.equal(backup.data.vkr_publish_queue, undefined);
  assert.equal(backup.data.unrelated_key, undefined);
});

test("export can omit every token and secret", () => {
  const backup = Backup.createBackup(sample, { includeSecrets: false });
  assert.equal(backup.data.vk_token, undefined);
  assert.equal(backup.data.vkr_group_tokens, undefined);
  assert.equal(backup.data.vkr_server_api_secret, undefined);
  assert.equal(backup.data.vkr_server_url, "https://example.onrender.com");
});

test("full export carries queues and import can independently exclude secrets", () => {
  const backup = Backup.createBackup(sample, { scope: "full", includeSecrets: true });
  assert.deepEqual(backup.data.vkr_publish_queue, sample.vkr_publish_queue);
  const imported = Backup.prepareImport(backup, { importSecrets: false });
  assert.equal(imported.vk_token, undefined);
  assert.equal(imported.vkr_group_tokens, undefined);
  assert.deepEqual(imported.vkr_publish_queue, sample.vkr_publish_queue);
});

test("import rejects unrelated JSON and ignores non-extension keys", () => {
  assert.throws(() => Backup.validateBackup({ data: {} }), /не резервная копия/i);
  const backup = Backup.createBackup(sample, { scope: "full" });
  backup.data.__proto_pollution = "ignored";
  backup.data.other = "ignored";
  const imported = Backup.prepareImport(backup);
  assert.equal(imported.__proto_pollution, undefined);
  assert.equal(imported.other, undefined);
});

test("popup exposes export and import without an extra browser permission", () => {
  assert.match(popupHtml, /id="export-backup"/);
  assert.match(popupHtml, /id="import-backup"/);
  assert.match(popupHtml, /id="backup-include-secrets" checked/);
  assert.match(popupHtml, /backup-core\.js/);
  assert.match(popupJs, /chrome\.storage\.local\.get\(null\)/);
  assert.match(popupJs, /chrome\.storage\.local\.set\(data\)/);
  assert.match(popupJs, /chrome\.runtime\.reload\(\)/);
});
