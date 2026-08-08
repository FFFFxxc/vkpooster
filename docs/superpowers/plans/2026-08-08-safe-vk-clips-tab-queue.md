# Safe VK Clips Tab Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the dedicated VK Clips page and multi-community workflow while using only one ordinary visible VK tab at a time, never transferring cookies or user tokens to a server.

**Architecture:** The open `clips.html` page retains chosen `File` objects in memory and acts as the source endpoint for a long-lived extension port. A background coordinator persists only redacted job metadata in `chrome.storage.session`, creates one active visible VK Clips tab, and relays bounded base64 chunks between the source page and the tab-scoped content script. The content script automates only the existing logged-in VK upload UI, reports terminal states, and pauses the queue rather than attempting to solve CAPTCHA/protection or opening another tab.

**Tech Stack:** Chrome Manifest V3, `chrome.runtime` ports, `chrome.tabs`, `chrome.storage.session`, vanilla JavaScript/CSS, Node built-in test runner.

## Global Constraints

- Add only the `tabs` extension permission required to create, identify, and close the single worker tab. Do not add `cookies`, `scripting`, `<all_urls>`, `declarativeNetRequest`, or web-request permissions.
- A clip is an actual VK UI upload, not an API fallback. The server and MongoDB do not receive the `File`, browser session, VK token, description, or queue data for clips.
- The coordinator creates one `active: true` tab using `https://vk.ru/clips/...#vkr_clip_job=<id>`; it must not use `chrome.windows.create`, `focused: false`, or multiple active upload tabs.
- A queue source page must remain open. Closing/disconnecting it pauses remaining jobs; no file data is stored in `chrome.storage`, IndexedDB, or sent to Render.
- Persist only metadata: random job ID, source ID, local file ID/name/size/type, group ID/name, description, wall-post option, schedule date, status, progress, timestamps, and safe error text.
- Chunk transfer is ACK-driven and limited to 128 KiB of binary data per chunk before base64 encoding. At most one outstanding chunk exists for one job.
- Content automation uses bounded waits and safe selector fallbacks. It must pause and leave the VK tab open on missing form controls, CAPTCHA, validation, account checks, or a DOM mismatch.
- No human verification step is bypassed, no user token is read by the clip code, and no retry occurs automatically after a protective state.
- Keep only 50 redacted clip history records in `vkr_clips_history`; clear history requires a local user confirmation.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `clip-queue-core.js` | Pure job flattening, validated status transitions, single-active-job selection, and redacted history serialization. |
| `tests/clip-queue-core.test.js` | Unit tests for sequential ordering, allowed transitions, source disconnect pause, and history redaction. |
| `clips.html` | Restored standalone upload/history page, with no account-login or cookie UI. |
| `clips.css` | Dark two-column upload page, group selector, drop zone, file cards, progress, log, and history cards. |
| `clips.js` | In-memory `File` registry, group selection, UI state, source port, base64 chunk producer, and progress/history renderer. |
| `clip-upload-content.js` | VK-only content script that receives a job, rebuilds a Blob, operates the visible upload form, and reports status. |
| `background.js` | Source/tab port registry, persisted metadata queue, visible-tab lifecycle, and one-job coordinator. |
| `manifest.json` | Adds `tabs`, exposes the clips page, and registers `clip-upload-content.js` only for VK Clips URLs. |
| `popup.html`, `popup-auth.js` | Adds “Загрузить клипы” shortcut to the dedicated page. |
| `content.js` | Removes the dormant legacy clip uploader/port listeners so it cannot run beside the new scoped script. |
| `tests/manifest-security.test.js`, `tests/clips-contract.test.js` | Guards against cookies, hidden windows, legacy ports, and unsafe retry behavior. |
| `README.md` | Explains the visible-tab requirement and safe pause behavior. |

### Task 1: Create a testable single-tab clip queue state machine

**Files:**

- Create: `clip-queue-core.js`
- Create: `tests/clip-queue-core.test.js`

**Interfaces:**

