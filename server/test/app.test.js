"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../src/app.js");

async function withServer(callback) {
  const commentService = {
    async enqueue() {
      return {
        created: true,
        job: {
          id: "safe-id",
          idempotencyKey: "safe-key",
          status: "queued",
        },
      };
    },
    async list() {
      return [];
    },
    async remove() {
      return false;
    },
  };
  const app = createApp({
    config: { apiSecret: "s".repeat(40) },
    commentService,
    databaseReady: () => true,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health is public but API status requires bearer authentication", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const denied = await fetch(`${baseUrl}/api/status`);
    assert.equal(denied.status, 401);

    const accepted = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${"s".repeat(40)}` },
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).ok, true);
  });
});

test("scheduled comment response contains no credential fields", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/scheduled-comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"s".repeat(40)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ any: "payload" }),
    });
    const text = await response.text();
    assert.equal(response.status, 201);
    assert.doesNotMatch(text, /token|cipher|secret/i);
  });
});
