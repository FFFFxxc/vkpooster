"use strict";

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function validateScheduledCommentInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("JSON body is required");
  }
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!/^[a-zA-Z0-9:_-]{8,200}$/.test(idempotencyKey)) {
    throw new Error(
      "idempotencyKey must contain 8-200 safe characters",
    );
  }

  const groupId = requirePositiveInteger(input.groupId, "groupId");
  const postId = requirePositiveInteger(input.postId, "postId");
  const commentText = String(input.commentText || "").trim();
  if (!commentText || commentText.length > 4096) {
    throw new Error("commentText must contain 1-4096 characters");
  }

  const commentAt = new Date(input.commentAt);
  if (!Number.isFinite(commentAt.getTime())) {
    throw new Error("commentAt must be a valid date");
  }
  const userToken = String(input.userToken || "").trim();
  if (userToken.length < 20 || userToken.length > 4096) {
    throw new Error("userToken has an invalid length");
  }

  return {
    idempotencyKey,
    groupId,
    postId,
    commentText,
    commentAt,
    userToken,
  };
}

function publicCommentJob(document) {
  const source =
    document && typeof document.toObject === "function"
      ? document.toObject()
      : { ...(document || {}) };

  return {
    id: String(source._id || source.id || ""),
    idempotencyKey: source.idempotencyKey,
    groupId: source.groupId,
    postId: source.postId,
    commentText: source.commentText,
    commentAt: source.commentAt,
    status: source.status,
    attempts: source.attempts || 0,
    lastError: source.lastError || null,
    lastErrorCode: source.lastErrorCode || null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    completedAt: source.completedAt || null,
  };
}

module.exports = {
  publicCommentJob,
  requirePositiveInteger,
  validateScheduledCommentInput,
};
