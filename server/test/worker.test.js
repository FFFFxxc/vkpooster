"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_COMMENT_ATTEMPTS,
  commentRetryDelayMs,
  createCommentWorker,
} = require("../src/worker.js");

function fakeModelFor(job) {
  const updates = [];
  return {
    updates,
    findOneAndUpdate() {
      return {
        select: async () => job,
      };
    },
    async updateOne(filter, update) {
      updates.push({ filter, update });
      return { modifiedCount: 1 };
    },
  };
}

test("worker pauses a job on CAPTCHA instead of retrying it", async () => {
  const job = {
    _id: "job-id",
    groupId: 42,
    postId: 10,
    commentText: "comment",
    commentAt: new Date(),
    attempts: 1,
    lockId: "lease-one",
    idempotencyKey: "comment-job-one",
  };
  const CommentModel = fakeModelFor(job);
  const worker = createCommentWorker({
    CommentModel,
    tokenVault: { decrypt: () => "group-token" },
    vkClient: {
      async createGroupComment() {
        const error = new Error("Captcha needed");
        error.code = 14;
        error.vkError = { error_code: 14 };
        throw error;
      },
    },
    logger: { warn() {}, error() {} },
  });

  await worker.runOnce();
  assert.equal(CommentModel.updates.length, 1);
  assert.equal(CommentModel.updates[0].update.$set.status, "paused");
  assert.equal(CommentModel.updates[0].update.$set.lastErrorCode, 14);
  assert.equal(CommentModel.updates[0].filter.lockId, "lease-one");
  assert.equal(CommentModel.updates[0].update.$set.lockId, null);
});

test("worker retries a transient failure with bounded backoff", async () => {
  const job = {
    _id: "job-id",
    groupId: 42,
    postId: 10,
    commentText: "comment",
    commentAt: new Date(),
    attempts: 1,
    lockId: "lease-two",
    idempotencyKey: "comment-job-two",
  };
  const CommentModel = fakeModelFor(job);
  const worker = createCommentWorker({
    CommentModel,
    tokenVault: { decrypt: () => "group-token" },
    vkClient: {
      async createGroupComment() {
        const error = new Error("Internal VK error");
        error.code = 10;
        error.vkError = { error_code: 10 };
        throw error;
      },
    },
    logger: { warn() {}, error() {} },
  });

  await worker.runOnce();
  assert.equal(CommentModel.updates[0].update.$set.status, "queued");
  assert.ok(CommentModel.updates[0].update.$set.commentAt > new Date());
  assert.equal(CommentModel.updates[0].filter.lockId, "lease-two");
  assert.equal(commentRetryDelayMs(1), 2 * 60_000);
  assert.equal(commentRetryDelayMs(5), 30 * 60_000);
});

test("worker gives a transient VK error six attempts before marking it failed", async () => {
  const job = {
    _id: "job-id",
    groupId: 42,
    postId: 10,
    commentText: "comment",
    commentAt: new Date(),
    attempts: MAX_COMMENT_ATTEMPTS,
    lockId: "lease-final",
    idempotencyKey: "comment-job-final",
  };
  const CommentModel = fakeModelFor(job);
  const worker = createCommentWorker({
    CommentModel,
    tokenVault: { decrypt: () => "group-token" },
    vkClient: {
      async createGroupComment() {
        const error = new Error("Internal VK error");
        error.code = 10;
        error.vkError = { error_code: 10 };
        throw error;
      },
    },
    logger: { warn() {}, error() {} },
  });

  await worker.runOnce();
  assert.equal(CommentModel.updates[0].update.$set.status, "failed");
});

test("worker uses VK guid and completes only its own lease", async () => {
  const job = {
    _id: "job-id",
    groupId: 42,
    postId: 10,
    commentText: "comment",
    commentAt: new Date(),
    attempts: 1,
    lockId: "lease-three",
    idempotencyKey: "comment-job-three",
  };
  const CommentModel = fakeModelFor(job);
  let sent;
  const worker = createCommentWorker({
    CommentModel,
    tokenVault: { decrypt: () => "group-token" },
    vkClient: {
      async createGroupComment(input) {
        sent = input;
        return { comment_id: 99 };
      },
    },
    logger: { warn() {}, error() {} },
  });

  await worker.runOnce();
  assert.equal(sent.guid, "comment-job-three");
  assert.equal(CommentModel.updates[0].filter.lockId, "lease-three");
  assert.equal(CommentModel.updates[0].update.$set.status, "completed");
  assert.equal(CommentModel.updates[0].update.$set.lockId, null);
});
