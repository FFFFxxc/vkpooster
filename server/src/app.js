"use strict";

const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const mongoose = require("mongoose");
const { createBearerAuth } = require("./auth.js");

function createApp({
  config,
  commentService,
  databaseReady = () => mongoose.connection.readyState === 1,
}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json({ limit: "32kb", strict: true }));

  app.get("/health", (_request, response) => {
    const connected = databaseReady();
    response.status(connected ? 200 : 503).json({
      status: connected ? "ok" : "degraded",
      version: "4.0.0",
      database: connected ? "connected" : "disconnected",
    });
  });

  const api = express.Router();
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { ok: false, error: "Too many requests" },
    }),
  );
  api.use(createBearerAuth(config.apiSecret));

  api.get("/status", (_request, response) => {
    const connected = databaseReady();
    response.json({
      ok: true,
      status: connected ? "ready" : "degraded",
      version: "4.0.0",
      database: connected ? "connected" : "disconnected",
    });
  });

  api.post("/scheduled-comments", async (request, response, next) => {
    try {
      const result = await commentService.enqueue(request.body);
      response.status(result.created ? 201 : 200).json({
        ok: true,
        created: result.created,
        job: result.job,
      });
    } catch (error) {
      if (
        /required|must|invalid|groupToken|commentText|commentAt|groupId|postId|idempotencyKey/i.test(
          error.message,
        )
      ) {
        response.status(400).json({ ok: false, error: error.message });
        return;
      }
      next(error);
    }
  });

  api.get("/scheduled-comments", async (request, response, next) => {
    try {
      const jobs = await commentService.list({
        status: request.query.status,
        limit: request.query.limit,
      });
      response.json({ ok: true, jobs });
    } catch (error) {
      next(error);
    }
  });

  api.delete("/scheduled-comments/:id", async (request, response, next) => {
    try {
      const removed = await commentService.remove(request.params.id);
      response.status(removed ? 200 : 404).json({
        ok: removed,
        error: removed ? undefined : "Job not found",
      });
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", api);
  app.use((_request, response) => {
    response.status(404).json({ ok: false, error: "Not found" });
  });
  app.use((error, _request, response, _next) => {
    console.error("[server] Request failed", { message: error.message });
    response.status(500).json({ ok: false, error: "Internal server error" });
  });
  return app;
}

module.exports = { createApp };
