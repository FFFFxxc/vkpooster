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
    async purge() {
      return { removedJobs: 3 };
    },
    async retry(id) {
      return { id, idempotencyKey: "same-safe-key", status: "queued" };
    },
  };
  const storyService = {
    async createDraft() { return { created: true, job: { id: "story-id", groupId: 42, status: "uploading" } }; },
    async attachMedia(_id, media) { return { id: "story-id", groupId: 42, status: "queued", byteLength: media.buffer.length }; },
    async list() { return []; },
    async cancel() { return { removed: false, job: null }; },
    async reschedule() { throw new Error("Story job cannot be rescheduled"); },
    async retry() { throw new Error("Story job cannot be retried"); },
    async purge() { return { removedJobs: 2, removedMedia: 1, retainedJobs: 0, hasMore: false }; },
  };
  const postService = {
    async enqueue() { return { created: true, job: { id: "post-job", status: "queued", groups: [42] } }; },
    async list() { return [{ id: "post-job", status: "queued", groups: [42] }]; },
    async cancel(id) { return { id, status: "cancelled", groups: [42] }; },
    async retry(id) { return { id, status: "queued", groups: [42] }; },
    async purge() { return { removedJobs: 5 }; },
  };
  const app = createApp({
    config: { apiSecret: "s".repeat(40), storyMaxBytes: 25 * 1024 * 1024 },
    commentService,
    postService,
    storyService,
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

test("story draft and raw media responses expose no credential fields", async () => {
  await withServer(async (baseUrl) => {
    const headers = { Authorization: `Bearer ${"s".repeat(40)}` };
    const draft = await fetch(`${baseUrl}/api/scheduled-stories`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ groupToken: "must-not-return", previewDataUrl: "x".repeat(100_000) }),
    });
    assert.equal(draft.status, 201);
    assert.doesNotMatch(await draft.text(), /token|cipher|secret/i);
    const media = await fetch(`${baseUrl}/api/scheduled-stories/story-id/media`, {
      method: "PUT", headers: { ...headers, "Content-Type": "image/jpeg", "X-File-Name": "story.jpg" }, body: Buffer.from([1, 2, 3]),
    });
    assert.equal(media.status, 200);
    assert.equal((await media.json()).job.byteLength, 3);
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

test("scheduled post endpoints are authenticated and never echo the user token", async () => {
  await withServer(async (baseUrl) => {
    const headers = {
      Authorization: `Bearer ${"s".repeat(40)}`,
      "Content-Type": "application/json",
    };
    const created = await fetch(`${baseUrl}/api/scheduled-posts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userToken: "must-not-return" }),
    });
    assert.equal(created.status, 201);
    assert.doesNotMatch(await created.text(), /token|cipher|secret/i);

    const listed = await fetch(`${baseUrl}/api/scheduled-posts?limit=100`, { headers });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).jobs[0].id, "post-job");

    const cancelled = await fetch(`${baseUrl}/api/scheduled-posts/post-job`, { method: "DELETE", headers });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).job.status, "cancelled");

    const retried = await fetch(`${baseUrl}/api/scheduled-posts/post-job/retry`, { method: "POST", headers });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).job.status, "queued");
  });
});

test("authenticated comment retry returns the requeued public job", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/scheduled-comments/comment-id/retry`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${"s".repeat(40)}` },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      job: {
        id: "comment-id",
        idempotencyKey: "same-safe-key",
        status: "queued",
      },
    });
  });
});

test("authenticated maintenance endpoints return actual MongoDB cleanup counts", async () => {
  await withServer(async (baseUrl) => {
    const headers = { Authorization: `Bearer ${"s".repeat(40)}` };
    const comments = await fetch(`${baseUrl}/api/scheduled-comments?scope=errors`, { method: "DELETE", headers });
    assert.equal(comments.status, 200);
    assert.deepEqual(await comments.json(), { ok: true, removedJobs: 3 });

    const stories = await fetch(`${baseUrl}/api/scheduled-stories?scope=all`, { method: "DELETE", headers });
    assert.equal(stories.status, 200);
    assert.deepEqual(await stories.json(), {
      ok: true,
      removedJobs: 2,
      removedMedia: 1,
      retainedJobs: 0,
      hasMore: false,
    });

    const posts = await fetch(`${baseUrl}/api/scheduled-posts?scope=all`, { method: "DELETE", headers });
    assert.equal(posts.status, 200);
    assert.deepEqual(await posts.json(), { ok: true, removedJobs: 5 });
  });
});
