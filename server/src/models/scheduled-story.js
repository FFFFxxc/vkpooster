"use strict";

const mongoose = require("mongoose");

const scheduledStorySchema = new mongoose.Schema({
  idempotencyKey: { type: String, required: true },
  groupId: { type: Number, required: true, min: 1, index: true },
  groupName: { type: String, required: true, maxlength: 160 },
  publishAt: { type: Date, required: true, index: true },
  linkUrl: { type: String, default: "", maxlength: 2048 },
  linkText: { type: String, default: "", maxlength: 60 },
  previewDataUrl: { type: String, default: "", maxlength: 180000 },
  tokenCiphertext: { type: String, required: true, select: false },
  tokenIv: { type: String, required: true, select: false },
  tokenTag: { type: String, required: true, select: false },
  mediaId: { type: mongoose.Schema.Types.ObjectId, default: null, select: false },
  mediaExpiresAt: { type: Date, default: null },
  kind: { type: String, enum: ["photo", "video", null], default: null },
  fileName: { type: String, default: null, maxlength: 200 },
  mimeType: { type: String, default: null, maxlength: 100 },
  byteLength: { type: Number, default: null, min: 1 },
  status: { type: String, enum: ["uploading", "queued", "processing", "completed", "failed", "paused", "cancelled"], default: "uploading", index: true },
  attempts: { type: Number, default: 0, min: 0 },
  lockedAt: { type: Date, default: null },
  lockId: { type: String, default: null },
  completedAt: { type: Date, default: null },
  storyId: { type: String, default: null, maxlength: 100 },
  lastError: { type: String, default: null, maxlength: 1000 },
  lastErrorCode: { type: Number, default: null },
  maintenancePending: { type: Boolean, default: false, select: false },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });

scheduledStorySchema.index({ status: 1, publishAt: 1, lockedAt: 1 }, { name: "claim_due_story" });
scheduledStorySchema.index({ idempotencyKey: 1 }, { unique: true, name: "unique_story_idempotency" });
scheduledStorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "expire_story_history" });
scheduledStorySchema.index({ mediaExpiresAt: 1 }, { name: "clean_expired_story_media" });

module.exports = mongoose.models.ScheduledStory || mongoose.model("ScheduledStory", scheduledStorySchema);
