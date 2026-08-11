"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  publicPostJob,
  validateScheduledPostInput,
} = require("../src/post-validation.js");

test("scheduled post validation normalizes a future user-authorized batch", () => {
  const value = validateScheduledPostInput({
    idempotencyKey: "pub_42:source_1:batch",
    sourceOwnerId: -100,
    sourcePostId: 55,
    groups: [42, "43", 42],
    groupLabels: { 42: "Первая", 43: "Вторая" },
    mode: "copy",
    text: "Текст",
    publishAt: "2026-08-12T12:00:00.000Z",
    userToken: "u".repeat(40),
    autoCommentText: "Первый комментарий",
    groupIntervalSeconds: 3600,
    commentDelaySeconds: 60,
    commentGroupIntervalSeconds: 30,
    previewImages: ["https://sun.userapi.com/photo.jpg"],
  }, { now: new Date("2026-08-11T12:00:00.000Z") });

  assert.deepEqual(value.groups, [42, 43]);
  assert.equal(value.groupLabels["42"], "Первая");
  assert.equal(value.publishAt.toISOString(), "2026-08-12T12:00:00.000Z");
  assert.equal(value.userToken, "u".repeat(40));
  assert.equal(value.groupIntervalSeconds, 3600);
});

test("scheduled post rejects a past date, empty groups and group token payloads", () => {
  const common = {
    idempotencyKey: "pub_42:source_1:batch",
    sourceOwnerId: -100,
    sourcePostId: 55,
    mode: "copy",
    text: "Текст",
    userToken: "u".repeat(40),
  };
  assert.throws(() => validateScheduledPostInput({ ...common, groups: [], publishAt: "2026-08-10T12:00:00Z" }, { now: new Date("2026-08-11T12:00:00Z") }), /groups/i);
  assert.throws(() => validateScheduledPostInput({ ...common, groups: [42], publishAt: "2026-08-10T12:00:00Z" }, { now: new Date("2026-08-11T12:00:00Z") }), /future/i);
  assert.throws(() => validateScheduledPostInput({ ...common, userToken: "", groupToken: "g".repeat(40), groups: [42], publishAt: "2026-08-12T12:00:00Z" }, { now: new Date("2026-08-11T12:00:00Z") }), /userToken/i);
});

test("public scheduled post never exposes encrypted credentials", () => {
  const value = publicPostJob({
    _id: "post-job",
    idempotencyKey: "safe-key",
    sourceOwnerId: -100,
    sourcePostId: 55,
    groups: [42],
    groupLabels: { 42: "Первая" },
    status: "queued",
    publishAt: new Date("2026-08-12T12:00:00Z"),
    nextRunAt: new Date("2026-08-12T12:00:00Z"),
    results: [],
    tokenCiphertext: "cipher",
    tokenIv: "iv",
    tokenTag: "tag",
  });
  assert.equal(value.id, "post-job");
  for (const field of ["tokenCiphertext", "tokenIv", "tokenTag", "userToken"]) {
    assert.equal(field in value, false);
  }
});
