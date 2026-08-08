# Safe Community Cleanup Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the wall-post and album-photo cleanup controls with an explicit preview, cancellable sequential deletion, and no user token leaving the browser.

**Architecture:** Keep all cleanup work in the extension. A small pure cleanup core selects the exact immutable items shown in the preview; a pure runner executes an already-approved list sequentially and stops on cancellation or a protective VK error. `background.js` owns the local user token, preview tickets, VK API calls, and progress delivery; `content.js` owns the two confirmation-first modals and the three FAB controls.

**Tech Stack:** Chrome Manifest V3, vanilla JavaScript, `chrome.storage.local`, Node built-in test runner, VK API v5.199.

## Global Constraints

- Node.js is `>=20`; tests run with `node --test`.
- Preserve manifest v3 and the existing `https://vk.com/*`, `https://vk.ru/*`, and `https://api.vk.com/*` scope.
- Do not add `cookies`, `declarativeNetRequest`, `webRequest`, `webRequestBlocking`, `scripting`, or `<all_urls>`.
- The local `vk_token` is used only inside the extension. It must never be included in a Render request, history record, progress event, UI string, or log.
- Delete only with `wall.delete` and `photos.delete`; do not call VK `execute` for cleanup.
- Run one cleanup at a time, one deletion request at a time, with a minimum 1,500 ms delay after each deletion attempt.
- Retry only `classifyVkError(...).action === "retry"`, at most twice, with 5 s then 15 s backoff. Pause immediately on `"pause"`; do not bypass CAPTCHA, validation, or account checks.
- A cleanup preview is valid for 10 minutes and is tied to the originating tab. Starting a run must consume that exact preview rather than re-scan and silently delete a different set.
- Default to preserving a pinned wall post and to deleting only photos owned by the selected community.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `cleanup-core.js` | Pure validation, date-range conversion, preview item selection, and immutable preview-ticket data. Works in Node tests and via `importScripts`. |
| `cleanup-runner.js` | Pure sequential runner with bounded retry, progress snapshots, stop/pause/fail transitions. |
| `tests/cleanup-core.test.js` | Unit tests for ranges, wall attachment ownership, album filtering, and tickets. |
| `tests/cleanup-runner.test.js` | Unit tests for serial order, cancellation, retry, and protective pause. |
| `tests/cleanup-contract.test.js` | Static safety contract for the background/content wiring and absence of `execute`. |
| `background.js` | Stores tickets, fetches previews, invokes the runner using `vkApi`, and sends tab-scoped progress. |
| `content.js` | Restores the two FAB buttons and replaces legacy destructive modal handlers with the approved cleanup protocol. |
| `content.css` | Modal, preview-row, album-selection, progress, and disabled-state styling. |
| `manifest.json` | Loads the two pure helper files in the service worker before `background.js` executes. |
| `README.md` | Documents capability, token boundary, pause behavior, and first-test procedure. |

### Task 1: Build the immutable cleanup preview model

**Files:**

- Create: `cleanup-core.js`
- Create: `tests/cleanup-core.test.js`
- Modify: `background.js:1-20`

**Interfaces:**

- Produces `VkrCleanupCore.normalizeCleanupRange({ dateFrom, dateTo }) -> { fromUnix, toUnix }`.
- Produces `VkrCleanupCore.buildWallPreview({ ownerId, posts, includeOwnedPhotos, keepPinned }) -> { items, sample, counts }`.
- Produces `VkrCleanupCore.buildAlbumPreview({ ownerId, albums, photosByAlbum }) -> { items, sample, counts }`.
- Produces `VkrCleanupCore.createPreviewTicket({ id, kind, tabId, ownerId, items, now }) -> ticket` where `expiresAt === now + 10 * 60_000`.
- `background.js` imports it with `importScripts("safety-core.js", "cleanup-core.js", "cleanup-runner.js")` after Task 2.

