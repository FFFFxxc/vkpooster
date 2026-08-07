"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createTokenVault } = require("../src/token-vault.js");

test("token vault encrypts and decrypts without storing plaintext", () => {
  const key = crypto.randomBytes(32).toString("base64");
  const vault = createTokenVault(key);
  const encrypted = vault.encrypt("group-access-token");

  assert.equal("token" in encrypted, false);
  assert.notEqual(encrypted.tokenCiphertext, "group-access-token");
  assert.equal(vault.decrypt(encrypted), "group-access-token");
});

test("token vault rejects a modified authentication tag", () => {
  const key = crypto.randomBytes(32).toString("base64");
  const vault = createTokenVault(key);
  const encrypted = vault.encrypt("group-access-token");
  const changed = {
    ...encrypted,
    tokenTag: Buffer.from("different-auth-tag").toString("base64"),
  };

  assert.throws(() => vault.decrypt(changed));
});

test("token vault requires exactly 32 decoded key bytes", () => {
  assert.throws(
    () => createTokenVault(Buffer.from("too-short").toString("base64")),
    /32 bytes/i,
  );
});

