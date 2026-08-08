"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeMaintenanceScope,
  purgeRecords,
  recordHasErrors,
} = require("../maintenance-core.js");

test("maintenance scopes reject ambiguous destructive requests", () => {
  for (const scope of ["errors", "completed", "all"]) {
    assert.equal(normalizeMaintenanceScope(scope), scope);
  }
  assert.throws(() => normalizeMaintenanceScope("everything"), /unknown/i);
});

test("error cleanup removes terminal failures and partial results only", () => {
  const records = [
    { id: "active", status: "queued", error: "old text" },
    { id: "ok", status: "completed", progress: { fail: 0 } },
    { id: "partial", status: "completed", progress: { fail: 2 } },
    { id: "failed", status: "failed" },
    { id: "cancelled", status: "cancelled", error: "cancelled by user" },
  ];
  const result = purgeRecords(records, "errors");

  assert.deepEqual(result.removed.map((item) => item.id), ["partial", "failed"]);
  assert.deepEqual(result.kept.map((item) => item.id), ["active", "ok", "cancelled"]);
});

test("completed cleanup preserves active and failed records", () => {
  const result = purgeRecords([
    { id: "processing", status: "processing" },
    { id: "ok", status: "done" },
    { id: "failed", status: "failed" },
    { id: "cancelled", status: "cancelled", error: "cancelled" },
  ], "completed");

  assert.deepEqual(result.removed.map((item) => item.id), ["ok", "cancelled"]);
  assert.deepEqual(result.kept.map((item) => item.id), ["processing", "failed"]);
});

test("all-history cleanup never removes active records", () => {
  const result = purgeRecords([
    { id: "queued", status: "queued" },
    { id: "paused", status: "paused" },
    { id: "done", status: "completed" },
    { id: "failed", status: "failed" },
  ], "all");

  assert.deepEqual(result.removed.map((item) => item.id), ["done", "failed"]);
  assert.deepEqual(result.kept.map((item) => item.id), ["queued", "paused"]);
});

test("stored history arrays can be treated as terminal even without a legacy status", () => {
  const result = purgeRecords([
    { id: "legacy-ok", fail: 0 },
    { id: "legacy-error", results: [{ ok: false }] },
  ], "errors", { assumeTerminal: true });

  assert.equal(recordHasErrors(result.removed[0]), true);
  assert.deepEqual(result.removed.map((item) => item.id), ["legacy-error"]);
});
