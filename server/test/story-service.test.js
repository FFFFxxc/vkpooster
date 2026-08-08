"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createStoryService } = require("../src/story-service.js");

function queryResult(value) {
  return { select: async () => value };
}

function listQuery(value) {
  return { select: () => ({ limit: async () => value }) };
}

test("story maintenance removes GridFS media before deleting terminal documents", async () => {
  const candidates = [
    { _id: "failed-with-media", status: "failed", mediaId: "media-1" },
    { _id: "failed-without-media", status: "failed", mediaId: null },
  ];
  const claimed = [];
  const deleted = [];
  const StoryModel = {
    find(filter) {
      assert.deepEqual(filter.status.$in, ["failed"]);
      return listQuery(candidates);
    },
    findOneAndUpdate(filter) {
      const job = candidates.find((item) => item._id === filter._id);
      claimed.push(filter._id);
      return queryResult(job);
    },
    async deleteOne(filter) { deleted.push(filter._id); return { deletedCount: 1 }; },
    async updateOne() { throw new Error("should not reset a successful claim"); },
  };
  const removedMedia = [];
  const service = createStoryService({
    StoryModel,
    tokenVault: {},
    mediaStore: { async remove(id) { removedMedia.push(id); return true; } },
    maxBytes: 1024,
  });

  const result = await service.purge({ scope: "errors" });
  assert.deepEqual(result, {
    removedJobs: 2,
    removedMedia: 1,
    retainedJobs: 0,
    hasMore: false,
  });
  assert.deepEqual(claimed, ["failed-with-media", "failed-without-media"]);
  assert.deepEqual(removedMedia, ["media-1"]);
  assert.deepEqual(deleted, ["failed-with-media", "failed-without-media"]);
});

test("story maintenance retains the document when GridFS deletion fails", async () => {
  const candidate = { _id: "failed", status: "failed", mediaId: "media-broken" };
  const resets = [];
  let deleted = false;
  const service = createStoryService({
    StoryModel: {
      find() { return listQuery([candidate]); },
      findOneAndUpdate() { return queryResult(candidate); },
      async deleteOne() { deleted = true; return { deletedCount: 1 }; },
      async updateOne(filter, update) { resets.push({ filter, update }); },
    },
    tokenVault: {},
    mediaStore: { async remove() { throw new Error("GridFS unavailable"); } },
    maxBytes: 1024,
  });

  const result = await service.purge({ scope: "all" });
  assert.equal(result.removedJobs, 0);
  assert.equal(result.retainedJobs, 1);
  assert.equal(deleted, false);
  assert.equal(resets.length, 1);
  assert.deepEqual(resets[0].update, { $set: { maintenancePending: false } });
});
