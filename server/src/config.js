"use strict";

const { decodeKey } = require("./token-vault.js");

function requireString(environment, key) {
  const value = String(environment[key] || "").trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function loadConfig(environment = process.env) {
  const mongodbUri = requireString(environment, "MONGODB_URI");
  const apiSecret = requireString(environment, "API_SECRET");
  if (apiSecret.length < 32) {
    throw new Error("API_SECRET must contain at least 32 characters");
  }
  const tokenEncryptionKey = requireString(
    environment,
    "TOKEN_ENCRYPTION_KEY",
  );
  decodeKey(tokenEncryptionKey);

  return Object.freeze({
    mongodbUri,
    apiSecret,
    tokenEncryptionKey,
    port: Math.max(1, Number(environment.PORT) || 3000),
    workerIntervalMs: Math.max(
      5_000,
      Number(environment.WORKER_INTERVAL_MS) || 15_000,
    ),
    staleLockMs: Math.max(
      60_000,
      Number(environment.STALE_LOCK_MS) || 10 * 60_000,
    ),
    postGroupIntervalMs: Math.max(
      15_000,
      Number(environment.POST_GROUP_INTERVAL_MS) || 15_000,
    ),
    vkApiVersion: String(environment.VK_API_VERSION || "5.199"),
    storyMaxBytes: Math.max(
      1024 * 1024,
      Number(environment.STORY_MAX_BYTES) || 25 * 1024 * 1024,
    ),
  });
}

module.exports = { loadConfig };
