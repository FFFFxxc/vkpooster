# Server User Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выполнять будущие посты, комментарии и истории на Render через зашифрованный пользовательский токен и сохранять полноценный черновик каждого поста в «Ожиданиях».

**Architecture:** MongoDB хранит одну серверную задачу публикации с несколькими целевыми сообществами и зашифрованным user token. Worker обрабатывает по одному сообществу за проход, в фактическое время заново читает исходный пост, загружает фотографии в целевую группу и ставит комментарий в серверную очередь. Расширение использует локальную публикацию только для немедленных постов, а future jobs отправляет серверу.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JavaScript, Node.js 20+, Express 5, Mongoose 8, MongoDB, `node:test`.

## Global Constraints

- Токен хранится в MongoDB только через существующий AES-256-GCM vault.
- API и логи не возвращают и не печатают токен.
- Между целевыми сообществами одной задачи проходит не менее 15 секунд.
- Новые future copy jobs не используют `publish_date`.
- `vkr_group_tokens` не удаляется автоматически, но исключается из рабочих меню.
- Все новые функции проходят RED → GREEN и полный `npm run verify`.

---

### Task 1: User-token contracts

**Files:**
- Modify: `server/src/validation.js`
- Modify: `server/src/comment-service.js`
- Modify: `server/src/worker.js`
- Modify: `server/src/vk-client.js`
- Modify: `server/src/story-validation.js`
- Modify: `server/src/story-service.js`
- Modify: `server/src/story-worker.js`
- Test: `server/test/validation.test.js`
- Test: `server/test/worker.test.js`
- Test: `server/test/story-validation.test.js`
- Test: `server/test/story-worker.test.js`
- Test: `server/test/vk-client.test.js`

**Interfaces:**
- Consumes: `tokenVault.encrypt/decrypt`.
- Produces: comment/story payloads with `userToken`; `vkClient.createUserComment()` and user-authorized story methods.

- [ ] **Step 1: Write failing tests** asserting that `userToken` is required, `groupToken` is rejected/ignored, public serializers contain no secret, and VK methods receive `userToken`.
- [ ] **Step 2: Run** `npm --prefix server test` and confirm contract failures mention the missing `userToken` API.
- [ ] **Step 3: Implement minimal renaming** from group credential to user credential without changing encrypted schema fields.
- [ ] **Step 4: Run** `npm --prefix server test` and confirm all server tests pass.

### Task 2: Scheduled post service and worker

**Files:**
- Create: `server/src/models/scheduled-post.js`
- Create: `server/src/post-validation.js`
- Create: `server/src/post-service.js`
- Create: `server/src/post-worker.js`
- Modify: `server/src/vk-client.js`
- Modify: `server/src/app.js`
- Modify: `server/src/server.js`
- Test: `server/test/post-validation.test.js`
- Test: `server/test/post-service.test.js`
- Test: `server/test/post-worker.test.js`
- Test: `server/test/app.test.js`

**Interfaces:**
- Produces: `validateScheduledPostInput(input)`, `publicPostJob(document)`, `createPostService()`, `createPostWorker()`.
- API: `POST/GET/DELETE /api/scheduled-posts`, `POST /api/scheduled-posts/:id/retry`, `DELETE /api/scheduled-posts/:id`.

- [ ] **Step 1: Write failing validation/service tests** for groups, source IDs, publish time, idempotency, encryption, public shape, retry/cancel/purge.
- [ ] **Step 2: Write failing worker tests** for one-community leases, due-time photo copy, 15-second next-group time, comment enqueue and protective pause.
- [ ] **Step 3: Run focused tests** with `node --test server/test/post-*.test.js` and confirm missing-module failures.
- [ ] **Step 4: Implement model, validation, service, VK upload helpers and worker** with one target per lease.
- [ ] **Step 5: Add authenticated routes and runtime wiring**, then run `npm --prefix server test`.

### Task 3: Extension routing and popup cleanup

**Files:**
- Modify: `background.js`
- Modify: `popup.html`
- Modify: `popup-auth.js`
- Modify: `stories.js`
- Modify: `scheduled.js`
- Modify: `scheduled.html`
- Test: `tests/user-first-contract.test.js`
- Test: `tests/popup-account.test.js`
- Test: `tests/stories-contract.test.js`
- Test: `tests/scheduled-results-ui.test.js`

**Interfaces:**
- Future `enqueue_publish` sends `/api/scheduled-posts` with `userToken` and returns a server job.
- Immediate publication sends `/api/scheduled-comments` with `userToken`; local comment queue is fallback only.
- `list_scheduled_posts`, `cancel_scheduled_post`, `retry_scheduled_post` bridge the server API to the scheduled page.

- [ ] **Step 1: Replace old static assertions with failing user-only/server-automation contracts.**
- [ ] **Step 2: Run** `node --test tests/user-first-contract.test.js tests/popup-account.test.js tests/stories-contract.test.js tests/scheduled-results-ui.test.js` and confirm RED.
- [ ] **Step 3: Implement future-server routing, server comment routing and story user token.**
- [ ] **Step 4: Remove group-token and comment-mode controls from popup; build directories only from `vkr_user_groups`.**
- [ ] **Step 5: Merge server posts into the Posts tab and expose retry/cancel.**
- [ ] **Step 6: Run focused extension tests and confirm GREEN.**

### Task 4: Persistent waiting drafts

**Files:**
- Create: `waiting-draft-core.js`
- Modify: `manifest.json`
- Modify: `scheduled.html`
- Modify: `scheduled.js`
- Modify: `scheduled-fixes.css`
- Test: `tests/waiting-draft-core.test.js`
- Test: `tests/scheduled-gallery-ui.test.js`

**Interfaces:**
- Produces: `VkrWaitingDraftCore.normalizeDraft()`, `toLocalDateTime()`, `describeDraft()`.
- Each `vkr_waiting_posts[]` item may contain `draft` and older entries normalize safely.

- [ ] **Step 1: Write failing pure-core tests** for group normalization, date preservation, legacy defaults and readable summary.
- [ ] **Step 2: Run focused tests** and confirm missing-module RED.
- [ ] **Step 3: Implement the pure core and load it on `scheduled.html`.**
- [ ] **Step 4: Save draft on form input/change/close, restore it on open, show time and group names on cards, and add an explicit VK source link.**
- [ ] **Step 5: Run focused tests and confirm GREEN.**

### Task 5: Version, docs, verification and delivery

**Files:**
- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `server/package.json`
- Modify: `server/src/app.js`
- Modify: `README.md`
- Modify: `server/README.md`
- Create: `verification/server-user-automation-v4.5.0/*`

**Interfaces:**
- Extension version: `4.5.0`.
- Server version: `4.3.0`.

- [ ] **Step 1: Update deployment and privacy documentation** with Render environment and token flow.
- [ ] **Step 2: Run** `npm run verify` and record exact pass counts.
- [ ] **Step 3: Generate MODIFIED_FILE, DIFF_FILE.patch, VERIFICATION.txt and executable ROLLBACK.sh.**
- [ ] **Step 4: Apply rollback on another copy, verify baseline behavior and reopen all four artifacts.**
- [ ] **Step 5: Commit and push branch `safe-v4`.**
