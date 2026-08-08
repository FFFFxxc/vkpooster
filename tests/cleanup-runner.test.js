"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { runCleanup } = require("../cleanup-runner.js");

test("runner deletes one item at a time and reports progress", async () => {
  const calls = [];
  const progress = [];
  const result = await runCleanup({
    items: [{ id: 1 }, { id: 2 }],
    deleteItem: async (item) => calls.push(item.id),
    classifyError: () => ({ action: "fail" }),
    shouldStop: () => false,
    sleep: async () => {},
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.status, "completed");
  assert.deepEqual(
    progress.map((event) => event.completed),
    [1, 2],
  );
});

test("runner pauses without touching later items on VK protection", async () => {
  const calls = [];
  const protection = Object.assign(new Error("Captcha needed"), { code: 14 });
  const result = await runCleanup({
    items: [{ id: 1 }, { id: 2 }],
    deleteItem: async (item) => {
      calls.push(item.id);
      throw protection;
    },
    classifyError: () => ({ action: "pause", code: 14 }),
    shouldStop: () => false,
    sleep: async () => {},
    onProgress: () => {},
  });

  assert.deepEqual(calls, [1]);
  assert.equal(result.status, "paused");
  assert.deepEqual(result.pausedError, {
    code: 14,
    message: "Captcha needed",
  });
});

test("runner retries only twice and records a safe item error", async () => {
  const delays = [];
  let attempts = 0;
  const result = await runCleanup({
    items: [{ id: 1 }],
    deleteItem: async () => {
      attempts += 1;
      const error = new Error("Temporary VK error");
      error.code = 10;
      throw error;
    },
    classifyError: () => ({ action: "retry", code: 10 }),
    shouldStop: () => false,
    sleep: async (milliseconds) => delays.push(milliseconds),
    onProgress: () => {},
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5_000, 15_000]);
  assert.equal(result.status, "completed");
  assert.equal(result.skipped, 1);
  assert.equal(result.errors.length, 1);
  assert.doesNotMatch(result.errors[0].message, /token/i);
});

test("runner stops before a later deletion when cancellation is requested", async () => {
  let stop = false;
  const calls = [];
  const result = await runCleanup({
    items: [{ id: 1 }, { id: 2 }],
    deleteItem: async (item) => {
      calls.push(item.id);
      stop = true;
    },
    classifyError: () => ({ action: "fail" }),
    shouldStop: () => stop,
    sleep: async () => {},
    onProgress: () => {},
  });

  assert.deepEqual(calls, [1]);
  assert.equal(result.status, "cancelled");
  assert.equal(result.completed, 1);
});
