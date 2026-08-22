"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPostWorker } = require("../src/post-worker.js");

function modelFor(job) {
  const updates = [];
  return {
    updates,
    findOneAndUpdate() { return { select: async () => job }; },
    async updateOne(filter, update) { updates.push({ filter, update }); return { modifiedCount: 1 }; },
  };
}

test("post worker publishes one community per lease and waits before the next", async () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const model = modelFor({
    _id: "job", lockId: "lease", attempts: 1, idempotencyKey: "post-job-one",
    sourceOwnerId: -100, sourcePostId: 55, groups: [42, 43], groupLabels: { 42: "Первая", 43: "Вторая" },
    nextGroupIndex: 0, results: [], mode: "copy", text: "Текст", publishAt: now,
    autoCommentText: "Комментарий", groupIntervalSeconds: 3600, commentDelaySeconds: 60, commentGroupIntervalSeconds: 30,
  });
  const publishes = [];
  const comments = [];
  const worker = createPostWorker({
    PostModel: model,
    tokenVault: { decrypt: () => "user-token" },
    vkClient: { async publishCopiedPost(input) { publishes.push(input); return { postId: 77 }; } },
    commentService: { async enqueue(input) { comments.push(input); return { created: true }; } },
    now: () => new Date(now),
    minGroupIntervalMs: 15_000,
    logger: { warn() {}, error() {} },
  });

  await worker.runOnce();
  assert.equal(publishes.length, 1);
  assert.equal(publishes[0].targetGroupId, 42);
  assert.equal(publishes[0].userToken, "user-token");
  assert.equal(comments[0].userToken, "user-token");
  const update = model.updates[0].update.$set;
  assert.equal(update.status, "queued");
  assert.equal(update.nextGroupIndex, 1);
  assert.equal(update.nextRunAt.toISOString(), "2026-08-11T13:00:00.000Z");
  assert.equal(update.results[0].postId, 77);
});

test("post worker pauses the full batch when VK requests verification", async () => {
  const model = modelFor({
    _id: "job", lockId: "lease", attempts: 1, idempotencyKey: "post-job-two",
    sourceOwnerId: -100, sourcePostId: 55, groups: [42], nextGroupIndex: 0,
    results: [], mode: "repost", text: "", publishAt: new Date(),
  });
  const error = Object.assign(new Error("Captcha needed"), { code: 14, vkError: { error_code: 14 } });
  const worker = createPostWorker({
    PostModel: model,
    tokenVault: { decrypt: () => "user-token" },
    vkClient: { async repostToGroup() { throw error; } },
    commentService: { async enqueue() {} },
    logger: { warn() {}, error() {} },
  });
  await worker.runOnce();
  assert.equal(model.updates[0].update.$set.status, "paused");
  assert.equal(model.updates[0].update.$set.lastErrorCode, 14);
});

test("post worker records a cancelled target and never calls VK for it", async () => {
  const now = new Date("2026-08-23T12:00:00.000Z");
  const model = modelFor({
    _id: "job", lockId: "lease", attempts: 1, idempotencyKey: "post-job-cancelled-target",
    sourceOwnerId: -100, sourcePostId: 55, groups: [42, 43], cancelledGroupIds: [42],
    nextGroupIndex: 0, results: [], mode: "copy", text: "Текст", publishAt: now,
    groupIntervalSeconds: 15,
  });
  let calls = 0;
  const worker = createPostWorker({
    PostModel: model,
    tokenVault: { decrypt: () => "user-token" },
    vkClient: { async publishCopiedPost() { calls += 1; return { postId: 77 }; } },
    commentService: { async enqueue() {} },
    now: () => new Date(now),
    logger: { warn() {}, error() {} },
  });

  await worker.runOnce();
  assert.equal(calls, 0);
  const update = model.updates[0].update.$set;
  assert.equal(update.nextGroupIndex, 1);
  assert.equal(update.results[0].gid, 42);
  assert.equal(update.results[0].cancelled, true);
  assert.equal(update.status, "queued");
});
