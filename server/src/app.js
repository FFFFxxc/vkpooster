"use strict";

const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const mongoose = require("mongoose");
const { createBearerAuth } = require("./auth.js");

function createApp({
  config,
  commentService,
  storyService,
  databaseReady = () => mongoose.connection.readyState === 1,
}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  // Story cards may carry a deliberately bounded preview thumbnail (up to
  // 180,000 characters). The actual media still uses the separate raw upload
  // route with its own stricter size limit.
  app.use(express.json({ limit: "256kb", strict: true }));

  app.get("/health", (_request, response) => {
    const connected = databaseReady();
    response.status(connected ? 200 : 503).json({
      status: connected ? "ok" : "degraded",
      version: "4.1.0",
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
      version: "4.1.0",
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

  api.post("/scheduled-stories", async (request, response, next) => {
    try {
      const result = await storyService.createDraft(request.body);
      response.status(result.created ? 201 : 200).json({ ok: true, created: result.created, job: result.job });
    } catch (error) {
      if (/required|must|invalid|groupToken|publishAt|linkUrl|linkText|previewDataUrl|idempotencyKey/i.test(error.message)) {
        response.status(400).json({ ok: false, error: error.message }); return;
      }
      next(error);
    }
  });

  api.put(
    "/scheduled-stories/:id/media",
    express.raw({ type: ["image/jpeg", "image/png", "video/mp4", "video/quicktime", "video/webm"], limit: config.storyMaxBytes }),
    async (request, response, next) => {
      try {
        if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
          response.status(400).json({ ok: false, error: "A supported raw media body is required" }); return;
        }
        const rawName = String(request.headers["x-file-name"] || "story-media");
        let fileName;
        try { fileName = decodeURIComponent(rawName); } catch { fileName = rawName; }
        const job = await storyService.attachMedia(request.params.id, {
          buffer: request.body, fileName, mimeType: request.headers["content-type"],
        });
        response.json({ ok: true, job });
      } catch (error) {
        if (/media|file|mime|draft|maximum|already/i.test(error.message)) {
          response.status(400).json({ ok: false, error: error.message }); return;
        }
        next(error);
      }
    },
  );

  api.get("/scheduled-stories", async (request, response, next) => {
    try {
      const jobs = await storyService.list({ status: request.query.status, limit: request.query.limit });
      response.json({ ok: true, jobs });
    } catch (error) { next(error); }
  });

  api.delete("/scheduled-stories/:id", async (request, response, next) => {
    try {
      const result = await storyService.cancel(request.params.id);
      response.status(result.removed ? 200 : 404).json({ ok: result.removed, job: result.job, error: result.removed ? undefined : "Job not found" });
    } catch (error) { next(error); }
  });

  api.patch("/scheduled-stories/:id/reschedule", async (request, response, next) => {
    try {
      const job = await storyService.reschedule(request.params.id, request.body?.publishAt);
      response.json({ ok: true, job });
    } catch (error) {
      if (/publishAt|rescheduled|future/i.test(error.message)) { response.status(400).json({ ok: false, error: error.message }); return; }
      next(error);
    }
  });

  api.post("/scheduled-stories/:id/retry", async (request, response, next) => {
    try { response.json({ ok: true, job: await storyService.retry(request.params.id) }); }
    catch (error) {
      if (/retried/i.test(error.message)) { response.status(400).json({ ok: false, error: error.message }); return; }
      next(error);
    }
  });

  app.use("/api", api);
  app.use((_request, response) => {
    response.status(404).json({ ok: false, error: "Not found" });
  });
  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
      response.status(413).json({ ok: false, error: "Story media is too large" });
      return;
    }
    console.error("[server] Request failed", { message: error.message });
    response.status(500).json({ ok: false, error: "Internal server error" });
  });
  return app;
}

module.exports = { createApp };
