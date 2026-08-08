"use strict";

const { publicStoryJob, validateStoryDraftInput, validateStoryMedia } = require("./story-validation.js");

function createStoryService({ StoryModel, tokenVault, mediaStore, maxBytes, now = () => new Date() }) {
  return Object.freeze({
    async createDraft(rawInput) {
      const input = validateStoryDraftInput(rawInput, { now: now() });
      const existing = await StoryModel.findOne({ idempotencyKey: input.idempotencyKey });
      if (existing) return { created: false, job: publicStoryJob(existing) };
      const encryptedToken = tokenVault.encrypt(input.groupToken);
      try {
        const document = await StoryModel.create({
          idempotencyKey: input.idempotencyKey, groupId: input.groupId, groupName: input.groupName,
          publishAt: input.publishAt, linkUrl: input.linkUrl, linkText: input.linkText,
          previewDataUrl: input.previewDataUrl, ...encryptedToken, status: "uploading",
          // If the browser disappears between draft creation and the raw media
          // upload, do not retain a usable community token indefinitely.
          mediaExpiresAt: new Date(now().getTime() + 24 * 60 * 60_000),
          expiresAt: new Date(input.publishAt.getTime() + 90 * 24 * 60 * 60_000),
        });
        return { created: true, job: publicStoryJob(document) };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        return { created: false, job: publicStoryJob(await StoryModel.findOne({ idempotencyKey: input.idempotencyKey })) };
      }
    },

    async attachMedia(id, { buffer, fileName, mimeType }) {
      const media = validateStoryMedia({ fileName, mimeType, byteLength: buffer?.length, maxBytes });
      const draft = await StoryModel.findOne({ _id: id, status: "uploading" });
      if (!draft) throw new Error("Story draft not found or media is already attached");
      const mediaId = await mediaStore.save({ buffer, fileName: media.fileName, mimeType: media.mimeType });
      let updated;
      try {
        updated = await StoryModel.findOneAndUpdate(
          { _id: id, status: "uploading" },
          { $set: { status: "queued", mediaId, kind: media.kind, fileName: media.fileName, mimeType: media.mimeType, byteLength: media.byteLength, mediaExpiresAt: null } },
          { new: true },
        );
      } catch (error) {
        await mediaStore.remove(mediaId);
        throw error;
      }
      if (!updated) { await mediaStore.remove(mediaId); throw new Error("Story draft changed while media was uploading"); }
      return publicStoryJob(updated);
    },

    async list({ status, limit = 100 } = {}) {
      const documents = await StoryModel.find(status ? { status } : {}).sort({ publishAt: 1 }).limit(Math.min(200, Math.max(1, Number(limit) || 100)));
      return documents.map(publicStoryJob);
    },

    async cancel(id) {
      const cleanupDueAt = now();
      const document = await StoryModel.findOneAndUpdate(
        { _id: id, status: { $in: ["uploading", "queued", "failed", "paused"] } },
        {
          $set: { status: "cancelled", lockedAt: null, lockId: null, mediaExpiresAt: cleanupDueAt },
          $unset: { tokenCiphertext: "", tokenIv: "", tokenTag: "" },
        },
        { new: true },
      ).select("+mediaId");
      if (!document) return { removed: false, job: null };
      if (document.mediaId) {
        try {
          await mediaStore.remove(document.mediaId);
          await StoryModel.updateOne({ _id: document._id }, { $set: { mediaId: null, mediaExpiresAt: null } });
          document.mediaId = null;
          document.mediaExpiresAt = null;
        } catch {
          // The hourly cleanup will retry. The token has already been removed
          // and the cancelled job can no longer be claimed by the worker.
        }
      } else {
        await StoryModel.updateOne({ _id: document._id }, { $set: { mediaExpiresAt: null } });
        document.mediaExpiresAt = null;
      }
      return { removed: true, job: publicStoryJob(document) };
    },

    async reschedule(id, publishAt) {
      const date = new Date(publishAt);
      const current = now();
      if (!Number.isFinite(date.getTime()) || date.getTime() < current.getTime() + 60_000) throw new Error("publishAt must be at least 60 seconds in the future");
      const job = await StoryModel.findOneAndUpdate(
        { _id: id, status: { $in: ["queued", "failed", "paused"] }, mediaId: { $ne: null } },
        { $set: { publishAt: date, status: "queued", lastError: null, lastErrorCode: null, lockedAt: null, lockId: null, mediaExpiresAt: null } },
        { new: true },
      );
      if (!job) throw new Error("Story job cannot be rescheduled");
      return publicStoryJob(job);
    },

    async retry(id) {
      const job = await StoryModel.findOneAndUpdate(
        { _id: id, status: { $in: ["failed", "paused"] }, mediaId: { $ne: null } },
        { $set: { status: "queued", publishAt: new Date(now().getTime() + 60_000), attempts: 0, lastError: null, lastErrorCode: null, lockedAt: null, lockId: null, mediaExpiresAt: null } },
        { new: true },
      );
      if (!job) throw new Error("Story job cannot be retried");
      return publicStoryJob(job);
    },

    async cleanupExpiredMedia(reference = now()) {
      const jobs = await StoryModel.find({ mediaExpiresAt: { $ne: null, $lte: reference } }).select("+mediaId").limit(100);
      let removed = 0;
      for (const job of jobs) {
        if (job.mediaId) await mediaStore.remove(job.mediaId);
        const expiredDraft = job.status === "uploading";
        await StoryModel.updateOne(
          { _id: job._id },
          {
            $set: {
              mediaId: null,
              mediaExpiresAt: null,
              ...(expiredDraft ? { status: "failed", lastError: "Media upload expired before completion" } : {}),
            },
            $unset: { tokenCiphertext: "", tokenIv: "", tokenTag: "" },
          },
        );
        removed += 1;
      }
      return removed;
    },
  });
}

module.exports = { createStoryService };