- [ ] **Step 1: Write the failing range and ownership tests**

  Create `tests/cleanup-core.test.js` with representative IDs and dates. The test must prove that a pinned post is excluded by default and that a photo attached from another owner is not included:

  ```js
  "use strict";

  const test = require("node:test");
  const assert = require("node:assert/strict");
  const {
    buildWallPreview,
    createPreviewTicket,
    normalizeCleanupRange,
  } = require("../cleanup-core.js");

  test("wall preview keeps a pinned post and external attachment photos", () => {
    const preview = buildWallPreview({
      ownerId: -42,
      includeOwnedPhotos: true,
      keepPinned: true,
      posts: [
        { id: 1, owner_id: -42, date: 1_754_006_400, is_pinned: 1 },
        {
          id: 2,
          owner_id: -42,
          date: 1_754_006_401,
          text: "own post",
          attachments: [
            { type: "photo", photo: { id: 10, owner_id: -42 } },
            { type: "photo", photo: { id: 11, owner_id: -777 } },
          ],
        },
      ],
    });

    assert.deepEqual(preview.items.map((item) => item.postId), [2]);
    assert.deepEqual(preview.items[0].photoIds, [10]);
    assert.equal(preview.counts.posts, 1);
    assert.equal(preview.counts.photos, 1);
  });

  test("range normalisation is inclusive and rejects inverted dates", () => {
    assert.deepEqual(normalizeCleanupRange({
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
    }), { fromUnix: 1_753_977_600, toUnix: 1_754_063_999 });
    assert.throws(() => normalizeCleanupRange({
      dateFrom: "2026-08-02",
      dateTo: "2026-08-01",
    }), /before or equal/i);
  });

  test("preview ticket expires after ten minutes and has no token field", () => {
    const ticket = createPreviewTicket({
      id: "cleanup_preview_a",
      kind: "wall",
      tabId: 7,
      ownerId: -42,
      items: [{ postId: 10, photoIds: [] }],
      now: 1_754_000_000_000,
    });
    assert.equal(ticket.expiresAt, 1_754_000_600_000);
    assert.equal("token" in ticket, false);
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --test tests/cleanup-core.test.js`

  Expected: FAIL with `Cannot find module '../cleanup-core.js'`.

- [ ] **Step 3: Implement the minimal pure core**

  Create `cleanup-core.js` using the same UMD exposure pattern as `safety-core.js`. Use only plain data and no `chrome` reference. The core must normalize the selected community to a negative `ownerId`, retain only posts whose `owner_id` matches it, and extract only `photo.owner_id === ownerId` attachment IDs.

  ```js
  function normalizeCleanupRange({ dateFrom, dateTo }) {
    const from = new Date(`${String(dateFrom)}T00:00:00`);
    const to = new Date(`${String(dateTo)}T23:59:59.999`);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      throw new Error("Cleanup dates must be valid ISO dates");
    }
    if (from > to) throw new Error("dateFrom must be before or equal to dateTo");
    return {
      fromUnix: Math.floor(from.getTime() / 1000),
      toUnix: Math.floor(to.getTime() / 1000),
    };
  }

  function createPreviewTicket({ id, kind, tabId, ownerId, items, now = Date.now() }) {
    return Object.freeze({
      id: String(id), kind, tabId: Number(tabId), ownerId: Number(ownerId),
      items: structuredClone(items), createdAt: now, expiresAt: now + 10 * 60_000,
    });
  }
  ```

  Add `buildWallPreview` and `buildAlbumPreview` with a maximum five sanitized sample entries (`id`, `date`, `text`, `thumbnail`, `albumId`, `albumTitle`) and a stable item shape:

  ```js
  { kind: "wall", postId: 123, photoIds: [4, 5] }
  { kind: "album", photoId: 7, albumId: "wall" }
  ```

- [ ] **Step 4: Run the focused tests to verify they pass**

  Run: `node --test tests/cleanup-core.test.js`

  Expected: PASS for all cleanup-core tests.

- [ ] **Step 5: Commit the tested model**

  ```powershell
  git add cleanup-core.js tests/cleanup-core.test.js
  git commit -m "feat: add safe cleanup preview model"
  ```

### Task 2: Build the cancellable sequential cleanup runner

**Files:**

- Create: `cleanup-runner.js`
- Create: `tests/cleanup-runner.test.js`

**Interfaces:**

- Consumes `classifyVkError` through an injected `classifyError(error)` function.
- Produces `VkrCleanupRunner.runCleanup({ items, deleteItem, classifyError, shouldStop, onProgress, sleep, now }) -> Promise<result>`.
- `result` has exactly `{ status, completed, deleted, skipped, errors, pausedError }`, where `status` is `completed`, `cancelled`, `paused`, or `failed`.

