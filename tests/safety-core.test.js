"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildUploadedPhotoAttachment,
  buildReusableAttachments,
  classifyVkError,
  createSerialScheduler,
  hasPostPhotos,
  largestPhotoUrl,
  isUploadedPhotoAttachment,
  nextRunnablePublishJobIndex,
  normalizeQueueJobs,
  selectCredential,
  shouldDeferPhotoPublish,
} = require("../safety-core.js");

test("classifyVkError pauses on VK protection and rate-limit errors", () => {
  for (const code of [6, 9, 14, 17, 24, 25, 29, 1105, 3300, 3305, 11500]) {
    assert.equal(classifyVkError({ error_code: code }).action, "pause");
  }
});

test("classifyVkError fails invalid credentials without retrying", () => {
  assert.deepEqual(classifyVkError({ error_code: 5 }), {
    action: "fail",
    code: 5,
    reason: "auth",
  });
});

test("classifyVkError retries only transient transport and VK server errors", () => {
  assert.equal(classifyVkError({ transport: true }).action, "retry");
  assert.equal(classifyVkError({ error_code: 10 }).action, "retry");
  assert.equal(classifyVkError({ error_code: 100 }).action, "fail");
});

test("selectCredential always uses the local user token for copy posting", () => {
  const selected = selectCredential({
    groupId: 42,
    operation: "copy",
    groupTokens: { "42": "group-secret" },
    userToken: "user-secret",
  });

  assert.deepEqual(selected, {
    kind: "user",
    token: "user-secret",
    groupId: 42,
  });
});

test("selectCredential requires a local user token for a repost", () => {
  assert.throws(
    () =>
      selectCredential({
        groupId: 42,
        operation: "repost",
        groupTokens: { "42": "group-secret" },
        userToken: "",
      }),
    /локальный пользовательский токен/i,
  );
});

test("selectCredential always uses a local user token for photo uploads", () => {
  assert.deepEqual(
    selectCredential({
      groupId: 42,
      operation: "upload",
      groupTokens: { "42": "group-secret" },
      userToken: "user-secret",
    }),
    { kind: "user", token: "user-secret", groupId: 42 },
  );
  assert.throws(
    () => selectCredential({
      groupId: 42,
      operation: "upload",
      groupTokens: { "42": "group-secret" },
      userToken: "",
    }),
    /VK не разрешает загружать фотографии токеном сообщества/i,
  );
});

test("selectCredential never uses a community token for wall analytics", () => {
  assert.deepEqual(
    selectCredential({
      groupId: 42,
      operation: "analytics",
      groupTokens: { "42": "group-secret" },
      userToken: "user-secret",
    }),
    { kind: "user", token: "user-secret", groupId: 42 },
  );
  assert.throws(
    () => selectCredential({
      groupId: 42,
      operation: "analytics",
      groupTokens: { "42": "group-secret" },
      userToken: "",
    }),
    /аналитики нужен локальный пользовательский токен/i,
  );
});

test("selectCredential never falls back to another community token", () => {
  assert.throws(
    () =>
      selectCredential({
        groupId: 42,
        operation: "copy",
        groupTokens: { "43": "wrong-group-secret" },
        userToken: "",
      }),
    /пользовательский токен/i,
  );
});

test("selectCredential uses one user token without a community token", () => {
  assert.deepEqual(
    selectCredential({
      groupId: 42,
      operation: "copy",
      groupTokens: {},
      userToken: "user-secret",
    }),
    { kind: "user", token: "user-secret", groupId: 42 },
  );
});

test("selectCredential prefers the user token for comments and keeps group fallback", () => {
  assert.deepEqual(
    selectCredential({
      groupId: 42,
      operation: "comment",
      groupTokens: { "42": "group-secret" },
      userToken: "user-secret",
    }),
    { kind: "user", token: "user-secret", groupId: 42 },
  );
  assert.deepEqual(
    selectCredential({
      groupId: 42,
      operation: "comment",
      groupTokens: { "42": "group-secret" },
      userToken: "",
    }),
    { kind: "group", token: "group-secret", groupId: 42 },
  );
});