- Produces `VkrClipQueueCore.createClipJobs({ sourceId, files, groups, defaults, now }) -> ClipJob[]`.
- Produces `VkrClipQueueCore.nextRunnableJob(jobs) -> ClipJob | null`.
- Produces `VkrClipQueueCore.transitionClipJob(job, event, now) -> ClipJob`.
- Produces `VkrClipQueueCore.toClipHistory(job) -> ClipHistoryRecord`.
- Valid job states: `queued`, `opening_tab`, `transferring`, `uploading`, `completed`, `paused`, `failed`, `cancelled`.

- [ ] **Step 1: Write failing queue-state tests**

  Create `tests/clip-queue-core.test.js`:

  ```js
  "use strict";
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const { createClipJobs, nextRunnableJob, toClipHistory, transitionClipJob } = require("../clip-queue-core.js");

  test("jobs are flattened in file then group order and only one is runnable", () => {
    const jobs = createClipJobs({
      sourceId: "source-a",
      files: [{ id: "file-1", name: "a.mp4", size: 10, type: "video/mp4" }],
      groups: [{ id: 42, name: "Club" }, { id: 43, name: "Club 2" }],
      defaults: { description: "text", wallPost: true }, now: 100,
    });
    assert.deepEqual(jobs.map((job) => job.groupId), [42, 43]);
    assert.equal(nextRunnableJob(jobs).id, jobs[0].id);
    const opening = transitionClipJob(jobs[0], { type: "tab_opened", tabId: 10 }, 101);
    assert.equal(opening.status, "opening_tab");
    assert.equal(nextRunnableJob([opening, jobs[1]]), null);
  });

  test("source disconnection pauses unfinished jobs and history contains no file data", () => {
    const paused = transitionClipJob({ id: "j", status: "uploading", fileId: "file", sourceId: "s", fileName: "x.mp4" }, { type: "source_disconnected" }, 200);
    assert.equal(paused.status, "paused");
    assert.match(paused.error, /страница загрузчика/i);
    const history = toClipHistory({ ...paused, groupToken: "must-not-leak", fileData: "must-not-leak" });
    assert.equal("groupToken" in history, false);
    assert.equal("fileData" in history, false);
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --test tests/clip-queue-core.test.js`

  Expected: FAIL because `clip-queue-core.js` does not exist.

- [ ] **Step 3: Implement the state machine**

  Create `clip-queue-core.js` using the established UMD pattern. Ensure `createClipJobs` normalizes positive group IDs, trims descriptions to 4,096 characters, validates video metadata only (no `File`, blob, token, or data URL), and gives every flattened job its own UUID. `nextRunnableJob` returns a job only when no job is in `opening_tab`, `transferring`, or `uploading`.

  Implement only these valid transitions:

  ```js
  const transitions = {
    queued: ["tab_opened", "cancel", "source_disconnected"],
    opening_tab: ["tab_ready", "pause", "fail", "cancel", "source_disconnected"],
    transferring: ["transfer_progress", "upload_started", "pause", "fail", "cancel", "source_disconnected"],
    uploading: ["upload_progress", "complete", "pause", "fail", "cancel", "source_disconnected"],
  };
  ```

  Invalid transitions must throw, rather than silently creating a second active job.

