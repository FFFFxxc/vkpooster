"use strict";

const crypto = require("node:crypto");
const { classifyVkError } = require("../../safety-core.js");

const MAX_POST_ATTEMPTS = 3;
const POST_RETRY_MINUTES = Object.freeze([2, 5]);

function safeMessage(error) {
  return String(error?.message || "Unknown error").slice(0, 1000);
}

function retryDelayMs(attempts) {
  return POST_RETRY_MINUTES[Math.min(POST_RETRY_MINUTES.length - 1, Math.max(0, Number(attempts) - 1))] * 60_000;
}

function stableRandomId(jobId, groupId) {
  const digest = crypto.createHash("sha256").update(`${jobId}:${groupId}`).digest();
  return digest.readUInt32BE(0) % 2_147_483_647 || 1;
}

function createPostWorker({
  PostModel,
  tokenVault,
  vkClient,
  commentService,
  intervalMs = 15_000,
  staleLockMs = 10 * 60_000,
  minGroupIntervalMs = 15_000,
  now = () => new Date(),
  logger = console,
}) {
  let timer = null;
  let running = false;

  async function claimOne() {
    const current = now();
    const staleBefore = new Date(current.getTime() - staleLockMs);
    const lockId = crypto.randomUUID();
    return PostModel.findOneAndUpdate(
      {
        status: { $in: ["queued", "processing"] },
        nextRunAt: { $lte: current },
        cancelRequested: { $ne: true },
        $or: [{ status: "queued" }, { lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
      },
      { $set: { status: "processing", lockedAt: current, lockId }, $inc: { attempts: 1 } },
      { sort: { nextRunAt: 1 }, new: true },
    ).select("+tokenCiphertext +tokenIv +tokenTag");
  }

  function completionState(results) {
    if (results.some((item) => item.ok)) return "completed";
    if (results.length && results.every((item) => item.cancelled === true)) return "cancelled";
    return "failed";
  }

  async function runOnce() {
    if (running) return false;
    running = true;
    try {
      const job = await claimOne();
      if (!job) return false;
      const current = now();
      const groupIndex = Math.max(0, Number(job.nextGroupIndex) || 0);
      const groupId = Number(job.groups?.[groupIndex]);
      const results = Array.isArray(job.results) ? [...job.results] : [];
      try {
        if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error("Post job has no remaining community");
        if ((Array.isArray(job.cancelledGroupIds) ? job.cancelledGroupIds : []).map(Number).includes(groupId)) {
          results.push({ gid: groupId, ok: false, cancelled: true, error: "Отменено пользователем" });
          const nextGroupIndex = groupIndex + 1;
          const finished = nextGroupIndex >= job.groups.length;
          await PostModel.updateOne(
            { _id: job._id, status: "processing", lockId: job.lockId },
            { $set: {
              status: finished ? completionState(results) : "queued",
              nextGroupIndex,
              nextRunAt: finished ? current : new Date(current.getTime() + Math.max(15_000, minGroupIntervalMs, (Number(job.groupIntervalSeconds) || 15) * 1000)),
              results,
              attempts: 0,
              completedAt: finished ? current : null,
              lockedAt: null,
              lockId: null,
              lastError: null,
              lastErrorCode: null,
            } },
          );
          return true;
        }
        const userToken = tokenVault.decrypt(job);
        const input = {
          sourceOwnerId: job.sourceOwnerId,
          sourcePostId: job.sourcePostId,
          targetGroupId: groupId,
          text: job.text || "",
          userToken,
          randomId: stableRandomId(job.idempotencyKey || String(job._id), groupId),
        };
        const published = job.mode === "repost"
          ? await vkClient.repostToGroup(input)
          : await vkClient.publishCopiedPost(input);
        const postId = Number(published?.postId ?? published?.post_id);
        if (!Number.isSafeInteger(postId) || postId <= 0) throw new Error("VK did not return a published post ID");
        const result = { gid: groupId, ok: true, postId, publishedAt: current };

        if (job.autoCommentText) {
          try {
            const commentAt = new Date(current.getTime() + Math.max(15, Number(job.commentDelaySeconds) || 60) * 1000 + groupIndex * Math.max(15, Number(job.commentGroupIntervalSeconds) || 30) * 1000);
            await commentService.enqueue({
              idempotencyKey: `post:${String(job._id)}:${groupId}:${postId}:comment`.slice(0, 200),
              groupId,
              postId,
              commentText: job.autoCommentText,
              commentAt,
              userToken,
            });
          } catch (error) {
            result.warning = `Комментарий не запланирован: ${safeMessage(error)}`;
          }
        }

        results.push(result);
        const nextGroupIndex = groupIndex + 1;
        const finished = nextGroupIndex >= job.groups.length;
        await PostModel.updateOne(
          { _id: job._id, status: "processing", lockId: job.lockId },
          { $set: {
            status: finished ? completionState(results) : "queued",
            nextGroupIndex,
            nextRunAt: finished ? current : new Date(current.getTime() + Math.max(15_000, minGroupIntervalMs, (Number(job.groupIntervalSeconds) || 15) * 1000)),
            results,
            attempts: 0,
            completedAt: finished ? current : null,
            lockedAt: null,
            lockId: null,
            lastError: null,
            lastErrorCode: null,
          } },
        );
      } catch (error) {
        const decision = classifyVkError(error.vkError || { code: error.code, transport: error.transport === true });
        const exhausted = Number(job.attempts) >= MAX_POST_ATTEMPTS;
        if (decision.action === "pause") {
          await PostModel.updateOne(
            { _id: job._id, status: "processing", lockId: job.lockId },
            { $set: { status: "paused", lockedAt: null, lockId: null, lastError: safeMessage(error), lastErrorCode: Number(error.code) || null } },
          );
        } else if (decision.action === "retry" && !exhausted) {
          await PostModel.updateOne(
            { _id: job._id, status: "processing", lockId: job.lockId },
            { $set: { status: "queued", nextRunAt: new Date(current.getTime() + retryDelayMs(job.attempts)), lockedAt: null, lockId: null, lastError: safeMessage(error), lastErrorCode: Number(error.code) || null } },
          );
        } else {
          results.push({ gid: groupId, ok: false, error: safeMessage(error), code: Number(error.code) || null });
          const nextGroupIndex = groupIndex + 1;
          const finished = nextGroupIndex >= (job.groups?.length || 0);
          await PostModel.updateOne(
            { _id: job._id, status: "processing", lockId: job.lockId },
            { $set: {
              status: finished ? completionState(results) : "queued",
              nextGroupIndex,
              nextRunAt: finished ? current : new Date(current.getTime() + Math.max(15_000, minGroupIntervalMs, (Number(job.groupIntervalSeconds) || 15) * 1000)),
              results,
              attempts: 0,
              completedAt: finished ? current : null,
              lockedAt: null,
              lockId: null,
              lastError: finished ? safeMessage(error) : null,
              lastErrorCode: finished ? Number(error.code) || null : null,
            } },
          );
        }
        logger.warn("[post-worker] Post target did not complete", { jobId: String(job._id), groupId, errorCode: Number(error.code) || null });
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
      timer = setInterval(() => void runOnce().catch((error) => logger.error("[post-worker] Unexpected worker error", { message: safeMessage(error) })), intervalMs);
      timer.unref?.();
      void runOnce().catch((error) => logger.error("[post-worker] Unexpected worker error", { message: safeMessage(error) }));
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  });
}

module.exports = { MAX_POST_ATTEMPTS, createPostWorker, retryDelayMs, stableRandomId };