- [ ] **Step 1: Write failing runner tests**

  Create `tests/cleanup-runner.test.js`:

  ```js
  "use strict";

  const test = require("node:test");
  const assert = require("node:assert/strict");
  const { runCleanup } = require("../cleanup-runner.js");

  test("runner deletes exactly one item at a time and reports progress", async () => {
    const calls = [];
    const progress = [];
    const result = await runCleanup({
      items: [{ id: 1 }, { id: 2 }],
      deleteItem: async (item) => calls.push(item.id),
      classifyError: () => ({ action: "fail" }),
      shouldStop: () => false,
      sleep: async () => {},
      onProgress: (event) => progress.push(event),
    });
    assert.deepEqual(calls, [1, 2]);
    assert.equal(result.status, "completed");
    assert.deepEqual(progress.map((event) => event.completed), [1, 2]);
  });

  test("runner pauses without touching later items when VK protection is reported", async () => {
    const calls = [];
    const protection = Object.assign(new Error("Captcha"), { code: 14 });
    const result = await runCleanup({
      items: [{ id: 1 }, { id: 2 }],
      deleteItem: async (item) => {
        calls.push(item.id);
        throw protection;
      },
      classifyError: () => ({ action: "pause", code: 14 }),
      shouldStop: () => false,
      sleep: async () => {},
      onProgress: () => {},
    });
    assert.deepEqual(calls, [1]);
    assert.equal(result.status, "paused");
    assert.equal(result.pausedError.code, 14);
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --test tests/cleanup-runner.test.js`

  Expected: FAIL with `Cannot find module '../cleanup-runner.js'`.

- [ ] **Step 3: Implement bounded retry, cancellation, and progress**

  Create a UMD `cleanup-runner.js`. Before each item and before each retry, evaluate `shouldStop()`. For a retry decision, call `sleep(5_000)` on the first failure and `sleep(15_000)` on the second; after a third retryable failure, record the item in `errors` and continue. For a pause decision, return immediately without touching later items.

  ```js
  async function runCleanup({ items, deleteItem, classifyError, shouldStop,
    onProgress = () => {}, sleep = delay }) {
    const result = { status: "completed", completed: 0, deleted: 0,
      skipped: 0, errors: [], pausedError: null };
    for (const item of items) {
      if (shouldStop()) return { ...result, status: "cancelled" };
      let retry = 0;
      while (true) {
        try {
          await deleteItem(item);
          result.deleted += 1;
          break;
        } catch (error) {
          const decision = classifyError(error);
          if (decision.action === "pause") {
            return { ...result, status: "paused", pausedError: { code: decision.code, message: error.message } };
          }
          if (decision.action !== "retry" || retry >= 2) {
            result.errors.push({ id: item.id ?? item.postId ?? item.photoId, message: String(error.message || "VK error") });
            result.skipped += 1;
            break;
          }
          await sleep(retry === 0 ? 5_000 : 15_000);
          retry += 1;
        }
      }
      result.completed += 1;
      onProgress({ ...result, total: items.length, current: result.completed });
      if (result.completed < items.length) await sleep(1_500);
    }
    return result;
  }
  ```

- [ ] **Step 4: Run focused tests and the existing safety tests**

  Run: `node --test tests/cleanup-runner.test.js tests/safety-core.test.js`

  Expected: PASS; no retry test may show more than two retry delays.

- [ ] **Step 5: Commit the runner**

  ```powershell
  git add cleanup-runner.js tests/cleanup-runner.test.js
  git commit -m "feat: add cancellable cleanup runner"
  ```

### Task 3: Connect preview tickets and deletion to the service worker

**Files:**

- Modify: `background.js:1-1303`
- Modify: `manifest.json:1-60`
- Create: `tests/cleanup-contract.test.js`
- Modify: `tests/manifest-security.test.js:1-90`

**Interfaces:**

- Consumes `VkrCleanupCore` and `VkrCleanupRunner` from Tasks 1–2.
- Adds messages:
  - `cleanup_preview` with `{ kind, ownerId, dateFrom, dateTo, includeOwnedPhotos, keepPinned, albumIds }`;
  - `cleanup_start` with `{ previewId }`;
  - `cleanup_stop` with `{ runId }`.
- Returns preview `{ previewId, kind, counts, sample, albums }` and start `{ runId, started: true }`.
- Emits only to the originating `sender.tab.id`: `cleanup_progress`, `cleanup_finished`, and `cleanup_paused`.

