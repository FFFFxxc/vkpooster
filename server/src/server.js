"use strict";

const http = require("node:http");
const mongoose = require("mongoose");
const { createApp } = require("./app.js");
const { createCommentService } = require("./comment-service.js");
const { loadConfig } = require("./config.js");
const ScheduledComment = require("./models/scheduled-comment.js");
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
  const commentService = createCommentService({
    CommentModel: ScheduledComment,
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
  const app = createApp({ config, commentService });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(config.port, resolve));
  worker.start();
  console.log(`[server] VK Reposter Safe Server listening on ${config.port}`);

  async function shutdown(signal) {
    console.log(`[server] ${signal}: shutting down`);
    worker.stop();
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

