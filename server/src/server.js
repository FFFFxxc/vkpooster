"use strict";

const http = require("node:http");
const mongoose = require("mongoose");
const { createApp } = require("./app.js");
const { createCommentService } = require("./comment-service.js");
const { loadConfig } = require("./config.js");
const ScheduledComment = require("./models/scheduled-comment.js");
const ScheduledPost = require("./models/scheduled-post.js");
const ScheduledStory = require("./models/scheduled-story.js");
const { createPostService } = require("./post-service.js");
const { createPostWorker } = require("./post-worker.js");
const { createStoryMediaStore } = require("./story-media-store.js");
const { createStoryService } = require("./story-service.js");
const { createStoryWorker } = require("./story-worker.js");
const { createTokenVault } = require("./token-vault.js");
const { createVkClient } = require("./vk-client.js");
const { createCommentWorker } = require("./worker.js");

async function main() {
  const config = loadConfig();
  await mongoose.connect(config.mongodbUri, {
    serverSelectionTimeoutMS: 15_000,
    maxPoolSize: 5,
  });

  const tokenVault = createTokenVault(config.tokenEncryptionKey);
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "scheduled_story_media",
  });
  const storyMediaStore = createStoryMediaStore({ bucket, maxBytes: config.storyMaxBytes });
  const commentService = createCommentService({
    CommentModel: ScheduledComment,
    tokenVault,
  });
  const postService = createPostService({
    PostModel: ScheduledPost,
    tokenVault,
  });
  const vkClient = createVkClient({ apiVersion: config.vkApiVersion });
  const worker = createCommentWorker({
    CommentModel: ScheduledComment,
    tokenVault,
    vkClient,
    intervalMs: config.workerIntervalMs,
    staleLockMs: config.staleLockMs,
  });
  const postWorker = createPostWorker({
    PostModel: ScheduledPost,
    tokenVault,
    vkClient,
    commentService,
    intervalMs: config.workerIntervalMs,
    staleLockMs: config.staleLockMs,
    minGroupIntervalMs: config.postGroupIntervalMs,
  });
  const storyService = createStoryService({
    StoryModel: ScheduledStory,
    tokenVault,
    mediaStore: storyMediaStore,
    maxBytes: config.storyMaxBytes,
  });
  const storyWorker = createStoryWorker({
    StoryModel: ScheduledStory,
    tokenVault,
    mediaStore: storyMediaStore,
    vkClient,
    intervalMs: config.workerIntervalMs,
    staleLockMs: config.staleLockMs,
  });
  const app = createApp({ config, commentService, postService, storyService });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(config.port, resolve));
  worker.start();
  postWorker.start();
  storyWorker.start();
  const mediaCleanupTimer = setInterval(() => {
    void storyService.cleanupExpiredMedia().catch((error) => {
      console.error("[server] Story media cleanup failed", { message: error.message });
    });
  }, 60 * 60_000);
  mediaCleanupTimer.unref?.();
  console.log(`[server] VK Reposter Safe Server listening on ${config.port}`);

  async function shutdown(signal) {
    console.log(`[server] ${signal}: shutting down`);
    worker.stop();
    postWorker.stop();
    storyWorker.stop();
    clearInterval(mediaCleanupTimer);
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    process.exit(0);
  }
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[server] Startup failed", { message: error.message });
  process.exit(1);
});
