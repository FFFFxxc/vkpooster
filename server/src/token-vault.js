"use strict";

const crypto = require("node:crypto");

function decodeKey(encodedKey) {
  if (typeof encodedKey !== "string" || !encodedKey.trim()) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required");
  }
  const key = Buffer.from(encodedKey.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes",
    );
  }
  return key;
}

function createTokenVault(encodedKey) {
  const key = decodeKey(encodedKey);

  return Object.freeze({
    encrypt(plaintext) {
      if (typeof plaintext !== "string" || !plaintext) {
        throw new Error("Cannot encrypt an empty token");
      }
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return {
        tokenCiphertext: ciphertext.toString("base64"),
        tokenIv: iv.toString("base64"),
        tokenTag: cipher.getAuthTag().toString("base64"),
      };
    },

    decrypt({ tokenCiphertext, tokenIv, tokenTag }) {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(tokenIv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(tokenTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(tokenCiphertext, "base64")),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    },
  });
}

module.exports = { createTokenVault, decodeKey };