test("buildReusableAttachments preserves supported IDs and access keys", () => {
  const attachments = buildReusableAttachments([
    { type: "photo", owner_id: -1, id: 2, access_key: "abc" },
    { type: "video", ownerId: 3, id: 4 },
    { type: "doc", doc: { owner_id: 5, id: 6, access_key: "def" } },
    { type: "link", url: "https://example.com" },
  ]);

  assert.deepEqual(attachments, [
    "photo-1_2_abc",
    "video3_4",
    "doc5_6_def",
  ]);
});

test("largestPhotoUrl selects the actual largest image instead of relying on VK order", () => {
  assert.equal(
    largestPhotoUrl({
      sizes: [
        { width: 1280, height: 720, url: "https://large.example/photo" },
        { width: 100, height: 100, url: "https://small.example/photo" },
        { width: 640, height: 480, url: "https://medium.example/photo" },
      ],
    }),
    "https://large.example/photo",
  );
  assert.equal(
    largestPhotoUrl({ orig_photo: { url: "https://fallback.example/photo" } }),
    "https://fallback.example/photo",
  );
});

test("copied photo attachment uses the fresh saveWallPhoto owner returned by VK", () => {
  assert.equal(
    buildUploadedPhotoAttachment(
      { owner_id: -42, id: 99, access_key: "safe" },
      { owner_id: -7, id: 80 },
    ),
    "photo-42_99_safe",
  );
  assert.equal(
    buildUploadedPhotoAttachment(
      { owner_id: 123, id: 99 },
      { owner_id: -7, id: 80 },
    ),
    "photo123_99",
  );
  assert.throws(
    () => buildUploadedPhotoAttachment(
      { owner_id: -7, id: 80 },
      { owner_id: -7, id: 80 },
    ),
    /исходную фотографию/i,
  );
  assert.equal(isUploadedPhotoAttachment("photo123_99_safe-key"), true);
  assert.equal(isUploadedPhotoAttachment("photo<script>_99"), false);
});

test("normalizeQueueJobs recovers stale processing jobs only", () => {
  const now = Date.parse("2026-08-05T10:00:00Z");
  const jobs = normalizeQueueJobs(
    [
      {
        id: "stale",
        status: "processing",
        processingStartedAt: "2026-08-05T09:50:00Z",
      },
      {
        id: "fresh",
        status: "processing",
        processingStartedAt: "2026-08-05T09:59:45Z",
      },
      { id: "done", status: "completed" },
    ],
    { now, staleAfterMs: 60_000 },
  );

  assert.equal(jobs[0].status, "queued");
  assert.equal(jobs[0].processingStartedAt, undefined);
  assert.equal(jobs[1].status, "processing");
  assert.equal(jobs[2].status, "completed");
});

test("scheduled photo copies wait locally while other queued jobs remain runnable", () => {
  const now = Date.parse("2026-08-09T10:00:00Z");
  const photoPost = {
    attachments: [{ type: "photo", photo: { owner_id: -1, id: 2 } }],
  };
  assert.equal(hasPostPhotos(photoPost), true);
  assert.equal(
    shouldDeferPhotoPublish({
      post: photoPost,
      mode: "copy",
      pubDate: now + 60_000,
    }),
    true,
  );
  assert.equal(
    shouldDeferPhotoPublish({ post: photoPost, mode: "repost", pubDate: now }),
    false,
  );

  const jobs = [
    {
      id: "future-photo",
      status: "queued",
      deferMediaUntilPublish: true,
      pubDate: now + 60_000,
    },
    { id: "text-now", status: "queued", deferMediaUntilPublish: false },
  ];
  assert.equal(nextRunnablePublishJobIndex(jobs, now), 1);
  assert.equal(nextRunnablePublishJobIndex(jobs, now + 60_000), 0);
});

test("createSerialScheduler never overlaps work and enforces the interval", async () => {
  let clock = 0;
  let active = 0;
  let maxActive = 0;
  const starts = [];
  const sleep = async (milliseconds) => {
    clock += milliseconds;
  };
  const scheduler = createSerialScheduler({
    minIntervalMs: 1000,
    now: () => clock,
    sleep,
  });

  const work = (name) =>
    scheduler.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push([name, clock]);
      await Promise.resolve();
      active -= 1;
      return name;
    });

  assert.deepEqual(await Promise.all([work("a"), work("b"), work("c")]), [
    "a",
    "b",
    "c",
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(starts, [
    ["a", 0],
    ["b", 1000],
    ["c", 2000],
  ]);
});
