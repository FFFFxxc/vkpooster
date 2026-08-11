"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  publicCommentJob,
  validateScheduledCommentInput,
} = require("../src/validation.js");

test("scheduled comment validation normalizes a valid payload", () => {
  const value = validateScheduledCommentInput({
    idempotencyKey: "pub_1:42:10:comment",
    groupId: "42",
    postId: "10",
    commentText: "Первый комментарий",
    commentAt: "2026-08-05T12:00:00.000Z",
    userToken: "x".repeat(40),
  });

  assert.equal(value.groupId, 42);
  assert.equal(value.postId, 10);
  assert.equal(value.commentAt.toISOString(), "2026-08-05T12:00:00.000Z");
  assert.equal(value.userToken, "x".repeat(40));
  assert.equal("groupToken" in value, false);
});

test("scheduled comment validation rejects bad IDs and oversized text", () => {
  assert.throws(
    () =>
      validateScheduledCommentInput({
        idempotencyKey: "job-key-123",
        groupId: -1,
        postId: 0,
        commentText: "x".repeat(4097),
        commentAt: Date.now(),
        userToken: "x".repeat(40),
      }),
    /groupId/i,
  );
});

test("public job serializer never exposes encrypted credential fields", () => {
  const serialized = publicCommentJob({
    _id: "mongo-id",
    idempotencyKey: "job-key",
    groupId: 42,
    postId: 10,
    commentText: "text",
    commentAt: new Date("2026-08-05T12:00:00.000Z"),
    status: "queued",
    attempts: 0,
    tokenCiphertext: "ciphertext",
    tokenIv: "iv",
    tokenTag: "tag",
    toObject() {
      return { ...this, toObject: undefined };
    },
  });

  assert.equal(serialized.id, "mongo-id");
  assert.equal("tokenCiphertext" in serialized, false);
  assert.equal("tokenIv" in serialized, false);
  assert.equal("tokenTag" in serialized, false);
});
