"use strict";

const crypto = require("node:crypto");
const { classifyVkError } = require("../../safety-core.js");

function safeErrorMessage(error) {
  return String(error?.message || "Unknown story error").replace(/((?:access[_-]?token|token)\s*[=:]\s*)[^\s&]+/gi, "$1[redacted]").slice(0, 1000);
}

function createStoryWorker({ StoryModel, tokenVault, mediaStore, vkClient, intervalMs = 15_000, staleLockMs = 10 * 60_000, logger = console }) {
  let timer = null;
  let running = false;

  async function claimOne() {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - staleLockMs);
    return StoryModel.findOneAndUpdate(
      {
        status: { $in: ["queued", "processing"] }, publishAt: { $lte: now }, mediaId: { $ne: null },
        $or: [{ status: "queued" }, { lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
      },
      { $set: { status: "processing", lockedAt: now, lockId: crypto.randomUUID() }, $inc: { attempts: 1 } },
      { sort: { publishAt: 1 }, new: true },
    ).select("+tokenCiphertext +tokenIv +tokenTag +mediaId");
  }

  async function runOnce() {
    if (running) return false;
    running = true;
    try {
      const job = await claimOne();
      if (!job) return false;
      try {
        const userToken = tokenVault.decrypt(job);
        const media = await mediaStore.read(job.mediaId);
        const server = await vkClient.createStoryUploadServer({
          kind: job.kind, groupId: job.groupId, userToken, linkUrl: job.linkUrl, linkText: job.linkText,
        });
        const uploadUrl = server?.upload_url || server?.uploadUrl;
        if (!uploadUrl) throw new Error("VK did not return a story upload URL");
        const uploadResult = await vkClient.uploadStoryMedia({
          uploadUrl, kind: job.kind, media, fileName: job.fileName, mimeType: job.mimeType,
        });
        const saved = await vkClient.saveCommunityStory({ userToken, uploadResult });
        const storyId = String(saved?.items?.[0]?.id || saved?.[0]?.id || saved?.story_id || saved?.id || "");
        const cleanupDueAt = new Date();
        const completed = await StoryModel.updateOne(
          { _id: job._id, status: "processing", lockId: job.lockId },
          {
            $set: { status: "completed", completedAt: new Date(), storyId: storyId || null, lockedAt: null, lockId: null, lastError: null, lastErrorCode: null, mediaExpiresAt: cleanupDueAt },
            $unset: { tokenCiphertext: "", tokenIv: "", tokenTag: "" },
          },
        );
        if (completed.modifiedCount > 0) {
          try {
            await mediaStore.remove(job.mediaId);
            await StoryModel.updateOne(
              { _id: job._id, status: "completed" },
              { $set: { mediaId: null, mediaExpiresAt: null } },
            );
          } catch (cleanupError) {
            // Publishing already succeeded. Keep the cleanup marker so the
            // hourly server cleanup can remove GridFS media later.
            logger.warn("[story-worker] Published story media cleanup was deferred", {
              jobId: String(job._id), message: safeErrorMessage(cleanupError),
            });
          }
        }
      } catch (error) {
        const decision = classifyVkError(error.vkError || { code: error.code, transport: error.transport === true });
        const exhausted = Number(job.attempts) >= 3;
        let status = "failed";
        let publishAt = job.publishAt;
        if (decision.action === "pause") status = "paused";
        if (decision.action === "retry" && !exhausted) {
          status = "queued";
          publishAt = new Date(Date.now() + Number(job.attempts) * 5 * 60_000);
        }
        await StoryModel.updateOne(
          { _id: job._id, status: "processing", lockId: job.lockId },
          { $set: { status, publishAt, lockedAt: null, lockId: null, lastError: safeErrorMessage(error), lastErrorCode: Number(error.code) || null, mediaExpiresAt: status === "queued" ? null : new Date(Date.now() + 7 * 24 * 60 * 60_000) } },
        );
        logger.warn("[story-worker] Story job did not complete", { jobId: String(job._id), status, errorCode: Number(error.code) || null });
      }
      return true;
    } finally { running = false; }
  }

  return Object.freeze({
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => void runOnce().catch((error) => logger.error("[story-worker] Unexpected error", { message: safeErrorMessage(error) })), intervalMs);
      timer.unref?.();
      void runOnce().catch((error) => logger.error("[story-worker] Unexpected error", { message: safeErrorMessage(error) }));
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  });
}

module.exports = { createStoryWorker };
