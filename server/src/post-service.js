"use strict";

const { publicPostJob, validateScheduledPostInput } = require("./post-validation.js");

function postPurgeStatuses(scope) {
  if (scope === "errors") return ["failed"];
  if (scope === "completed") return ["completed", "cancelled"];
  if (scope === "all") return ["completed", "failed", "cancelled"];
  throw new Error("scope must be errors, completed, or all");
}

function createPostService({ PostModel, tokenVault, now = () => new Date() }) {
  return Object.freeze({
    async enqueue(rawInput) {
      const input = validateScheduledPostInput(rawInput, { now: now() });
      const existing = await PostModel.findOne({ idempotencyKey: input.idempotencyKey });
      if (existing) return { created: false, job: publicPostJob(existing) };
      const encryptedToken = tokenVault.encrypt(input.userToken);
      const retentionBase = Math.max(Date.now(), input.publishAt.getTime());
      try {
        const document = await PostModel.create({
          idempotencyKey: input.idempotencyKey,
          sourceOwnerId: input.sourceOwnerId,
          sourcePostId: input.sourcePostId,
          sourceUrl: input.sourceUrl,
          groups: input.groups,
          groupLabels: input.groupLabels,
          mode: input.mode,
          text: input.text,
          label: input.label,
          publishAt: input.publishAt,
          nextRunAt: input.publishAt,
          nextGroupIndex: 0,
          previewImages: input.previewImages,
         autoCommentText: input.autoCommentText,
          groupIntervalSeconds: input.groupIntervalSeconds,
         commentDelaySeconds: input.commentDelaySeconds,
          commentGroupIntervalSeconds: input.commentGroupIntervalSeconds,
          results: [],
          ...encryptedToken,
          status: "queued",
          expiresAt: new Date(retentionBase + 30 * 24 * 60 * 60_000),
        });
        return { created: true, job: publicPostJob(document) };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const duplicate = await PostModel.findOne({ idempotencyKey: input.idempotencyKey });
        return { created: false, job: publicPostJob(duplicate) };
      }
    },

    async list({ status, limit = 100 } = {}) {
      const documents = await PostModel.find(status ? { status } : {})
        .sort({ publishAt: 1 })
        .limit(Math.min(200, Math.max(1, Number(limit) || 100)));
      return documents.map(publicPostJob);
    },

    async cancel(id) {
      const document = await PostModel.findOneAndUpdate(
        { _id: id, status: { $in: ["queued", "processing", "paused", "failed"] } },
        { $set: { status: "cancelled", completedAt: now(), lockedAt: null, lockId: null, lastError: null, lastErrorCode: null } },
        { new: true },
      );
      if (!document) throw new Error("Post job cannot be cancelled");
      return publicPostJob(document);
    },

    async retry(id) {
      const current = now();
      const document = await PostModel.findOneAndUpdate(
        { _id: id, status: { $in: ["failed", "paused", "cancelled"] } },
        { $set: { status: "queued", attempts: 0, nextRunAt: current, lockedAt: null, lockId: null, completedAt: null, lastError: null, lastErrorCode: null, cancelRequested: false } },
        { new: true },
      );
      if (!document) throw new Error("Post job cannot be retried");
      return publicPostJob(document);
    },

    async purge({ scope }) {
      const statuses = postPurgeStatuses(scope);
      const result = await PostModel.deleteMany({ status: { $in: statuses } });
      return { removedJobs: Number(result.deletedCount) || 0 };
    },
  });
}

module.exports = { createPostService, postPurgeStatuses };
