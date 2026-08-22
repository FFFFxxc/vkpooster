# Scheduled Editing and Clip Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Редактировать серверную отложку и отдельные комментарии, отменять публикацию по одному паблику и скачивать клипы через перенесённую панель качества.

**Architecture:** Сервер получает узкие PATCH/target-cancel endpoints и сохраняет отменённые цели отдельно от ошибок. Extension вызывает их из новых диалогов; скачивание клипа остаётся локальным browser flow между MAIN-world injection, content bridge и background downloads API.

**Tech Stack:** Chrome Manifest V3, vanilla JS, Node.js, Express, MongoDB/Mongoose, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-23-scheduled-editing-and-clip-download-design.md`

## Global Constraints

- Не изменять уже опубликованные цели.
- Не разрешать изменение документа во время `processing`.
- Не возвращать user token или его зашифрованные поля в API.
- Не возвращать старые cookie/Kate Mobile контуры.
- Скачивать только валидированные HTTPS URL разрешённых VK CDN-хостов.

---

### Task 1: Server edit and per-group cancellation

**Files:**
- Modify: `server/src/post-validation.js`
- Modify: `server/src/models/scheduled-post.js`
- Modify: `server/src/post-service.js`
- Modify: `server/src/post-worker.js`
- Modify: `server/src/app.js`
- Test: `server/test/post-validation.test.js`
- Test: `server/test/post-service.test.js`
- Test: `server/test/post-worker.test.js`
- Test: `server/test/app.test.js`

- [ ] Write failing tests for patch validation, edit status rules, target cancellation and worker skip.
- [ ] Run focused server tests and record the expected failures.
- [ ] Implement update/cancel-target services and routes.
- [ ] Run focused server tests to green.

### Task 2: Comment editing

**Files:**
- Modify: `server/src/validation.js`
- Modify: `server/src/comment-service.js`
- Modify: `server/src/app.js`
- Test: `server/test/comment-service.test.js`
- Test: `server/test/app.test.js`

- [ ] Write failing tests for text/time editing and `processing` rejection.
- [ ] Implement validation, service update and PATCH route.
- [ ] Run focused tests to green.

### Task 3: Extension scheduled UI

**Files:**
- Modify: `background.js`
- Modify: `scheduled.html`
- Modify: `scheduled.css`
- Modify: `scheduled.js`
- Test: `tests/scheduled-results-ui.test.js`
- Test: `tests/user-first-contract.test.js`

- [ ] Write failing contract tests for runtime messages, dialogs and per-group action.
- [ ] Add background message handlers.
- [ ] Add post/comment edit dialogs and target cancellation controls.
- [ ] Run extension focused tests to green.

### Task 4: Clip download restoration

**Files:**
- Copy/adjust: `injection.js` from the 3.3.0 directory.
- Modify: `content.js`
- Modify: `background.js`
- Modify: `popup.html`
- Modify: `popup-auth.js`
- Modify: `manifest.json`
- Test: `tests/manifest-security.test.js`
- Create: `tests/clip-download-contract.test.js`

- [ ] Write failing tests for permission, resources, settings and message bridge.
- [ ] Port the quality panel and content bridge.
- [ ] Implement validated direct downloads in the service worker.
- [ ] Restore the popup toggle and run focused tests to green.

### Task 5: Version, verification, rollback and delivery

**Files:**
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `server/package.json`
- Create: `verification/scheduled-editing-v4.6.0/MODIFIED_FILE`
- Create: `verification/scheduled-editing-v4.6.0/DIFF_FILE.patch`
- Create: `verification/scheduled-editing-v4.6.0/VERIFICATION.txt`
- Create: `verification/scheduled-editing-v4.6.0/ROLLBACK.sh`

- [ ] Run `npm run verify`.
- [ ] Apply the patch to a separate rollback copy, run rollback, and rerun baseline tests.
- [ ] Reopen all four artifacts.
- [ ] Commit and push `safe-v4`.
