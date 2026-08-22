"use strict";

const mongoose = require("mongoose");

const resultSchema = new mongoose.Schema({
  gid: { type: Number, required: true },
  ok: { type: Boolean, required: true },
  postId: { type: Number, default: null },
  publishedAt: { type: Date, default: null },
  error: { type: String, default: null, maxlength: 1000 },
  code: { type: Number, default: null },
  warning: { type: String, default: null, maxlength: 1000 },
  cancelled: { type: Boolean, default: false },
}, { _id: false });

const scheduledPostSchema = new mongoose.Schema({
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  sourceOwnerId: { type: Number, required: true },
  sourcePostId: { type: Number, required: true, min: 1 },
  sourceUrl: { type: String, required: true },
  groups: { type: [Number], required: true, validate: (value) => value.length > 0 && value.length <= 100 },
  groupLabels: { type: mongoose.Schema.Types.Mixed, default: {} },
  mode: { type: String, enum: ["copy", "repost"], required: true },
  text: { type: String, default: "", maxlength: 16384 },
  label: { type: String, default: "", maxlength: 160 },
  publishAt: { type: Date, required: true, index: true },
  nextRunAt: { type: Date, required: true, index: true },
  nextGroupIndex: { type: Number, default: 0, min: 0 },
  previewImages: { type: [String], default: [] },
 autoCommentText: { type: String, default: "", maxlength: 4096 },
  groupIntervalSeconds: { type: Number, default: 15, min: 15, max: 86400 },
 commentDelaySeconds: { type: Number, default: 60, min: 15, max: 86400 },
  commentGroupIntervalSeconds: { type: Number, default: 30, min: 15, max: 3600 },
  results: { type: [resultSchema], default: [] },
  cancelledGroupIds: { type: [Number], default: [] },
  tokenCiphertext: { type: String, required: true, select: false },
  tokenIv: { type: String, required: true, select: false },
  tokenTag: { type: String, required: true, select: false },
  status: { type: String, enum: ["queued", "processing", "completed", "failed", "paused", "cancelled"], default: "queued", index: true },
  attempts: { type: Number, default: 0, min: 0 },
  lockedAt: { type: Date, default: null },
  lockId: { type: String, default: null },
  cancelRequested: { type: Boolean, default: false },
  completedAt: { type: Date, default: null },
  lastError: { type: String, default: null, maxlength: 1000 },
  lastErrorCode: { type: Number, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });

scheduledPostSchema.index({ status: 1, nextRunAt: 1, lockedAt: 1 }, { name: "claim_due_post" });
scheduledPostSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "expire_old_post_jobs" });

module.exports = mongoose.models.ScheduledPost || mongoose.model("ScheduledPost", scheduledPostSchema);