- [ ] **Step 4: Run focused tests**

  Run: `node --test tests/clip-queue-core.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit the state machine**

  ```powershell
  git add clip-queue-core.js tests/clip-queue-core.test.js
  git commit -m "feat: add single-tab clips queue model"
  ```

### Task 2: Restore the Clips page shell without legacy account handling

**Files:**

- Create: `clips.html`
- Create: `clips.css`
- Create: `clips.js`
- Modify: `popup.html`
- Modify: `popup-auth.js`

**Interfaces:**

- Consumes `VkrClipQueueCore` from Task 1 through a `<script src="clip-queue-core.js">` tag.
- Produces a long-lived `chrome.runtime.connect({ name: "vkr_clips_source" })` source endpoint but does not start transfers until Task 3.
- Popup shortcut opens `chrome.runtime.getURL("clips.html")`.

- [ ] **Step 1: Add the standalone visual page**

  Recreate the useful parts of the old two-column visual layout: left panel for group search/selection, common description, wall-post checkbox, schedule “ladder” controls; right panel for drop zone, per-file cards, start button, log, and a separate history tab. Remove the old account selector, account sync, Kate/VKHost references, and any copy about parallel uploads.

  Add the explicit safety note directly beside the start action:

  ```text
  Клипы публикуются по одному в обычной вкладке VK. Не закрывайте эту страницу
  до завершения очереди. При проверке VK очередь остановится и оставит вкладку открытой.
  ```

- [ ] **Step 2: Implement local file and group UI state**

  In `clips.js`, hold selected files in `const fileRegistry = new Map()` keyed by a random local file ID. Add drag/drop and `input[type=file]` handling that accepts only the allowed video types and rejects a file larger than 2 GiB before it enters the registry. Do not write the `File`, `Blob`, data URL, or description to `chrome.storage`.

  Build group options only from the `list_clip_groups` background message introduced in Task 3. Support search, select all, clear selection, local remembered group IDs under `vkr_clip_group_selection`, common description, per-card override, optional wall-post, and the existing ladder time calculation.

- [ ] **Step 3: Add popup entry point**

  Add a compact “Клипы” action section in `popup.html`; wire its button in `popup-auth.js`:

  ```js
  $("open-clips").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("clips.html") });
  });
  ```

  It must open the extension page only and must not open a VK upload tab itself.

- [ ] **Step 4: Check page scripts**

  Run: `node --check clip-queue-core.js; node --check clips.js; node --check popup-auth.js`

  Expected: PASS. Manually open `clips.html`; it should show the restored visual layout but have a disabled start button until group/file selection exists.

- [ ] **Step 5: Commit the page shell**

  ```powershell
  git add clips.html clips.css clips.js popup.html popup-auth.js
  git commit -m "feat: restore clips upload page"
  ```

### Task 3: Add the background coordinator and source/tab ports

**Files:**

- Modify: `background.js`
- Modify: `manifest.json`
- Create: `tests/clips-contract.test.js`
- Modify: `tests/manifest-security.test.js`

**Interfaces:**

- Consumes `VkrClipQueueCore` via `importScripts("safety-core.js", "cleanup-core.js", "cleanup-runner.js", "clip-queue-core.js")` while preserving existing safe helpers.
- Adds messages `list_clip_groups`, `clips_start`, `clips_list`, `clips_cancel`, and `clips_resume`.
- Uses source port `vkr_clips_source` and tab port `vkr_clip_upload_tab`.
- Stores metadata under `vkr_clips_queue` in `chrome.storage.session` and history under existing `vkr_clips_history` in `chrome.storage.local`.

- [ ] **Step 1: Write the failing no-hidden-tab contract**

  Create `tests/clips-contract.test.js`:

  ```js
  "use strict";
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  test("clips coordinator permits one active normal tab and no cookie automation", () => {
    assert.equal(manifest.permissions.includes("tabs"), true);
    assert.equal(manifest.permissions.includes("cookies"), false);
    assert.equal(manifest.permissions.includes("scripting"), false);
    assert.match(background, /chrome\.tabs\.create\(\{\s*url: clipUrl,\s*active: true/);
    assert.doesNotMatch(background, /chrome\.windows\.create/);
    assert.doesNotMatch(background, /focused:\s*false/);
    assert.match(background, /vkr_clips_source/);
    assert.match(background, /vkr_clip_upload_tab/);
  });
  ```

  Update `tests/manifest-security.test.js` to allow only `tabs` as the new permission; every previous forbidden permission remains forbidden.

- [ ] **Step 2: Run the contract test to verify it fails**

  Run: `node --test tests/clips-contract.test.js tests/manifest-security.test.js`

  Expected: FAIL because the manifest has no `tabs` permission or coordinator.

- [ ] **Step 3: Implement source registration and metadata queue persistence**

  In `background.js`, import the clip core and add `clipSources = new Map()`, `clipUploadTabs = new Map()`, and an in-memory `activeClipJobId`. On `chrome.runtime.onConnect`, accept only the two exact port names. The source first sends `{ type: "register_source", sourceId }`; reject any malformed message. On disconnect, transition all non-terminal jobs with the same `sourceId` using `source_disconnected`, persist them, and notify the user.

  `clips_start` accepts only redacted metadata produced by `createClipJobs`, confirms that the caller has a live registered source port, stores it in `chrome.storage.session`, and calls `startNextClipJob()`.

- [ ] **Step 4: Implement one visible tab lifecycle**

  Use a helper with this exact shape:

  ```js
  async function startNextClipJob() {
    const jobs = await loadClipJobs();
    const job = VkrClipQueueCore.nextRunnableJob(jobs);
    if (!job || activeClipJobId) return;
    const clipUrl = `https://vk.ru/clips/club${job.groupId}#vkr_clip_job=${encodeURIComponent(job.id)}`;
    const tab = await chrome.tabs.create({ url: clipUrl, active: true });
    activeClipJobId = job.id;
    await updateClipJob(job.id, { type: "tab_opened", tabId: tab.id });
  }
  ```

  When the tab port connects, it must identify `jobId`; require it to match the active job and `port.sender.tab.id`. Relay only schema-checked events and chunks between the matching source and tab. On `complete`, close exactly that `tabId`, append `toClipHistory(job)` (capped at 50), clear `activeClipJobId`, then start one next job. On `pause`/`fail`, leave the tab open and clear only `activeClipJobId` so the user can inspect it.

  `list_clip_groups` combines safe local community-token labels with an optional `groups.get` response using the existing local user token; it never returns a token property.

- [ ] **Step 5: Run contracts and syntax checks**

  Run: `node --test tests/clip-queue-core.test.js tests/clips-contract.test.js tests/manifest-security.test.js; node --check background.js`

  Expected: PASS. Confirm `git diff` contains no `chrome.windows.create`, `cookies`, or new Render endpoint for clips.

- [ ] **Step 6: Commit the coordinator**

  ```powershell
  git add background.js manifest.json tests/clips-contract.test.js tests/manifest-security.test.js
  git commit -m "feat: coordinate clips through one visible tab"
  ```

### Task 4: Implement bounded source-to-tab media transfer and VK UI reporting

**Files:**

- Create: `clip-upload-content.js`
- Modify: `clips.js`
- Modify: `manifest.json`
- Modify: `content.js:4717-5968`
- Create: `tests/clip-upload-contract.test.js`

**Interfaces:**

- Source-to-background messages: `source_chunk`, `source_error`, `source_cancelled`.
- Tab-to-background messages: `tab_ready`, `request_chunk`, `chunk_ack`, `transfer_progress`, `upload_progress`, `complete`, `pause`, `fail`.
- Content script accepts only the tab job ID from `location.hash` and only a matching coordinator port.

- [ ] **Step 1: Write the failing scoped-content contract**

  Create `tests/clip-upload-contract.test.js` that reads `clip-upload-content.js` and `content.js`. Assert the new content script uses `vkr_clip_upload_tab`, has `MAX_CHUNK_BYTES = 128 * 1024`, checks `vkr_clip_job`, and emits `pause` on a protection selector. Assert `content.js` no longer contains `vk_clip_upload` or `startClipUploadAutomation`.

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --test tests/clip-upload-contract.test.js`

  Expected: FAIL because the new script does not exist and dormant legacy code remains.

- [ ] **Step 3: Build the source-side ACK-driven producer**

  In `clips.js`, when the coordinator sends `{ type: "source_read", jobId, fileId, offset }`, find the `File` only in `fileRegistry`, read `file.slice(offset, offset + 128 * 1024)`, convert its ArrayBuffer to base64, and send one `{ type: "source_chunk", jobId, offset, totalBytes, base64 }` message. Do not send another chunk until a matching `chunk_ack` arrives. If the page has no file, notify the coordinator with `source_error` and update the file card to paused.

- [ ] **Step 4: Implement the isolated VK content script**

  Register a separate content script matching only `*://vk.com/clips*`, `*://*.vk.com/clips*`, `*://vk.ru/clips*`, and `*://*.vk.ru/clips*`. It connects with `chrome.runtime.connect({ name: "vkr_clip_upload_tab" })`, parses and validates the hash job ID, waits up to 30 seconds for an upload control, then requests chunks sequentially.

  Rebuild the Blob incrementally with `Uint8Array` chunks. Once complete, assign it using a `DataTransfer` to the discovered file input and dispatch `input` and `change` events. Use a short, ordered selector list for description, author/community selection, wall-post switch, schedule control, and final publish button. Every wait must be bounded; selector failure sends:

  ```js
  port.postMessage({
    type: "pause",
    jobId,
    message: "VK изменил форму загрузки или запросил действие в открытой вкладке.",
  });
  ```

  Detect likely CAPTCHA/protection elements by accessible text/known dialog roles and pause immediately. Do not parse cookies, call internal VK endpoints, or use `fetch` in this script.

- [ ] **Step 5: Remove the dormant legacy automation**

  Delete the legacy clip automation block from `content.js` beginning at the safe-mode legacy guard around line 4717 through its old upload-port handlers and DOM automation. Keep the ordinary non-Clips content functionality and the `isClipsPage()` guard. This prevents two scripts from reading file chunks or clicking the same VK form.

- [ ] **Step 6: Run contract and JavaScript checks**

  Run: `node --test tests/clip-upload-contract.test.js tests/clips-contract.test.js; node --check clips.js; node --check clip-upload-content.js; node --check content.js`

  Expected: PASS; no legacy `vk_clip_upload` port remains.

- [ ] **Step 7: Commit the safe transfer implementation**

  ```powershell
  git add clip-upload-content.js clips.js manifest.json content.js tests/clip-upload-contract.test.js
  git commit -m "feat: transfer clips through scoped VK tab"
  ```

### Task 5: Finish user feedback, recovery, history, and documentation

**Files:**

- Modify: `clips.js`
- Modify: `clips.css`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-08-safe-restoration-design.md`
- Modify: `package.json`

**Interfaces:**

- Consumes coordinator status events and persisted redacted `vkr_clips_queue` / `vkr_clips_history` data.
- Does not alter token, cookie, or media transfer interfaces.

- [ ] **Step 1: Render explicit terminal state controls**

  Add per-file state chips and progress bars for queued, opening, transferring, uploading, completed, paused, failed, and cancelled. A paused job gets a “Открыть вкладку VK” action if the recorded tab still exists and a “Отменить” action; it must not show an automatic retry button for protection-related pause. A non-protection failed job may show “Повторить” only after user click, which creates a fresh metadata job and requires the source page/file to remain available.

- [ ] **Step 2: Render redacted history**

  Load `vkr_clips_history` directly from local storage. A history record shows file name, group name, schedule time, final status, and a safe `https://vk.com/clip...` link only when the content script returned a syntactically valid clip ID. It must never display file content, file path, token, port ID, or raw DOM HTML.

- [ ] **Step 3: Document the operational limits**

  Add a “Клипы” section to `README.md` stating that this feature requires an active browser VK session, uses one visible VK tab at a time, stops on CAPTCHA/protection/changed UI, and cannot guarantee publication if VK itself refuses the action. State explicitly that it does not use Kate Mobile, imported cookies, or a server-stored user token.

- [ ] **Step 4: Run the complete automated suite**

  Extend root `package.json` `check:js` to include `node --check clip-queue-core.js`, `node --check clips.js`, and `node --check clip-upload-content.js` before the existing extension scripts.

  Run: `npm run verify`

  Expected: PASS, including manifest security, cleanup tests, clip queue tests, all server tests, and syntax checks for `clips.js`/`clip-upload-content.js` after adding them to the root `check:js` script.

- [ ] **Step 5: Run the manual single-group smoke test**

  With one disposable/test community and a small test video:

  1. Open `clips.html`, select one group and one file.
  2. Start the queue and observe exactly one active VK Clips tab.
  3. Verify the source page shows transfer progress and no network request goes to Render.
  4. If VK presents a challenge, confirm the queue pauses, leaves the tab open, and does not start another tab.
  5. On a successful manual/automated publish, confirm only then that the current tab closes and history contains a redacted result.

- [ ] **Step 6: Commit final clips UX and docs**

  ```powershell
  git add clips.js clips.css README.md docs/superpowers/specs/2026-08-08-safe-restoration-design.md package.json
  git commit -m "docs: explain safe clips queue"
  ```
