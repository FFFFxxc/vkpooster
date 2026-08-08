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
    groupToken: "x".repeat(40),
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
