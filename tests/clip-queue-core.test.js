"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createClipJobs,
  nextRunnableJob,
  toClipHistory,
  transitionClipJob,
} = require("../clip-queue-core.js");

test("jobs are flattened by file then group and only one can become active", () => {
  const jobs = createClipJobs({
    sourceId: "source-a",
    files: [{ id: "file-1", name: "a.mp4", size: 10, type: "video/mp4" }],
    groups: [{ id: 42, name: "Club" }, { id: 43, name: "Club 2" }],
    defaults: { description: "text", wallPost: true },
    now: 100,
    createId: () => `job-${Math.random()}`,
  });
  assert.deepEqual(jobs.map((job) => job.groupId), [42, 43]);
  assert.equal(nextRunnableJob(jobs).id, jobs[0].id);
  const opening = transitionClipJob(jobs[0], { type: "tab_opened", tabId: 10 }, 101);
  assert.equal(opening.status, "opening_tab");
  assert.equal(nextRunnableJob([opening, jobs[1]]), null);
});

test("source disconnection pauses unfinished jobs and history contains no file data", () => {
  const paused = transitionClipJob({
    id: "j", status: "uploading", fileId: "file", sourceId: "s", fileName: "x.mp4",
  }, { type: "source_disconnected" }, 200);
  assert.equal(paused.status, "paused");
  assert.match(paused.error, /страница загрузчика/i);
  const history = toClipHistory({ ...paused, groupToken: "must-not-leak", fileData: "must-not-leak" });
  assert.equal("groupToken" in history, false);
  assert.equal("fileData" in history, false);
});

test("invalid transitions throw instead of starting a parallel job", () => {
  assert.throws(() => transitionClipJob({ id: "j", status: "queued" }, { type: "complete" }, 1), /cannot/i);
});
