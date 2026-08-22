"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCommentService } = require("../src/comment-service.js");

test("comment expiration stays 30 days beyond a future schedule", async () => {
  const scheduledAt = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
  let created;
  const CommentModel = {
    async findOne() {
      return null;
    },
    async create(input) {
      created = input;
      return { _id: "job-id", ...input };
    },
  };
  const service = createCommentService({
    CommentModel,
    tokenVault: {
      encrypt() {
        return {
          tokenCiphertext: "cipher",
          tokenIv: "iv",
          tokenTag: "tag",
        };
      },
    },
  });

  await service.enqueue({
    idempotencyKey: "future-comment-job",
    groupId: 42,
    postId: 10,
    commentText: "comment",
    commentAt: scheduledAt,
    userToken: "x".repeat(40),
  });

  const retentionMs = created.expiresAt.getTime() - scheduledAt.getTime();
  assert.equal(retentionMs, 30 * 24 * 60 * 60 * 1000);
});

test("comment maintenance deletes terminal scopes but never queued or paused jobs", async () => {
  let filter;
  const service = createCommentService({
    CommentModel: {
      async deleteMany(value) { filter = value; return { deletedCount: 7 }; },
    },
    tokenVault: {},
  });

  assert.deepEqual(await service.purge({ scope: "errors" }), { removedJobs: 7 });
  assert.deepEqual(filter, { status: { $in: ["failed"] } });
  await service.purge({ scope: "all" });
  assert.deepEqual(filter, { status: { $in: ["completed", "failed"] } });
  await assert.rejects(() => service.purge({ scope: "queued" }), /scope/i);
});

test("manual comment retry keeps the idempotency key and clears the failed attempt", async () => {
  let filter;
  let update;
  const service = createCommentService({
    CommentModel: {
      async findOneAndUpdate(nextFilter, nextUpdate) {
        filter = nextFilter;
        update = nextUpdate;
        return {
          _id: "job-id",
          idempotencyKey: "same-guid-forever",
          groupId: 42,
          postId: 10,
          commentText: "comment",
          commentAt: nextUpdate.$set.commentAt,
          status: nextUpdate.$set.status,
          attempts: nextUpdate.$set.attempts,
        };
      },
    },
    tokenVault: {},
  });

  const job = await service.retry("job-id");
  assert.deepEqual(filter, {
    _id: "job-id",
    status: { $in: ["failed", "paused"] },
  });
  assert.equal(update.$set.status, "queued");
  assert.equal(update.$set.attempts, 0);
  assert.equal(update.$set.lastError, null);
  assert.equal(job.idempotencyKey, "same-guid-forever");
});

test("queued comment text and time can be edited", async () => {
  let call;
  const service = createCommentService({
    CommentModel: {
      async findOneAndUpdate(filter, update) {
        call = { filter, update };
        return {
          _id: "job-id", groupId: 42, postId: 10,
          commentText: update.$set.commentText,
          commentAt: update.$set.commentAt,
          status: update.$set.status,
        };
      },
    },
    tokenVault: {},
    now: () => new Date("2026-08-23T10:00:00.000Z"),
  });

  const job = await service.update("job-id", {
    commentText: "Исправленный комментарий",
    commentAt: "2026-08-23T11:00:00.000Z",
  });
  assert.deepEqual(call.filter.status, { $in: ["queued", "paused", "failed"] });
  assert.equal(call.update.$set.commentText, "Исправленный комментарий");
  assert.equal(call.update.$set.commentAt.toISOString(), "2026-08-23T11:00:00.000Z");
  assert.equal(call.update.$set.status, "queued");
  assert.equal(job.commentText, "Исправленный комментарий");
});
