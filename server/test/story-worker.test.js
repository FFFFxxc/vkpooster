"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStoryWorker } = require("../src/story-worker.js");

function modelFor(job, updates) {
  return {
    findOneAndUpdate() { return { select: async () => job }; },
    async updateOne(filter, update) { updates.push({ filter, update }); return { modifiedCount: 1 }; },
  };
}

test("story worker pauses on CAPTCHA without attempting an upload twice", async () => {
  const updates = [];
  let uploadCalls = 0;
  const captcha = Object.assign(new Error("Captcha needed"), { code: 14 });
  const worker = createStoryWorker({
    StoryModel: modelFor({ _id:"1", lockId:"lock", attempts:1, groupId:42, kind:"photo", mediaId:"m", publishAt:new Date(), fileName:"x.jpg", mimeType:"image/jpeg" }, updates),
    tokenVault: { decrypt: () => "user-secret" }, mediaStore: { read: async () => Buffer.from("x"), remove: async () => {} },
    vkClient: { createStoryUploadServer: async (input) => { assert.equal(input.userToken, "user-secret"); uploadCalls += 1; throw captcha; } },
    logger: { warn() {}, error() {} },
  });
  await worker.runOnce();
  assert.equal(uploadCalls, 1);
  assert.equal(updates.at(-1).update.$set.status, "paused");
});

test("story worker completes its lease and removes media after VK save", async () => {
  const updates = []; const removed = [];
  const worker = createStoryWorker({
    StoryModel: modelFor({ _id:"1", lockId:"lock", attempts:1, groupId:42, kind:"photo", mediaId:"m", publishAt:new Date(), fileName:"x.jpg", mimeType:"image/jpeg" }, updates),
    tokenVault: { decrypt: () => "user-secret" }, mediaStore: { read: async () => Buffer.from("x"), remove: async (id) => removed.push(id) },
    vkClient: { createStoryUploadServer: async (input) => { assert.equal(input.userToken, "user-secret"); return { upload_url:"https://upload" }; }, uploadStoryMedia: async () => ({ response:"r" }), saveCommunityStory: async (input) => { assert.equal(input.userToken, "user-secret"); return { items:[{ id:7 }] }; } },
    logger: { warn() {}, error() {} },
  });
  await worker.runOnce();
  assert.equal(updates[0].update.$set.status, "completed");
  assert.equal(updates[0].filter.lockId, "lock");
  assert.deepEqual(removed, ["m"]);
  assert.equal(updates[1].update.$set.mediaId, null);
  assert.equal(updates[1].update.$set.mediaExpiresAt, null);
});

test("published story remains completed when immediate media cleanup fails", async () => {
  const updates = []; const warnings = [];
  const worker = createStoryWorker({
    StoryModel: modelFor({ _id:"1", lockId:"lock", attempts:1, groupId:42, kind:"photo", mediaId:"m", publishAt:new Date(), fileName:"x.jpg", mimeType:"image/jpeg" }, updates),
    tokenVault: { decrypt: () => "user-secret" },
    mediaStore: { read: async () => Buffer.from("x"), remove: async () => { throw new Error("temporary GridFS error"); } },
    vkClient: { createStoryUploadServer: async () => ({ upload_url:"https://upload" }), uploadStoryMedia: async () => ({ response:"r" }), saveCommunityStory: async () => ({ items:[{ id:7 }] }) },
    logger: { warn(message) { warnings.push(message); }, error() {} },
  });
  await worker.runOnce();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.$set.status, "completed");
  assert.ok(updates[0].update.$set.mediaExpiresAt instanceof Date);
  assert.match(warnings.at(-1), /cleanup was deferred/);
});
