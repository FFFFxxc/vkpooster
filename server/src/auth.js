"use strict";

const crypto = require("node:crypto");

function createBearerAuth(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("API_SECRET must contain at least 32 characters");
  }
  const expected = Buffer.from(secret, "utf8");

  return function bearerAuth(request, response, next) {
    const header = String(request.headers?.authorization || "");
    const provided = header.startsWith("Bearer ")
      ? Buffer.from(header.slice(7), "utf8")
      : Buffer.alloc(0);
    const valid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(provided, expected);

    if (!valid) {
      return response
        .status(401)
        .json({ ok: false, error: "Unauthorized" });
    }
    return next();
  };
}

module.exports = { createBearerAuth };

