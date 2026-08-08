"use strict";

const {
  publicCommentJob,
  validateScheduledCommentInput,
} = require("./validation.js");

function commentPurgeStatuses(scope) {
  if (scope === "errors") return ["failed"];
  if (scope === "completed") return ["completed"];
  if (scope === "all") return ["completed", "failed"];
  throw new Error("scope must be errors, completed, or all");
}

function createCommentService({ CommentModel, tokenVault }) {
  return Object.freeze({
    async enqueue(rawInput) {
      const input = validateScheduledCommentInput(rawInput);
      const existing = await CommentModel.findOne({
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) {
        return { created: false, job: publicCommentJob(existing) };
      }

      const encryptedToken = tokenVault.encrypt(input.groupToken);
      try {
        const document = await CommentModel.create({
          idempotencyKey: input.idempotencyKey,
          groupId: input.groupId,
          postId: input.postId,
          commentText: input.commentText,
          commentAt: input.commentAt,
          ...encryptedToken,
          status: "queued",
          expiresAt: new Date(
            Math.max(Date.now(), input.commentAt.getTime()) +
              30 * 24 * 60 * 60 * 1000,
          ),
        });
        return { created: true, job: publicCommentJob(document) };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const duplicate = await CommentModel.findOne({
          idempotencyKey: input.idempotencyKey,
        });
        return { created: false, job: publicCommentJob(duplicate) };
      }
    },

    async list({ status, limit = 100 } = {}) {
      const filter = status ? { status } : {};
      const documents = await CommentModel.find(filter)
        .sort({ commentAt: 1 })
        .limit(Math.min(200, Math.max(1, Number(limit) || 100)));
      return documents.map(publicCommentJob);
    },

    async remove(id) {
      const result = await CommentModel.deleteOne({ _id: id });
      return result.deletedCount > 0;
    },

    async purge({ scope }) {
      const statuses = commentPurgeStatuses(scope);
      const result = await CommentModel.deleteMany({ status: { $in: statuses } });
      return { removedJobs: Number(result.deletedCount) || 0 };
    },
  });
}

module.exports = { createCommentService };
