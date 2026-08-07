"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBearerAuth } = require("../src/auth.js");

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test("bearer auth accepts only the configured full secret", () => {
  const auth = createBearerAuth("a".repeat(40));
  const accepted = { called: false };
  auth(
    { headers: { authorization: `Bearer ${"a".repeat(40)}` } },
    responseRecorder(),
    () => {
      accepted.called = true;
    },
  );
  assert.equal(accepted.called, true);

  const rejectedResponse = responseRecorder();
  auth(
    { headers: { authorization: `Bearer ${"a".repeat(39)}b` } },
    rejectedResponse,
    () => assert.fail("invalid secret must not call next"),
  );
  assert.equal(rejectedResponse.statusCode, 401);
  assert.deepEqual(rejectedResponse.payload, {
    ok: false,
    error: "Unauthorized",
  });
});

