# Scheduled Stories and Visual Queue Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add encrypted-token scheduled community stories with temporary MongoDB/GridFS media storage, then restore a preview-rich queue manager for posts, waiting items, comments, stories, failures, and history.

**Architecture:** A story is created as a JSON draft containing metadata and an encrypted community token, then the extension uploads the raw media to a dedicated authenticated endpoint capped at 25 MiB. A GridFS-backed service owns lifecycle cleanup, a serial worker publishes one due story at a time through official VK Stories methods, and UI pages access only redacted jobs and small derived previews. The scheduled manager renders pre-captured local post previews rather than fetching every post from VK on page load.

**Tech Stack:** Node.js >=20, Express 5, Mongoose 8/GridFSBucket, MongoDB Atlas, Chrome Manifest V3, vanilla JS/CSS, VK API v5.199, Node built-in test runner.

## Global Constraints

- The server accepts no user VK token. Only a per-community token is accepted for a story draft and immediately AES-256-GCM encrypted via `token-vault.js`.
- Every `/api/*` story endpoint requires the existing bearer `API_SECRET`; replies must never include plaintext, ciphertext, IV, tag, or any secret.
- `STORY_MAX_BYTES` defaults to exactly `26214400` (25 MiB), cannot be configured below `1048576`, and is checked before GridFS persistence.
- A story must have a positive community ID, an existing locally configured community token, a future `publishAt`, a safe file name, and a MIME type in the allow-list: `image/jpeg`, `image/png`, `video/mp4`, `video/quicktime`, or `video/webm`.
- A story CTA link may be empty or an internal HTTPS `vk.com` URL; no external link is accepted. When supplied, `linkText` must be one of exactly `to_store`, `vote`, `more`, `book`, `order`, `enroll`, `fill`, `signup`, `buy`, `ticket`, `write`, `open`, `learn_more`, `view`, `go_to`, `contact`, `watch`, `play`, `install`, `read`, `calendar`, `market_online_booking`, `market_link`, or `message_to_bc`. The UI must state that the community needs the VK eligibility required for story publication.
- The worker claims and publishes one due job at a time. It pauses on `classifyVkError(...).action === "pause"`, retries transient errors at most twice, and never hammers an invalid token or CAPTCHA.
- Media is deleted from GridFS immediately after success or user cancellation. A failed/paused media file is retained for seven days for manual retry, then removed by a cleanup pass. Job metadata may remain as history without media.
- Do not restore the old server account sync, scheduled post API, analytics polling, or base64 media storage.
- UI changes must not add calls to `wall.getById`, `stories.getById`, or analytics APIs when opening the queue manager.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/src/story-validation.js` | Validates story drafts, media metadata, internal VK links, and serializes redacted public jobs. |
| `server/src/models/scheduled-story.js` | Mongoose model and indexes for encrypted-token story jobs. |
| `server/src/story-media-store.js` | Narrow GridFS adapter: save bounded media, read into a bounded buffer for VK upload, and delete by ID. |
| `server/src/story-service.js` | Draft/create, attach media, list, cancel, reschedule, retry, and retention cleanup lifecycle. |
| `server/src/story-worker.js` | Atomic due-job claim and serial official-VK publication. |
| `server/src/vk-client.js` | Adds story upload-server, media-upload, and save operations to the existing HTTP client. |
| `server/src/app.js` | Authenticated draft/media/list/cancel/reschedule story API routes. |
| `server/src/server.js` | Wires model, GridFS bucket, service, story worker, and shutdown. |
| `server/test/story-*.test.js` | Validation, service/media lifecycle, worker, and route tests with injected fakes. |
| `queue-preview-core.js` | Pure local queue preview and status-card model for tests and `scheduled.html`. |
| `extension-server-client.js` | Extension-page helper that reads local Render settings and sends bearer-authenticated JSON/raw media without sending a user token. |
| `popup.html`, `popup-auth.js`, `popup.css` | Story composer, local thumbnail creation, and queue shortcut. |
| `scheduled.html`, `scheduled.js`, `scheduled.css` | Restored tabbed visual manager and actions for all safe job types. |
| `background.js` | Captures publish-job preview snapshots and bridges list/cancel/reschedule calls for extension pages that need them. |
| `tests/queue-preview-core.test.js` | Tests post preview capture and status grouping without VK network calls. |
| `README.md`, `server/README.md`, `render.yaml` | Deployment variables, media retention, and safe use instructions. |

### Task 1: Specify and test the redacted scheduled-story payload

**Files:**

- Create: `server/src/story-validation.js`
- Create: `server/test/story-validation.test.js`

**Interfaces:**

- Produces `validateStoryDraftInput(input, { now }) -> StoryDraft`.
- Produces `validateStoryMedia({ fileName, mimeType, byteLength, maxBytes }) -> StoryMedia`.
- Produces `publicStoryJob(document) -> PublicStoryJob` with no credential fields.
- `StoryDraft` includes `{ idempotencyKey, groupId, groupName, publishAt, groupToken, linkUrl, linkText, previewDataUrl }`.

- [ ] **Step 1: Write failing validation and serialization tests**

  Create `server/test/story-validation.test.js`:

  ```js
  "use strict";
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const {
    publicStoryJob,
    validateStoryDraftInput,
    validateStoryMedia,
  } = require("../src/story-validation.js");

  test("story draft accepts a future community story with an internal VK link", () => {
    const draft = validateStoryDraftInput({
      idempotencyKey: "story_1:42:abc12345",
      groupId: "42",
      groupName: "Test club",
      publishAt: "2026-08-09T12:00:00.000Z",
      groupToken: "x".repeat(40),
      linkUrl: "https://vk.com/club42",
      linkText: "go_to",
      previewDataUrl: "data:image/jpeg;base64,AA==",
    }, { now: new Date("2026-08-08T12:00:00.000Z") });
    assert.equal(draft.groupId, 42);
    assert.equal(draft.linkUrl, "https://vk.com/club42");
  });

  test("story rejects external CTA links and oversized media", () => {
    assert.throws(() => validateStoryDraftInput({
      idempotencyKey: "story_1:42:abc12345", groupId: 42,
      publishAt: "2026-08-09T12:00:00.000Z", groupToken: "x".repeat(40),
      linkUrl: "https://example.com",
    }, { now: new Date("2026-08-08T12:00:00.000Z") }), /vk\.com/i);
    assert.throws(() => validateStoryMedia({
      fileName: "clip.mp4", mimeType: "video/mp4", byteLength: 25 * 1024 * 1024 + 1,
      maxBytes: 25 * 1024 * 1024,
    }), /maximum/i);
  });

  test("public story serializer never exposes token or GridFS internal fields", () => {
    const serialized = publicStoryJob({
      _id: "story-id", groupId: 42, groupName: "Test", status: "queued",
      tokenCiphertext: "cipher", tokenIv: "iv", tokenTag: "tag", mediaId: "gridfs-id",
      toObject() { return { ...this, toObject: undefined }; },
    });
    assert.equal(serialized.id, "story-id");
    for (const field of ["tokenCiphertext", "tokenIv", "tokenTag", "mediaId"]) {
      assert.equal(field in serialized, false);
    }
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npm --prefix server test -- story-validation.test.js`

  Expected: FAIL because `story-validation.js` does not exist.

- [ ] **Step 3: Implement strict validation and the public serializer**

  Use the existing `requirePositiveInteger` style, but keep story-specific code in `story-validation.js`. Enforce 8–200 safe characters for `idempotencyKey`, reject dates not at least 60 seconds in the future or more than 180 days in the future, cap `groupName` at 160 characters, cap a derived JPEG preview data URL at 180,000 characters, and permit a `linkText` only when `linkUrl` exists. Define `ALLOWED_STORY_LINK_TEXTS` as the exact list in Global Constraints and reject any other value.

  ```js
  const ALLOWED_STORY_MIME_TYPES = new Set([
    "image/jpeg", "image/png", "video/mp4", "video/quicktime", "video/webm",
  ]);

  function isInternalVkUrl(value) {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "vk.com" || url.hostname === "www.vk.com");
  }
  ```

  `publicStoryJob` may expose `id`, group metadata, schedule/status/retry/error timestamps, `fileName`, `mimeType`, `byteLength`, `previewDataUrl`, `linkUrl`, `linkText`, and `storyId`. Do not expose `_id` as an object, `mediaId`, or any token data.

- [ ] **Step 4: Run the focused validation tests**

  Run: `npm --prefix server test -- story-validation.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit validation**

  ```powershell
  git add server/src/story-validation.js server/test/story-validation.test.js
  git commit -m "feat: validate scheduled story inputs"
  ```

### Task 2: Add model, GridFS lifecycle, and story service

**Files:**

- Create: `server/src/models/scheduled-story.js`
- Create: `server/src/story-media-store.js`
- Create: `server/src/story-service.js`
- Create: `server/test/story-service.test.js`

**Interfaces:**

- Consumes Task 1 validators and the existing `tokenVault`.
- Produces `createStoryMediaStore({ bucket, maxBytes })` with `save`, `read`, and `remove`.
- Produces `createStoryService({ StoryModel, tokenVault, mediaStore, maxBytes, now })` with `createDraft`, `attachMedia`, `list`, `cancel`, `reschedule`, `retry`, `cleanupExpiredMedia`, and `claimableMedia`.
- `ScheduledStory` states are exactly `uploading`, `queued`, `processing`, `completed`, `failed`, `paused`, and `cancelled`.

- [ ] **Step 1: Write failing service lifecycle tests**

  Create a fake model and fake media store in `server/test/story-service.test.js`. Cover: encryption on draft creation, media gets saved and status becomes `queued`, cancellation deletes media, and an expired failed job has media removed but retains redacted history metadata.

  ```js
  test("cancelling a story removes its GridFS media without exposing a token", async () => {
    const removed = [];
    const service = createStoryService({
      StoryModel: fakeStoryModel({ status: "queued", mediaId: "media-1" }),
      tokenVault: { encrypt: () => ({ tokenCiphertext: "c", tokenIv: "i", tokenTag: "t" }) },
      mediaStore: { async remove(id) { removed.push(String(id)); } },
      maxBytes: 1024,
    });
    const result = await service.cancel("story-1");
    assert.equal(result.removed, true);
    assert.deepEqual(removed, ["media-1"]);
    assert.equal("tokenCiphertext" in result.job, false);
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npm --prefix server test -- story-service.test.js`

  Expected: FAIL because the model, media store, and service do not exist.

- [ ] **Step 3: Implement the data model and indexes**

  Create `scheduled-story.js` with `select: false` on all token fields and `mediaId`, `mediaExpiresAt`, and `expiresAt` fields. Include `kind` as nullable while a draft is `uploading` and restrict it to `photo` or `video` once media is attached; derive it from the validated MIME type (`image/*` → `photo`, `video/*` → `video`). Add these indexes:

  ```js
  scheduledStorySchema.index({ status: 1, publishAt: 1, lockedAt: 1 }, { name: "claim_due_story" });
  scheduledStorySchema.index({ idempotencyKey: 1 }, { unique: true, name: "unique_story_idempotency" });
  scheduledStorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "expire_story_history" });
  scheduledStorySchema.index({ mediaExpiresAt: 1 }, { name: "clean_expired_story_media" });
  ```

  Create `story-media-store.js` around `mongoose.mongo.GridFSBucket`. `save` must reject a Buffer over `maxBytes`, call `bucket.openUploadStream(fileName, { contentType, metadata: { kind: "scheduled-story" } })`, and resolve the resulting GridFS ID. `read` must reject a missing ID or data that grows past `maxBytes`; `remove` must treat a missing file as already removed.

- [ ] **Step 4: Implement the service lifecycle**

  `createDraft` validates input, encrypts `groupToken`, inserts a status `uploading` job with `expiresAt = publishAt + 90 days`, and returns `publicStoryJob`. It must use the same duplicate-key recovery semantics as `comment-service.js`.

  `attachMedia(id, media)` verifies the job is still `uploading`, validates the media, derives `kind`, writes GridFS, atomically sets `{ status: "queued", kind, mediaId, fileName, mimeType, byteLength }`, and removes the newly written media if the database update loses a race.

  `cancel` changes an active job to `cancelled`, deletes media, clears `mediaId`, and never deletes a completed history record. `cleanupExpiredMedia(now)` finds jobs with a non-null `mediaId` and `mediaExpiresAt <= now`, deletes each file, then clears its pointer.

- [ ] **Step 5: Run focused service tests**

  Run: `npm --prefix server test -- story-validation.test.js story-service.test.js`

  Expected: PASS; no fake response or serialization contains `token` or `cipher`.

- [ ] **Step 6: Commit the data layer**

  ```powershell
  git add server/src/models/scheduled-story.js server/src/story-media-store.js server/src/story-service.js server/test/story-service.test.js
  git commit -m "feat: store scheduled story media safely"
  ```

### Task 3: Publish due stories with a serial official-VK worker

**Files:**

- Modify: `server/src/vk-client.js`
- Create: `server/src/story-worker.js`
- Create: `server/test/story-worker.test.js`
- Modify: `server/test/vk-client.test.js`

**Interfaces:**

- Adds `vkClient.createStoryUploadServer({ kind, groupId, groupToken, linkUrl, linkText })`.
- Adds `vkClient.uploadStoryMedia({ uploadUrl, kind, media })`.
- Adds `vkClient.saveCommunityStory({ groupToken, uploadResult })`.
- Produces `createStoryWorker({ StoryModel, tokenVault, mediaStore, vkClient, intervalMs, staleLockMs, logger })` with `runOnce`, `start`, and `stop`.

- [ ] **Step 1: Write failing worker and client tests**

  In `server/test/story-worker.test.js`, imitate `worker.test.js` and prove a code 14 error ends in `paused` without a second call; prove a transient code 10 requeues at a later `publishAt`; prove success deletes `mediaId` and records a returned story ID.

  Extend `server/test/vk-client.test.js` with a mocked `fetchImpl` that verifies `stories.getPhotoUploadServer` uses a form body containing `group_id`, `link_url`, `link_text`, and an access token in the body, not URL. Test `saveCommunityStory` sends only the upload result and token, never the raw file or CTA link.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `npm --prefix server test -- story-worker.test.js vk-client.test.js`

  Expected: FAIL because story client/worker methods do not exist.

- [ ] **Step 3: Add a common safe VK request helper**

  Refactor `vk-client.js` minimally so `createGroupComment` keeps its existing behavior and calls a private `callVkMethod(method, params)` helper. Add the story methods without logging bodies or upload URLs. Use official method names:

  ```js
  const method = kind === "photo"
    ? "stories.getPhotoUploadServer"
    : "stories.getVideoUploadServer";

  await callVkMethod(method, {
    group_id: String(groupId),
    link_text: linkText || undefined,
    link_url: linkUrl || undefined,
  }, groupToken);

  await callVkMethod("stories.save", {
    upload_results: [uploadResult.upload_result].join(","),
  }, groupToken);
  ```

  For the returned upload URL, use `FormData` and `Blob` from Node 20; choose the multipart field name by story kind, and reject a non-JSON/non-success response as a transport error. Keep a 20-second timeout for every request.

- [ ] **Step 4: Implement atomic story-worker transitions**

  Mirror `createCommentWorker`’s lock predicate but use `publishAt` and `ScheduledStory`; call `.select("+tokenCiphertext +tokenIv +tokenTag +mediaId")` on the claimed document. The success path is:

  ```js
  const groupToken = tokenVault.decrypt(job);
  const media = await mediaStore.read(job.mediaId);
  const uploadServer = await vkClient.createStoryUploadServer({ kind: job.kind, groupId: job.groupId, groupToken, linkUrl: job.linkUrl, linkText: job.linkText });
  const uploadResult = await vkClient.uploadStoryMedia({ uploadUrl: uploadServer.upload_url, kind: job.kind, media });
  const saved = await vkClient.saveCommunityStory({ groupToken, uploadResult });
  await mediaStore.remove(job.mediaId);
  ```

  Then update only the held lease with `status: "completed"`, `completedAt`, `storyId`, `mediaId: null`, `lockedAt: null`, `lockId: null`, and cleared error fields. On a failure, write only the safe error message/code; a paused/failed job keeps media for seven days by assigning `mediaExpiresAt`.

- [ ] **Step 5: Run focused worker and client tests**

  Run: `npm --prefix server test -- story-worker.test.js vk-client.test.js worker.test.js`

  Expected: PASS; the existing comment client/worker tests remain unchanged.

- [ ] **Step 6: Commit worker support**

  ```powershell
  git add server/src/vk-client.js server/src/story-worker.js server/test/story-worker.test.js server/test/vk-client.test.js
  git commit -m "feat: publish scheduled stories serially"
  ```

### Task 4: Expose the authenticated story API and wire the server

**Files:**

- Modify: `server/src/app.js`
- Modify: `server/src/config.js`
- Modify: `server/src/server.js`
- Modify: `server/package.json`
- Modify: `server/test/app.test.js`

**Interfaces:**

- Adds endpoints:
  - `POST /api/scheduled-stories` — JSON draft;
  - `PUT /api/scheduled-stories/:id/media` — authenticated raw media;
  - `GET /api/scheduled-stories?status=&limit=` — redacted list;
  - `DELETE /api/scheduled-stories/:id` — cancel/delete media;
  - `PATCH /api/scheduled-stories/:id` — reschedule/retry with `{ publishAt }`.
- Adds config `storyMaxBytes`, `storyMediaRetentionMs`, and `storyHistoryRetentionMs`.

- [ ] **Step 1: Write failing authenticated route tests**

  Extend `server/test/app.test.js` with an injected `storyService` fake. Prove public `/health` still works, unauthenticated story create is 401, a draft response is 201 and has no token-shaped key, a raw `PUT` is accepted only with bearer auth, and a `GET` returns `jobs` not raw model documents.

  ```js
  const response = await fetch(`${baseUrl}/api/scheduled-stories/story-id/media`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${"s".repeat(40)}`,
      "Content-Type": "image/jpeg",
      "X-Story-File-Name": "story.jpg",
    },
    body: Buffer.from([1, 2, 3]),
  });
  assert.equal(response.status, 200);
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npm --prefix server test -- app.test.js`

  Expected: FAIL with a 404 for the new story route.

- [ ] **Step 3: Add bounded raw-media parsing and routes**

  Keep the existing global `express.json({ limit: "32kb" })`. Register the media route on the authenticated router with `express.raw({ type: () => true, limit: config.storyMaxBytes })`; use `request.body.length` and `request.headers["x-story-file-name"]` when calling `storyService.attachMedia`. Do not put media in JSON, base64, query parameters, or logs.

  Normalize known validation errors to 400/413 and return `{ ok: false, error }`; only unexpected errors go through the 500 handler. Update `createApp`’s dependency injection signature to accept `storyService = null` and return a 503 “Story service unavailable” response only when the server was intentionally constructed without it for a narrow test.

- [ ] **Step 4: Wire config, GridFS, workers, and shutdown**

  In `config.js`, add:

  ```js
  storyMaxBytes: Math.max(1_048_576, Number(environment.STORY_MAX_BYTES) || 26_214_400),
  storyMediaRetentionMs: Math.max(60_000, Number(environment.STORY_MEDIA_RETENTION_MS) || 7 * 24 * 60 * 60_000),
  storyHistoryRetentionMs: Math.max(24 * 60 * 60_000, Number(environment.STORY_HISTORY_RETENTION_MS) || 90 * 24 * 60 * 60_000),
  ```

  In `server.js`, construct one `new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "story-media" })`, then create the store, service, and worker. Start/stop the story worker alongside the comment worker. Extend `server/package.json` `check` to run `node --check` for every new `src/story-*.js` file.

- [ ] **Step 5: Run all server tests and syntax checks**

  Run: `npm --prefix server test; npm --prefix server run check`

  Expected: PASS, including comments and all new story tests.

- [ ] **Step 6: Commit API/server wiring**

  ```powershell
  git add server/src/app.js server/src/config.js server/src/server.js server/package.json server/test/app.test.js
  git commit -m "feat: expose encrypted scheduled story API"
  ```

### Task 5: Capture safe local post previews and add a shared extension server client

**Files:**

- Create: `queue-preview-core.js`
- Create: `tests/queue-preview-core.test.js`
- Create: `extension-server-client.js`
- Modify: `background.js:200-310,977-1243`
- Modify: `scheduled.html`
- Modify: `package.json`

**Interfaces:**

- Produces `VkrQueuePreviewCore.capturePostPreview(post) -> { imageUrl, kind, text, sourceUrl }` with no token or raw attachment object.
- Produces `VkrQueuePreviewCore.partitionJobs({ queue, waiting, comments, stories, history }) -> { posts, waiting, comments, stories, failed, history }`.
- Produces global `VkrExtensionServerClient.requestJson` and `VkrExtensionServerClient.uploadStoryMedia`, both of which read only `vkr_server_url` and `vkr_server_api_secret` from local extension storage.

- [ ] **Step 1: Write failing preview capture tests**

  Create `tests/queue-preview-core.test.js`:

  ```js
  "use strict";
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const { capturePostPreview, partitionJobs } = require("../queue-preview-core.js");

  test("capturePostPreview selects the largest safe first photo", () => {
    const preview = capturePostPreview({
      id: 9, owner_id: -42, text: "hello",
      attachments: [{ type: "photo", photo: { sizes: [
        { width: 100, url: "small" }, { width: 600, url: "large" },
      ] } }],
    });
    assert.deepEqual(preview, { imageUrl: "large", kind: "photo", text: "hello", sourceUrl: "https://vk.com/wall-42_9" });
  });

  test("partitionJobs places paused and failed jobs in failures", () => {
    const groups = partitionJobs({ queue: [{ id: "a", status: "paused" }], waiting: [], comments: [], stories: [], history: [] });
    assert.equal(groups.failed.length, 1);
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --test tests/queue-preview-core.test.js`

  Expected: FAIL because `queue-preview-core.js` does not exist.

- [ ] **Step 3: Implement preview capture and browser-to-server helpers**

  Add UMD `queue-preview-core.js`; it must copy only plain strings, truncate text to 600 characters, choose a first photo/video thumbnail URL without fetching it, and never retain `access_token`, attachment access keys, or arbitrary nested objects.

  Add `extension-server-client.js`, loaded in `popup.html` and `scheduled.html` before their page scripts:

  ```js
  async function requestJson(endpoint, { method = "GET", body } = {}) {
    const { vkr_server_url: url, vkr_server_api_secret: secret } = await chrome.storage.local.get(["vkr_server_url", "vkr_server_api_secret"]);
    if (!url || !secret) throw new Error("Сервер историй не настроен.");
    const response = await fetch(`${String(url).replace(/\/+$/, "")}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Сервер ответил HTTP ${response.status}`);
    return payload;
  }
  ```

  `uploadStoryMedia(id, file)` sends an unencoded `ArrayBuffer`/`Blob` body with bearer auth, `Content-Type: file.type`, and an `X-Story-File-Name` header. It must not send or read `vk_token`.

  In `background.js`, call `capturePostPreview(message.post)` inside `sanitizeJob` and store it as `preview`. Add background messages to list, cancel, and reschedule story jobs by calling existing `serverRequest` JSON endpoints.

- [ ] **Step 4: Run focused tests and syntax checks**

  Extend root `package.json` `check:js` to include `node --check queue-preview-core.js` and `node --check extension-server-client.js` before the existing scheduled-page check.

  Run: `node --test tests/queue-preview-core.test.js; npm run check:js`

  Expected: PASS.

- [ ] **Step 5: Commit the preview/data contract**

  ```powershell
  git add queue-preview-core.js extension-server-client.js tests/queue-preview-core.test.js background.js scheduled.html package.json
  git commit -m "feat: add safe queue previews and story client"
  ```

### Task 6: Restore the story composer in the popup

**Files:**

- Modify: `popup.html`
- Modify: `popup.css`
- Modify: `popup-auth.js`

**Interfaces:**

- Consumes `VkrExtensionServerClient.requestJson` and `uploadStoryMedia` from Task 5.
- Calls `POST /api/scheduled-stories`, then `PUT /api/scheduled-stories/:id/media` for each file.
- Uses only local `vkr_group_tokens` entries and their labels for the community selector.

- [ ] **Step 1: Add the story-composer markup**

  Insert a collapsed “Отложенные истории” section after the server configuration. Include an `accept="image/jpeg,image/png,video/mp4,video/quicktime,video/webm"` file input, drop zone, one-community select, date/time input, optional internal VK URL field, CTA select, per-file compact queue, visible 25 MiB limit, and submit button. Add an explicit message: “Истории публикуются токеном сообщества; user token на сервер не отправляется.”

- [ ] **Step 2: Add thumbnail generation and submission code**

  In `popup-auth.js`, maintain `storyFiles` as in-memory `File` objects only. Use a canvas helper that returns a JPEG data URL at at most 480 pixels wide and 160,000 characters. For videos, seek a hidden muted `<video>` element to 0.1 seconds and fall back to a generic video card if no frame can be captured.

  For each file, build a distinct idempotency key and run:

  ```js
  const draft = await VkrExtensionServerClient.requestJson("/api/scheduled-stories", {
    method: "POST",
    body: { idempotencyKey, groupId, groupName, publishAt, groupToken, linkUrl, linkText, previewDataUrl },
  });
  await VkrExtensionServerClient.uploadStoryMedia(draft.job.id, file);
  ```

  On an upload error, call the authenticated `DELETE` endpoint for the new draft, show the file-specific error, and leave the next file untouched unless the user explicitly starts again. Do not write `groupToken`, `vk_token`, `File`, or base64 file data into `chrome.storage`.

- [ ] **Step 3: Manually inspect the constrained interaction**

  Reload the unpacked extension and verify the submit button is disabled until the server settings, one community token, a future date, and at least one accepted file exist. Verify an external link is rejected before network submission and that the selected file counter returns to zero only after every draft/media upload succeeds.

- [ ] **Step 4: Commit the popup composer**

  ```powershell
  git add popup.html popup.css popup-auth.js
  git commit -m "feat: add scheduled story composer"
  ```

### Task 7: Replace the basic scheduler with the preview-rich tabbed manager

**Files:**

- Modify: `scheduled.html`
- Modify: `scheduled.css`
- Modify: `scheduled.js`

**Interfaces:**

- Consumes `VkrQueuePreviewCore`, `VkrExtensionServerClient`, local `vkr_waiting_posts`/`vkr_posts_history`, the publish queue response, redacted comments, and redacted stories.
- Renders tab IDs `posts`, `waiting`, `comments`, `stories`, `failed`, and `history`.
- Uses background messages `list_scheduled_comments`, `delete_scheduled_comment`, `list_scheduled_stories`, `delete_scheduled_story`, and `reschedule_scheduled_story`.

- [ ] **Step 1: Replace the static three-panel HTML with semantic tabs**

  Keep the existing header and dark palette, but replace the basic grid with accessible buttons that carry `data-tab`. Create six `section` containers with matching `id="<tab>-tab"`; add count badges and empty-state templates. Include an “Открыть настройку” action, refresh action, and one compact pause alert above the tabs.

- [ ] **Step 2: Implement safe DOM card renderers**

  Rewrite `scheduled.js` around functions `renderPostCard`, `renderWaitingCard`, `renderCommentCard`, `renderStoryCard`, `renderFailureCard`, and `renderHistoryCard`. Construct every card through `document.createElement` and `textContent`; only use a captured `preview.imageUrl` as an image `src` after validating `https:`.

  A post card must show group target, scheduled time, image/video placeholder, text, result counts, status chip, source link, and clear/retry controls appropriate to state. A story card must use a 9:16 area, display the small `previewDataUrl`/video placeholder, date, group, CTA status, and cancel/reschedule/retry actions. Do not call the VK API while rendering cards.

- [ ] **Step 3: Implement actions, automatic refresh, and counts**

  Fetch data in parallel once per refresh, but use only local storage, background messages, and redacted server list calls. Route a story cancel through `delete_scheduled_story`; retry/reschedule through `reschedule_scheduled_story` and a future datetime dialog. Keep the current `clear_finished_queue` action for posts and add local-history clearing with an explicit confirmation.

  Subscribe to `chrome.storage.onChanged` for local queue/waiting/history changes. Poll the redacted server lists no faster than once per 30 seconds while the tab is visible, and stop the timer on `visibilitychange`/`beforeunload`.

- [ ] **Step 4: Verify page syntax and visual state manually**

  Run: `node --check scheduled.js; npm run check:js`

  Then reload the extension and inspect all six empty states, one queued local post with a preview, one paused job, one comment, and one synthetic/scheduled story. Confirm no card shows a token, secret, raw GridFS ID, or long base64 media data.

- [ ] **Step 5: Commit the restored manager**

  ```powershell
  git add scheduled.html scheduled.css scheduled.js
  git commit -m "feat: restore visual scheduled manager"
  ```

### Task 8: Document deployment, retention, and end-to-end verification

**Files:**

- Modify: `render.yaml`
- Modify: `server/README.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-08-safe-restoration-design.md`

**Interfaces:**

- Declares the Render variables `STORY_MAX_BYTES`, `STORY_MEDIA_RETENTION_MS`, and `STORY_HISTORY_RETENTION_MS`.

- [ ] **Step 1: Add deploy variables and operators’ notes**

  Add to `render.yaml`:

  ```yaml
      - key: STORY_MAX_BYTES
        value: "26214400"
      - key: STORY_MEDIA_RETENTION_MS
        value: "604800000"
      - key: STORY_HISTORY_RETENTION_MS
        value: "7776000000"
  ```

  Explain in `server/README.md` that GridFS is temporary, files are removed after success/cancellation, failed media is kept seven days for retry, and a 512 MB Atlas tier can fill quickly if many 25 MiB videos are held. Explain that community story eligibility and internal VK-link restrictions are enforced by VK.

- [ ] **Step 2: Run full automated verification**

  Run: `npm run verify`

  Expected: all root and server tests pass, and `server/package.json` checks every new source file.

- [ ] **Step 3: Execute the test-environment smoke checklist**

  With a dedicated test community and Render/MongoDB:

  1. Create one photo story 5+ minutes in the future.
  2. Inspect MongoDB: job has encrypted token fields and a GridFS file, never a plaintext group token.
  3. Verify `/api/scheduled-stories` response has only redacted job fields.
  4. Cancel it and verify its GridFS file disappears.
  5. Create another story, let it run, and verify the worker records completion and removes media.
  6. Open the scheduler and verify its preview appears without extra VK API calls.

- [ ] **Step 4: Commit deployment documentation**

  ```powershell
  git add render.yaml server/README.md README.md docs/superpowers/specs/2026-08-08-safe-restoration-design.md
  git commit -m "docs: document scheduled story deployment"
  ```