- [ ] **Step 1: Write the failing static safety contract**

  Create `tests/cleanup-contract.test.js`:

  ```js
  "use strict";
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const background = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

  test("cleanup uses ticketed sequential messages and never VK execute", () => {
    for (const message of ["cleanup_preview", "cleanup_start", "cleanup_stop"]) {
      assert.match(background, new RegExp(`type === [\\"']${message}[\\"']`));
    }
    assert.doesNotMatch(background, /vkApi\(\s*["']execute["']/);
    assert.match(background, /chrome\.tabs\.sendMessage\(tabId, \{\s*type: "cleanup_progress"/);
  });
  ```

  In `tests/manifest-security.test.js`, add assertions that `manifest.background.service_worker` is still `background.js`, no forbidden permission was added, and the source never contains `chrome.cookies`.

- [ ] **Step 2: Run the contract test to verify it fails**

  Run: `node --test tests/cleanup-contract.test.js`

  Expected: FAIL because `cleanup_preview` and the new tab-scoped progress event do not exist.

- [ ] **Step 3: Add ticket storage and paginated preview fetches**

  In `background.js`, add constants and in-memory state near the existing queue constants:

  ```js
  const CLEANUP_PREVIEW_TTL_MS = 10 * 60_000;
  const cleanupPreviews = new Map();
  let activeCleanupRun = null;
  ```

  Add `listWallPostsForCleanup`, `listAlbumsForCleanup`, and `listAlbumPhotosForCleanup`. Each uses the existing `vkApi` helper and the local `vk_token`; paginate at `count: 100` for wall posts and `count: 200` for photos. Apply the range while scanning, stop each reverse-ordered album scan once an item is older than `fromUnix`, and add a `1_500 ms` delay between page fetches. Never pass the token to `serverRequest`.

  Build a UUID ticket with `createPreviewTicket`, store it in `cleanupPreviews`, and delete expired tickets before each new action. For `kind === "albums"`, return the selectable album descriptors along with the preview; reject a start if the ticket tab ID does not equal `sender.tab.id` or it has expired.

- [ ] **Step 4: Add the runner-backed start and stop messages**

  Add a `sendCleanupEvent(tabId, event)` helper that catches the expected failure when the tab has gone away. `cleanup_start` must reject when `activeCleanupRun` exists. Convert each ticket item to exactly one `deleteItem` call:

  ```js
  const deleteItem = async (item) => {
    if (item.kind === "wall") {
      await vkApi("wall.delete", { owner_id: ticket.ownerId, post_id: item.postId }, userToken);
      for (const photoId of item.photoIds) {
        await delay(1_500);
        await vkApi("photos.delete", { owner_id: ticket.ownerId, photo_id: photoId }, userToken);
      }
      return;
    }
    await vkApi("photos.delete", { owner_id: ticket.ownerId, photo_id: item.photoId }, userToken);
  };
  ```

  Use `classifyVkError(error.vkError || { code: error.code, transport: error.transport === true })`. Emit redacted event objects containing counts and short error messages only. On `paused`, call the existing `setQueuePause` with the protective error and leave the current cleanup state visible. On `cleanup_stop`, set `activeCleanupRun.stopRequested = true`; do not abort an already in-flight VK request.

- [ ] **Step 5: Run contract and syntax tests**

  Run: `node --test tests/cleanup-contract.test.js tests/manifest-security.test.js; node --check cleanup-core.js; node --check cleanup-runner.js; node --check background.js`

  Expected: PASS; the static contract must show no `execute` call.

- [ ] **Step 6: Commit the worker integration**

  ```powershell
  git add background.js manifest.json tests/cleanup-contract.test.js tests/manifest-security.test.js
  git commit -m "feat: run cleanup previews safely in background"
  ```

### Task 4: Restore the two community cleanup controls and confirmation UI

**Files:**

- Modify: `content.js:1051-1615,3306-3538`
- Modify: `content.css`
- Create: `tests/cleanup-ui-contract.test.js`

**Interfaces:**

- Consumes the three background messages from Task 3 through the existing `sendMessage(type, data)` helper.
- Produces `openBulkDeleteModal(ownerId)` for `kind: "wall"` and `openAlbumCleanModal(ownerId)` for `kind: "albums"`.
- `createFAB()` appends exactly three buttons: best posts, wall cleanup, and album cleanup.

- [ ] **Step 1: Write the failing UI wiring contract**

  Create `tests/cleanup-ui-contract.test.js`:

  ```js
  "use strict";
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

  test("both cleanup FAB actions use the ticketed cleanup protocol", () => {
    assert.match(content, /className = "vkr-fab vkr-fab-delete"/);
    assert.match(content, /className = "vkr-fab vkr-fab-album"/);
    assert.match(content, /sendMessage\("cleanup_preview"/);
    assert.match(content, /sendMessage\("cleanup_start"/);
    assert.match(content, /sendMessage\("cleanup_stop"/);
  });
  ```

- [ ] **Step 2: Run it to verify it fails**

  Run: `node --test tests/cleanup-ui-contract.test.js`

  Expected: FAIL because the old `bulk_delete_*` and `album_clean_*` messages remain.

- [ ] **Step 3: Replace the old destructive modal protocol**

  Replace the old `openBulkDeleteModal` and `openAlbumCleanModal` implementations with one internal `openCleanupModal({ kind, ownerId })`. Reuse safe DOM construction or `textContent` for all VK-returned text; do not place post text, group titles, or error messages into `innerHTML`.

  The wall modal must include period controls, checked-by-default “Оставить закреплённую запись”, unchecked-by-default “Удалить принадлежащие сообществу фото из постов”, sample rows, a red irreversible confirmation checkbox, and a disabled start button until preview + checkbox are complete. The album modal must render the selectable album list returned by `cleanup_preview`, with “Выбрать все” only after the list is visible.

  Use this event flow:

  ```js
  const preview = await sendMessage("cleanup_preview", formData);
  currentPreviewId = preview.previewId;
  // Render preview.counts and preview.sample with textContent.

  const start = await sendMessage("cleanup_start", { previewId: currentPreviewId });
  currentRunId = start.runId;

  await sendMessage("cleanup_stop", { runId: currentRunId });
  ```

  Add a modal-scoped `chrome.runtime.onMessage` listener that ignores any event with a different `runId`, updates progress with `event.completed / event.total`, and leaves a paused/error result visible instead of refreshing the page automatically.

- [ ] **Step 4: Re-enable both FAB buttons safely**

  Remove the early `return` immediately after `document.body.appendChild(fab)` in `createFAB()`. Append the existing red and purple buttons after wiring them to the new modal functions. Keep their `vk.com` and `vk.ru` ID resolution, but normalize the final value with `-Math.abs(Number(groupId))`. Display an instructional error if the current page is not a community or no local user token is configured.

- [ ] **Step 5: Add focused CSS and run static/syntax checks**

  Add namespaced styles in `content.css` for `.vkr-cleanup-sample`, `.vkr-cleanup-album-list`, `.vkr-cleanup-confirm`, `.vkr-cleanup-progress--paused`, and `button:disabled`. Do not change site-wide VK element styles.

  Run: `node --test tests/cleanup-ui-contract.test.js tests/cleanup-contract.test.js; node --check content.js`

  Expected: PASS, and there is no modal auto-reload after completion or pause.

- [ ] **Step 6: Commit the UI restoration**

  ```powershell
  git add content.js content.css tests/cleanup-ui-contract.test.js
  git commit -m "feat: restore safe cleanup controls"
  ```

### Task 5: Document the safety contract and run the regression suite

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-08-safe-restoration-design.md`
- Modify: `package.json`

**Interfaces:**

- Documents the completed cleanup behavior; no runtime interface change.

- [ ] **Step 1: Add the exact user-facing cleanup guidance**

  Add a short “Очистка сообщества” section to `README.md` that says:

  ```markdown
  Очистка стены и фото работает только с локальным пользовательским токеном.
  Расширение сначала показывает конкретное число объектов, затем удаляет их
  последовательно. При CAPTCHA, проверке VK или flood-control операция ставится
  на паузу; не возобновляйте её до завершения проверки в VK.
  ```

  Update the design-spec checklist to mark the cleanup implementation phase complete only after the test commands below pass.

- [ ] **Step 2: Run the complete local verification suite**

  Extend root `package.json` `check:js` to include `node --check cleanup-core.js` and `node --check cleanup-runner.js` before the existing extension scripts.

  Run: `npm run verify`

  Expected: all root and server tests pass, including cleanup-core, cleanup-runner, cleanup contract, manifest security, and JavaScript syntax checks.

- [ ] **Step 3: Perform a manual test on a non-production group**

  In Chrome, reload the unpacked extension, open one test community, and verify:

  1. the red and purple buttons appear once;
  2. preview does not delete anything;
  3. cancel/stop leaves later objects untouched;
  4. a protection/invalid-token error visibly pauses rather than retries;
  5. Chrome DevTools Network shows no request to the Render server while previewing or deleting.

- [ ] **Step 4: Commit docs after verification**

  ```powershell
  git add README.md docs/superpowers/specs/2026-08-08-safe-restoration-design.md package.json
  git commit -m "docs: explain safe community cleanup"
  ```
