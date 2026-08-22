"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPostService } = require("../src/post-service.js");

function validInput() {
  return {
    idempotencyKey: "pub_42:source_1:batch",
    sourceOwnerId: -100,
    sourcePostId: 55,
    groups: [42, 43],
    groupLabels: { 42: "Первая", 43: "Вторая" },
    mode: "copy",
    text: "Текст",
    publishAt: new Date(Date.now() + 60_000).toISOString(),
    userToken: "u".repeat(40),
    previewImages: [],
  };
}

test("post service encrypts the user token and initializes one batch", async () => {
  let encryptedPlaintext;
  let created;
  const service = createPostService({
    PostModel: {
      async findOne() { return null; },
      async create(input) { created = input; return { _id: "post-job", ...input }; },
    },
    tokenVault: {
      encrypt(value) {
        encryptedPlaintext = value;
        return { tokenCiphertext: "cipher", tokenIv: "iv", tokenTag: "tag" };
      },
    },
  });
  const result = await service.enqueue(validInput());
  assert.equal(encryptedPlaintext, "u".repeat(40));
  assert.equal(created.nextGroupIndex, 0);
  assert.equal(created.status, "queued");
  assert.equal(result.job.id, "post-job");
  assert.equal(JSON.stringify(result).includes("cipher"), false);
});

test("post service can cancel, retry and purge terminal jobs only", async () => {
  const calls = [];
  const service = createPostService({
    PostModel: {
      async findOneAndUpdate(filter, update) {
        calls.push({ filter, update });
        return { _id: "post-job", groups: [42], results: [], publishAt: new Date(), ...update.$set };
      },
      async deleteMany(filter) { calls.push({ filter }); return { deletedCount: 4 }; },
    },
    tokenVault: {},
  });
  assert.equal((await service.cancel("post-job")).status, "cancelled");
  assert.deepEqual(calls[0].filter.status, { $in: ["queued", "processing", "paused", "failed"] });
  assert.equal((await service.retry("post-job")).status, "queued");
  assert.deepEqual(await service.purge({ scope: "all" }), { removedJobs: 4 });
  assert.deepEqual(calls.at(-1).filter, { status: { $in: ["completed", "failed", "cancelled"] } });
});

test("post service edits only mutable fields of a non-processing job", async () => {
  let updateCall;
  const current = {
    _id: "post-job",
    status: "queued",
    groups: [42, 43],
    nextGroupIndex: 0,
    results: [],
    publishAt: new Date(Date.now() + 60_000),
  };
  const service = createPostService({
    PostModel: {
      async findById() { return current; },
      async findOneAndUpdate(filter, update) {
        updateCall = { filter, update };
        return { ...current, ...update.$set };
      },
    },
    tokenVault: {},
    now: () => new Date("2026-08-23T10:00:00.000Z"),
  });

  const publishAt = "2026-08-23T12:00:00.000Z";
  const job = await service.update("post-job", {
    text: "Новый текст",
    autoCommentText: "Новый комментарий",
    mode: "repost",
    publishAt,
  });
  assert.deepEqual(updateCall.filter, { _id: "post-job", status: { $in: ["queued", "paused", "failed"] } });
  assert.equal(updateCall.update.$set.text, "Новый текст");
  assert.equal(updateCall.update.$set.autoCommentText, "Новый комментарий");
  assert.equal(updateCall.update.$set.mode, "repost");
  assert.equal(updateCall.update.$set.publishAt.toISOString(), publishAt);
  assert.equal(updateCall.update.$set.nextRunAt.toISOString(), publishAt);
  assert.equal(job.text, "Новый текст");
});

test("post service cancels one pending community without cancelling the batch", async () => {
  let updateCall;
  const current = {
    _id: "post-job",
    status: "queued",
    groups: [42, 43, 44],
    nextGroupIndex: 1,
    cancelledGroupIds: [],
    results: [{ gid: 42, ok: true, postId: 7 }],
    publishAt: new Date(),
  };
  const service = createPostService({
    PostModel: {
      async findById() { return current; },
      async findOneAndUpdate(filter, update) {
        updateCall = { filter, update };
        return { ...current, ...update.$set };
      },
    },
    tokenVault: {},
  });

  const job = await service.cancelGroup("post-job", 43);
  assert.deepEqual(updateCall.update.$addToSet, { cancelledGroupIds: 43 });
  assert.deepEqual(job.cancelledGroupIds, [43]);
  await assert.rejects(() => service.cancelGroup("post-job", 42), /already processed/i);
});
