"use strict";

const crypto = require("node:crypto");
const { classifyVkError } = require("../../safety-core.js");

function safeErrorMessage(error) {
  return String(error?.message || "Unknown error").slice(0, 1000);
}

function createCommentWorker({
  CommentModel,
  tokenVault,
  vkClient,
  intervalMs = 15_000,
  staleLockMs = 10 * 60_000,
  logger = console,
}) {
  let timer = null;
  let running = false;

  async function claimOne() {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - staleLockMs);
    const lockId = crypto.randomUUID();
    return CommentModel.findOneAndUpdate(
      {
        status: { $in: ["queued", "processing"] },
        commentAt: { $lte: now },
        $or: [
          { status: "queued" },
          { lockedAt: null },
          { lockedAt: { $lt: staleBefore } },
        ],
      },
      {
        $set: { status: "processing", lockedAt: now, lockId },
        $inc: { attempts: 1 },
      },
      {
        sort: { commentAt: 1 },
        new: true,
      },
    ).select("+tokenCiphertext +tokenIv +tokenTag");
  }

  async function runOnce() {
    if (running) return false;
    running = true;
    try {
      const job = await claimOne();
      if (!job) return false;

      try {
        const groupToken = tokenVault.decrypt(job);
        await vkClient.createGroupComment({
          groupId: job.groupId,
          postId: job.postId,
          commentText: job.commentText,
          groupToken,
          guid: job.idempotencyKey,
        });
        await CommentModel.updateOne(
          {
            _id: job._id,
            status: "processing",
            lockId: job.lockId,
          },
          {
            $set: {
              status: "completed",
              completedAt: new Date(),
              lockedAt: null,
              lockId: null,
              lastError: null,
              lastErrorCode: null,
            },
          },
        );
      } catch (error) {
        const decision = classifyVkError(
          error.vkError || {
            code: error.code,
            transport: error.transport === true,
          },
        );
        const exhausted = Number(job.attempts) >= 3;
        let status = "failed";
        let commentAt = job.commentAt;
        if (decision.action === "pause") status = "paused";
        if (decision.action === "retry" && !exhausted) {
          status = "queued";
          commentAt = new Date(Date.now() + job.attempts * 5 * 60_000);
        }

        await CommentModel.updateOne(
          {
            _id: job._id,
            status: "processing",
            lockId: job.lockId,
          },
          {
            $set: {
              status,
              commentAt,
              lockedAt: null,
              lockId: null,
              lastError: safeErrorMessage(error),
              lastErrorCode: Number(error.code) || null,
            },
          },
        );
        logger.warn("[worker] Comment job did not complete", {
          jobId: String(job._id),
          status,
          errorCode: Number(error.code) || null,
        });
      }
      return true;
    } finally {
      running = false;
    }
  }

  return Object.freeze({
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void runOnce().catch((error) => {
          logger.error("[worker] Unexpected worker error", {
            message: safeErrorMessage(error),
          });
        });
      }, intervalMs);
      timer.unref?.();
      void runOnce().catch((error) => {
        logger.error("[worker] Unexpected worker error", {
          message: safeErrorMessage(error),
        });
      });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}

module.exports = { createCommentWorker };
