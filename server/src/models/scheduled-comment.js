"use strict";

const mongoose = require("mongoose");

const scheduledCommentSchema = new mongoose.Schema(
  {
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    groupId: { type: Number, required: true, min: 1, index: true },
    postId: { type: Number, required: true, min: 1 },
    commentText: { type: String, required: true, maxlength: 4096 },
    commentAt: { type: Date, required: true, index: true },
    tokenCiphertext: { type: String, required: true, select: false },
    tokenIv: { type: String, required: true, select: false },
    tokenTag: { type: String, required: true, select: false },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "paused"],
      default: "queued",
      index: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    lockedAt: { type: Date, default: null },
    lockId: { type: String, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 1000 },
    lastErrorCode: { type: Number, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

scheduledCommentSchema.index(
  { status: 1, commentAt: 1, lockedAt: 1 },
  { name: "claim_due_comment" },
);
scheduledCommentSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "expire_old_comment_jobs" },
);

module.exports =
  mongoose.models.ScheduledComment ||
  mongoose.model("ScheduledComment", scheduledCommentSchema);
