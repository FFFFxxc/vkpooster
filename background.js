/**
 * VK Reposter Pro 4 — safe service worker.
 *
 * User tokens never leave this browser. Cookie-based authorization, token
 * impersonation, auto-likes and multi-account automation are intentionally absent.
 */

importScripts("safety-core.js", "cleanup-core.js", "cleanup-runner.js", "clip-queue-core.js", "maintenance-core.js");

const VK_API_VERSION = "5.199";
const PUBLISH_QUEUE_KEY = "vkr_publish_queue";
const POST_HISTORY_KEY = "vkr_posts_history";
const LOCAL_COMMENTS_KEY = "vkr_scheduled_comments";
const GROUP_TOKENS_KEY = "vkr_group_tokens";
const QUEUE_PAUSE_KEY = "vkr_queue_pause";
const DEFAULT_COMMENT_DELAY_SECONDS = 60;
const API_INTERVAL_MS = 1200;
const API_TIMEOUT_MS = 20_000;
const MEDIA_TIMEOUT_MS = 45_000;
const MAX_SOURCE_PHOTO_BYTES = 50 * 1024 * 1024;
const CLIP_QUEUE_KEY = "vkr_clips_queue";
const CLIP_HISTORY_KEY = "vkr_clips_history";
const CLIP_CHUNK_BYTES = 128 * 1024;
const GROUP_ANALYTICS_CACHE_KEY = "vkr_group_analytics_cache";
const GROUP_ANALYTICS_CACHE_TTL_MS = 15 * 60_000;
const GROUP_ANALYTICS_POST_LIMIT = 100;
const CLEANUP_PHOTO_LEDGER_KEY = "vkr_cleanup_photo_ledger_v1";
const CLEANUP_SHORT_COOLDOWN_MS = 15 * 60_000;
const CLEANUP_FLOOD_COOLDOWN_MS = 24 * 60 * 60_000;
const PUBLISH_DUE_ALARM = "vkr_publish_due";

const {
  buildUploadedPhotoAttachment,
  buildReusableAttachments,
  classifyVkError,
  createSerialScheduler,
  hasPostPhotos,
  largestPhotoUrl,
  isUploadedPhotoAttachment,
  nextRunnablePublishJobIndex,
  normalizeQueueJobs,
  selectCredential,
  shouldDeferPhotoPublish,
} = globalThis.VkrSafetyCore;

const {
  PHOTO_DELETE_SOFT_LIMIT,
  PHOTO_DELETE_WINDOW_MS,
  PREVIEW_TTL_MS,
  buildAlbumPreview,
  buildWallPreview,
  capCleanupItemsByPhotoBudget,
  createPreviewTicket,
  normalizeCleanupRange,
  normalizeOwnerId,
  photoDeleteBudget,
} = globalThis.VkrCleanupCore;
const { runCleanup } = globalThis.VkrCleanupRunner;
const {
  createClipJobs,
  nextRunnableJob,
  toClipHistory,
  transitionClipJob,
} = globalThis.VkrClipQueueCore;
const {
  normalizeMaintenanceScope,
  purgeRecords,
} = globalThis.VkrMaintenanceCore;

const vkScheduler = createSerialScheduler({ minIntervalMs: API_INTERVAL_MS });
const storageLocks = new Map();
let publishWorkerRunning = false;
let localCommentsRunning = false;
let localDeletionsRunning = false;
const cleanupPreviews = new Map();
let activeCleanupRun = null;
const clipSources = new Map();
const clipUploadTabs = new Map();
let activeClipJobId = null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isServiceWorkerLifecycleError(error) {
  const message = String(error?.message || error || "");
  return /(?:^|\b)No SW(?:\b|$)|Extension context invalidated|service worker.*(?:stopped|terminated)/i.test(
    message,
  );
}

function runInBackground(label, operation) {
  void Promise.resolve()
    .then(operation)
    .catch((error) => {
      if (isServiceWorkerLifecycleError(error)) return;
      console.warn(`[VKR] ${label} failed`, {
        message: String(error?.message || "Unknown background error").slice(
          0,
          300,
        ),
      });
    });
}

async function withStorageLock(key, operation) {
  while (storageLocks.has(key)) await storageLocks.get(key);

  let release;
  const lock = new Promise((resolve) => {
    release = resolve;
  });
  storageLocks.set(key, lock);

  try {
    return await operation();
  } finally {
    storageLocks.delete(key);
    release();
  }
}

function asVkError(payload) {
  const error = new Error(payload?.error_msg || "VK API error");
  error.code = Number(payload?.error_code) || null;
  error.vkError = payload || null;
  return error;
}

async function vkApi(method, params = {}, token) {
  if (!token || typeof token !== "string") {
    const error = new Error("Не настроен токен для операции VK.");
    error.code = 5;
    throw error;
  }

  return vkScheduler.run(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    const body = new URLSearchParams({
      access_token: token,
      v: VK_API_VERSION,
    });
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== "") {
        body.set(key, String(value));
      }
    }

    try {
      const response = await fetch(`https://api.vk.com/method/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`VK API HTTP ${response.status}`);
        error.transport = true;
        throw error;
      }

      const payload = await response.json();
      if (payload.error) throw asVkError(payload.error);
      return payload.response;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("VK API: превышено время ожидания.");
        timeoutError.transport = true;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });
}

function nonRetryableError(message) {
  const error = new Error(message);
  error.nonRetryable = true;
  return error;
}

function isAllowedHost(hostname, suffixes) {
  const normalized = String(hostname || "").toLowerCase();
  return suffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function checkedHttpsUrl(rawUrl, suffixes, label) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw nonRetryableError(`${label}: VK вернул некорректный адрес.`);
  }
  if (url.protocol !== "https:" || !isAllowedHost(url.hostname, suffixes)) {
    throw nonRetryableError(`${label}: адрес не принадлежит разрешённому домену VK.`);
  }
  return url.href;
}

async function fetchWithTimeout(url, options, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(timeoutMessage);
      timeoutError.transport = true;
      throw timeoutError;
    }
    error.transport = true;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function responseError(message, response) {
  const error = new Error(`${message}: HTTP ${response.status}`);
  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    error.transport = true;
  } else {
    error.nonRetryable = true;
  }
  return error;
}

async function getLocalCredentials() {
  const data = await chrome.storage.local.get([
    GROUP_TOKENS_KEY,
    "vk_token",
  ]);

  return {
    groupTokens: data[GROUP_TOKENS_KEY] || {},
    userToken:
      (typeof data.vk_token === "string" && data.vk_token.trim()) || "",
  };
}

async function getServerConfig() {
  const data = await chrome.storage.local.get([
    "vkr_server_url",
    "vkr_server_api_secret",
  ]);
  return {
    url: String(data.vkr_server_url || "").replace(/\/+$/, ""),
    secret: String(data.vkr_server_api_secret || ""),
  };
}

async function serverRequest(endpoint, options = {}) {
  const { url, secret } = await getServerConfig();
  if (!url) throw new Error("URL сервера не настроен.");
  if (!secret) throw new Error("Секрет сервера не настроен.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}${endpoint}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Сервер ответил HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateBadge() {
  const data = await chrome.storage.local.get([
    PUBLISH_QUEUE_KEY,
    QUEUE_PAUSE_KEY,
  ]);
  if (data[QUEUE_PAUSE_KEY]) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    return;
  }

  const queue = Array.isArray(data[PUBLISH_QUEUE_KEY])
    ? data[PUBLISH_QUEUE_KEY]
    : [];
  const pending = queue.filter((job) =>
    ["queued", "processing", "paused"].includes(job.status),
  ).length;
  await chrome.action.setBadgeText({ text: pending ? String(pending) : "" });
  if (pending) {
    await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  }
}

async function setQueuePause(error, jobId = null, source = "automation") {
  const pause = {
    code: Number(error?.code) || null,
    message:
      error?.message ||
      "VK запросил дополнительную проверку. Очередь остановлена.",
    jobId,
    source,
    pausedAt: Date.now(),
  };
  await chrome.storage.local.set({ [QUEUE_PAUSE_KEY]: pause });
  await updateBadge();
  await chrome.notifications.create(`vkr-paused-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Очередь VK остановлена",
    message: `${pause.message} Продолжите вручную после проверки аккаунта.`,
    priority: 2,
  });
}

function sanitizeJob(message) {
  const groups = [
    ...new Set(
      (Array.isArray(message.groups) ? message.groups : [])
        .map((groupId) => Math.abs(Number(groupId)))
        .filter((groupId) => Number.isSafeInteger(groupId) && groupId > 0),
    ),
  ];
  if (!message.post || !Number.isFinite(Number(message.post.id))) {
    throw new Error("Некорректные данные исходного поста.");
  }
  if (groups.length === 0) throw new Error("Не выбраны сообщества.");

  const pubDate = message.pubDate ? Number(message.pubDate) : null;
  if (pubDate && (!Number.isFinite(pubDate) || pubDate <= Date.now())) {
    throw new Error("Время публикации должно быть в будущем.");
  }

  const mode = message.mode === "repost" ? "repost" : "copy";
  const deferMediaUntilPublish = shouldDeferPhotoPublish({
    post: message.post,
    mode,
    pubDate,
  });

  return {
    id: `pub_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    post: message.post,
    groups,
    mode,
    text: String(message.text || ""),
    pubDate,
    deferMediaUntilPublish,
    processedPhotos: Array.isArray(message.processedPhotos)
      ? message.processedPhotos.length
      : 0,
    autoCommentText: String(message.autoCommentText || "").trim(),
    autoDeleteAfter: Math.max(0, Number(message.autoDeleteAfter) || 0),
    label: String(message.label || `Пост #${message.post.id}`).slice(0, 160),
    status: "queued",
    createdAt: Date.now(),
    results: [],
    progress: { total: groups.length, ok: 0, fail: 0 },
    error: null,
  };
}

function stableRandomId(jobId, groupId) {
  const source = `${jobId}:${groupId}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2_147_483_647 || 1;
}

async function enqueuePublishJob(message) {
  const job = sanitizeJob(message);
  await withStorageLock(PUBLISH_QUEUE_KEY, async () => {
    const data = await chrome.storage.local.get(PUBLISH_QUEUE_KEY);
    const queue = Array.isArray(data[PUBLISH_QUEUE_KEY])
      ? data[PUBLISH_QUEUE_KEY]
      : [];
    queue.push(job);
    await chrome.storage.local.set({ [PUBLISH_QUEUE_KEY]: queue });
  });
  await updateBadge();
  await scheduleNextPublishAlarm();
  runInBackground("Publish queue", () => processPublishQueue());
  return job;
}

async function scheduleNextPublishAlarm(queueOverride = null) {
  const queue = Array.isArray(queueOverride)
    ? queueOverride
    : (await chrome.storage.local.get(PUBLISH_QUEUE_KEY))[PUBLISH_QUEUE_KEY] || [];
  const now = Date.now();
  const publishTimes = queue
    .filter(
      (job) =>
        job?.status === "queued" &&
        job.deferMediaUntilPublish === true &&
        Number(job.pubDate) > now,
    )
    .map((job) => Number(job.pubDate));
  try {
    await chrome.alarms.clear(PUBLISH_DUE_ALARM);
    if (publishTimes.length) {
      await chrome.alarms.create(PUBLISH_DUE_ALARM, {
        when: Math.max(now + 1_000, Math.min(...publishTimes)),
      });
    }
  } catch (error) {
    if (!isServiceWorkerLifecycleError(error)) throw error;
  }
}

async function persistJob(job) {
  await withStorageLock(PUBLISH_QUEUE_KEY, async () => {
    const data = await chrome.storage.local.get(PUBLISH_QUEUE_KEY);
    const queue = Array.isArray(data[PUBLISH_QUEUE_KEY])
      ? data[PUBLISH_QUEUE_KEY]
      : [];
    const index = queue.findIndex((item) => item.id === job.id);
    if (index >= 0) queue[index] = job;
    await chrome.storage.local.set({ [PUBLISH_QUEUE_KEY]: queue });
  });
}

async function writePublishHistory(job) {
  await withStorageLock(POST_HISTORY_KEY, async () => {
    const data = await chrome.storage.local.get(POST_HISTORY_KEY);
    const history = Array.isArray(data[POST_HISTORY_KEY])
      ? data[POST_HISTORY_KEY]
      : [];
    history.unshift({
      id: job.id,
      timestamp: job.completedAt || Date.now(),
      label: job.label,
      type: "publish_job",
      mode: job.mode,
      status: job.status,
      ok: job.results.filter((result) => result.ok).length,
      fail: job.results.filter((result) => !result.ok).length,
      total: job.results.length,
      results: job.results.map(({ gid, ok, postId, error, warning }) => ({
        gid,
        ok,
        postId: postId || null,
        error: error || null,
        warning: warning || null,
      })),
      error: job.error || null,
    });
    await chrome.storage.local.set({ [POST_HISTORY_KEY]: history.slice(0, 100) });
  });
}

async function scheduleLocalComment({
  groupId,
  postId,
  commentText,
  commentAt,
  idempotencyKey,
}) {
  await withStorageLock(LOCAL_COMMENTS_KEY, async () => {
    const data = await chrome.storage.local.get(LOCAL_COMMENTS_KEY);
    const comments = Array.isArray(data[LOCAL_COMMENTS_KEY])
      ? data[LOCAL_COMMENTS_KEY]
      : [];
    if (!comments.some((item) => item.idempotencyKey === idempotencyKey)) {
      comments.push({
        groupId,
        ownerId: -Math.abs(groupId),
        postId,
        commentText,
        commentAt,
        idempotencyKey,
        createdAt: Date.now(),
        attempts: 0,
        allowUserFallback: true,
      });
      await chrome.storage.local.set({ [LOCAL_COMMENTS_KEY]: comments });
    }
  });
}

async function scheduleDelayedComment({
  groupId,
  postId,
  commentText,
  commentAt,
  idempotencyKey,
  groupToken,
}) {
  if (!commentText || !postId) return { scheduled: false };

  if (groupToken) {
    try {
      const result = await serverRequest("/api/scheduled-comments", {
        method: "POST",
        body: {
          idempotencyKey,
          groupId,
          postId,
          commentText,
          commentAt,
          groupToken,
        },
      });
      return { scheduled: true, location: "server", jobId: result.job?.id };
    } catch (error) {
      console.warn("[VKR] Server comment scheduling failed:", error.message);
    }
  }

  await scheduleLocalComment({
    groupId,
    postId,
    commentText,
    commentAt,
    idempotencyKey,
  });
  return { scheduled: true, location: "browser" };
}

async function completePostSideEffects(
  job,
  groupId,
  postId,
  credentialKind,
  credentials,
  publishedAt = Date.now(),
) {
  const warnings = [];
  if (job.autoCommentText && postId) {
    try {
      const storage = await chrome.storage.local.get(
        "vkr_comment_delay_seconds",
      );
      const delaySeconds = Math.max(
        15,
        Number(storage.vkr_comment_delay_seconds) ||
          DEFAULT_COMMENT_DELAY_SECONDS,
      );
      const publicationBase = job.deferMediaUntilPublish
        ? publishedAt
        : job.pubDate || publishedAt;
      const commentAt = publicationBase + delaySeconds * 1000;
      const groupTokenEntry =
        credentials.groupTokens[String(groupId)] ||
        credentials.groupTokens[groupId];
      const groupToken =
        typeof groupTokenEntry === "string"
          ? groupTokenEntry
          : groupTokenEntry?.token || "";
      const scheduled = await scheduleDelayedComment({
        groupId,
        postId,
        commentText: job.autoCommentText,
        commentAt,
        idempotencyKey: `${job.id}:${groupId}:${postId}:comment`,
        groupToken,
      });
      if (scheduled.location === "browser") {
        warnings.push("Комментарий выполнится только пока браузер запущен.");
      }
    } catch (error) {
      warnings.push(`Комментарий не запланирован: ${error.message}`);
    }
  }

  if (job.autoDeleteAfter > 0) {
    if (credentialKind !== "user") {
      warnings.push(
        "Автоудаление пропущено: для него нужен локальный пользовательский токен.",
      );
    } else {
      try {
        await withStorageLock("vkr_scheduled_deletions", async () => {
          const data = await chrome.storage.local.get(
            "vkr_scheduled_deletions",
          );
          const deletions = Array.isArray(data.vkr_scheduled_deletions)
            ? data.vkr_scheduled_deletions
            : [];
          const idempotencyKey = `${job.id}:${groupId}:${postId}:delete`;
          if (
            !deletions.some(
              (item) => item.idempotencyKey === idempotencyKey,
            )
          ) {
            deletions.push({
              ownerId: -groupId,
              postId,
              deleteAt:
                (job.deferMediaUntilPublish
                  ? publishedAt
                  : job.pubDate || publishedAt) + job.autoDeleteAfter,
              idempotencyKey,
            });
            await chrome.storage.local.set({
              vkr_scheduled_deletions: deletions,
            });
          }
        });
      } catch (error) {
        warnings.push(`Автоудаление не запланировано: ${error.message}`);
      }
    }
  }
  return warnings.join(" ") || null;
}

function copyPhotoObjects(post) {
  return (Array.isArray(post?.attachments) ? post.attachments : []).flatMap(
    (attachment) => {
      if (attachment?.type !== "photo") return [];
      const photo =
        attachment.photo && typeof attachment.photo === "object"
          ? attachment.photo
          : attachment;
      return photo && typeof photo === "object" ? [photo] : [];
    },
  );
}

function reusableNonPhotoAttachments(post) {
  const attachments = Array.isArray(post?.attachments) ? post.attachments : [];
  return buildReusableAttachments(
    attachments.filter((attachment) => attachment?.type !== "photo"),
  );
}

function photoIdentity(photo) {
  const ownerId = Number(photo?.owner_id ?? photo?.ownerId);
  const photoId = Number(photo?.id);
  if (!Number.isSafeInteger(ownerId) || !Number.isSafeInteger(photoId)) {
    return "";
  }
  return `${ownerId}_${photoId}`;
}

async function refreshDeferredPhotoSources(job, userToken) {
  if (!job.deferMediaUntilPublish || !hasPostPhotos(job.post)) return;
  const ownerId = Number(job.post?.owner_id);
  const postId = Number(job.post?.id);
  if (!Number.isSafeInteger(ownerId) || !Number.isSafeInteger(postId)) return;

  try {
    const response = await vkApi(
      "wall.getById",
      { posts: `${ownerId}_${postId}` },
      userToken,
    );
    const freshPost = response?.items?.[0] || response?.[0];
    const freshPhotos = new Map(
      copyPhotoObjects(freshPost)
        .map((photo) => [photoIdentity(photo), photo])
        .filter(([identity]) => identity),
    );
    const originalAttachments = Array.isArray(job.post?.attachments)
      ? job.post.attachments
      : [];
    let refreshedCount = 0;
    const attachments = originalAttachments.map((attachment) => {
      if (attachment?.type !== "photo") return attachment;
      const source = attachment.photo || attachment;
      const fresh = freshPhotos.get(photoIdentity(source));
      if (!fresh) return attachment;
      refreshedCount += 1;
      return { ...attachment, photo: fresh };
    });
    if (!refreshedCount) {
      throw new Error("VK не вернул свежие адреса выбранных фотографий.");
    }
    job.post = { ...job.post, attachments };
    job.sourcePhotosRefreshedAt = Date.now();
    await persistJob(job);
  } catch (error) {
    console.warn(
      "[VKR] Could not refresh scheduled photo URLs; using the saved URLs",
      {
        jobId: job.id,
        message: String(error?.message || "Unknown error").slice(0, 300),
      },
    );
  }
}

function mediaCheckpoint(job, groupId, total) {
  if (!job.preparedMedia || typeof job.preparedMedia !== "object") {
    job.preparedMedia = {};
  }
  const key = String(groupId);
  const current = job.preparedMedia[key];
  const valid =
    current?.version === 2 &&
    Number(current.groupId) === Math.abs(Number(groupId)) &&
    Number(current.total) === total &&
    Array.isArray(current.photos) &&
    current.photos.length <= total &&
    current.photos.every(isUploadedPhotoAttachment);
  if (!valid) {
    job.preparedMedia[key] = {
      version: 2,
      groupId: Math.abs(Number(groupId)),
      total,
      photos: [],
      updatedAt: Date.now(),
    };
  }
  return job.preparedMedia[key];
}

async function vkPhotoApi(method, params, token, position) {
  try {
    return await vkApi(method, params, token);
  } catch (error) {
    const code = Number(error?.vkError?.error_code ?? error?.code);
    if (code === 27) {
      const explained = nonRetryableError(
        `Фото ${position}: VK отклонил авторизацию загрузки. Переподключите локальный пользовательский токен — токен сообщества для загрузки фотографий не подходит.`,
      );
      explained.code = 27;
      explained.vkError = error.vkError || null;
      throw explained;
    }
    throw error;
  }
}

async function uploadOwnedWallPhoto(photo, groupId, token, position) {
  const sourceUrl = largestPhotoUrl(photo);
  if (!sourceUrl) {
    throw nonRetryableError(
      `Фото ${position}: у исходного вложения нет файла для безопасного копирования.`,
    );
  }
  const checkedSourceUrl = checkedHttpsUrl(
    sourceUrl,
    ["userapi.com", "vkuserphoto.ru", "vk-cdn.net", "vk.com", "vk.ru"],
    `Фото ${position}`,
  );
  const sourceResponse = await fetchWithTimeout(
    checkedSourceUrl,
    { method: "GET", credentials: "omit", cache: "no-store" },
    MEDIA_TIMEOUT_MS,
    `Фото ${position}: VK слишком долго отдавал исходный файл.`,
  );
  if (!sourceResponse.ok) {
    throw responseError(`Фото ${position}: исходный файл не загружен`, sourceResponse);
  }
  const blob = await sourceResponse.blob();
  if (!blob.size || blob.size > MAX_SOURCE_PHOTO_BYTES) {
    throw nonRetryableError(
      `Фото ${position}: файл пустой или превышает 50 МБ. Пост не опубликован без фотографии.`,
    );
  }
  if (blob.type && !blob.type.toLowerCase().startsWith("image/")) {
    throw nonRetryableError(
      `Фото ${position}: VK вернул не изображение (${blob.type}). Пост остановлен без подстановки исходного вложения.`,
    );
  }

  const uploadServer = await vkPhotoApi(
    "photos.getWallUploadServer",
    { group_id: groupId },
    token,
    position,
  );
  const uploadUrl = checkedHttpsUrl(
    uploadServer?.upload_url,
    ["vk.com", "vk.ru"],
    `Фото ${position}: сервер загрузки`,
  );
  const formData = new FormData();
  formData.append("photo", blob, `vkr-copy-${position}.jpg`);
  const uploadResponse = await fetchWithTimeout(
    uploadUrl,
    { method: "POST", body: formData, credentials: "omit" },
    MEDIA_TIMEOUT_MS,
    `Фото ${position}: сервер VK не завершил загрузку вовремя.`,
  );
  if (!uploadResponse.ok) {
    throw responseError(`Фото ${position}: сервер VK отклонил файл`, uploadResponse);
  }
  let uploaded;
  try {
    uploaded = await uploadResponse.json();
  } catch {
    const error = new Error(
      `Фото ${position}: сервер загрузки VK вернул нечитаемый ответ.`,
    );
    error.transport = true;
    throw error;
  }
  if (!uploaded?.photo || uploaded.server === undefined || !uploaded?.hash) {
    const error = new Error(
      `Фото ${position}: сервер загрузки VK не вернул данные сохранения.`,
    );
    error.transport = true;
    throw error;
  }
  const saved = await vkPhotoApi(
    "photos.saveWallPhoto",
    {
      group_id: groupId,
      photo: uploaded.photo,
      server: uploaded.server,
      hash: uploaded.hash,
    },
    token,
    position,
  );
  if (!Array.isArray(saved) || !saved[0]) {
    const error = new Error(`Фото ${position}: VK не сохранил загруженный файл.`);
    error.transport = true;
    throw error;
  }
  try {
    return buildUploadedPhotoAttachment(saved[0], photo);
  } catch (error) {
    error.nonRetryable = true;
    throw error;
  }
}

async function prepareOwnedCopyAttachments(job, groupId, token) {
  const photos = copyPhotoObjects(job.post);
  const reusable = reusableNonPhotoAttachments(job.post);
  if (!photos.length) return reusable;

  const checkpoint = mediaCheckpoint(job, groupId, photos.length);
  for (let index = checkpoint.photos.length; index < photos.length; index += 1) {
    job.mediaProgress = {
      groupId,
      current: index,
      total: photos.length,
      phase: "uploading",
    };
    await persistJob(job);
    const attachment = await uploadOwnedWallPhoto(
      photos[index],
      groupId,
      token,
      index + 1,
    );
    checkpoint.photos.push(attachment);
    checkpoint.updatedAt = Date.now();
    job.mediaProgress.current = checkpoint.photos.length;
    await persistJob(job);
  }
  job.mediaProgress = {
    groupId,
    current: photos.length,
    total: photos.length,
    phase: "ready",
  };
  await persistJob(job);
  return [...checkpoint.photos, ...reusable];
}

async function publishToGroup(job, groupId, credentials, onPublished) {
  if (job.processedPhotos > 0) {
    throw new Error(
      "Водяные знаки требуют повторной загрузки фото и отключены в безопасном режиме.",
    );
  }

  const sourcePhotos = job.mode === "copy" ? copyPhotoObjects(job.post) : [];
  const photoPostUsesUser = job.mode === "copy" && sourcePhotos.length > 0;
  const configuredEntry =
    credentials.groupTokens[String(groupId)] ||
    credentials.groupTokens[groupId];
  const publishWithUser =
    configuredEntry &&
    typeof configuredEntry === "object" &&
    configuredEntry.publishAs === "user";
  const postWithUser = publishWithUser || photoPostUsesUser;
  const postingGroupTokens = postWithUser
    ? Object.fromEntries(
        Object.entries(credentials.groupTokens).filter(
          ([configuredGroupId]) =>
            String(configuredGroupId) !== String(groupId),
        ),
      )
    : credentials.groupTokens;
  const credential = selectCredential({
    groupId,
    operation: job.mode,
    groupTokens: postingGroupTokens,
    userToken: credentials.userToken,
    allowUserFallback: postWithUser,
  });

  let postId;
  if (job.mode === "repost") {
    const response = await vkApi(
      "wall.repost",
      {
        object: `wall${job.post.owner_id}_${job.post.id}`,
        group_id: groupId,
      },
      credential.token,
    );
    postId = response?.post_id;
  } else {
    const mediaCredential = sourcePhotos.length
      ? selectCredential({
          groupId,
          operation: "upload",
          userToken: credentials.userToken,
        })
      : null;
    const attachments = await prepareOwnedCopyAttachments(
      job,
      groupId,
      mediaCredential?.token || credential.token,
    );
    const params = {
      owner_id: -groupId,
      from_group: 1,
      message: job.text,
      random_id: stableRandomId(job.id, groupId),
    };
    if (attachments.length) params.attachments = attachments.join(",");
    if (job.pubDate && !job.deferMediaUntilPublish) {
      params.publish_date = Math.floor(job.pubDate / 1000);
    }
    const response = await vkApi("wall.post", params, credential.token);
    postId = response?.post_id;
  }

  delete job.mediaProgress;
  const publishedAt = Date.now();

  const checkpoint = {
    gid: groupId,
    ok: true,
    postId,
    credential: credential.kind,
    publishedAt,
    sideEffectsPending: true,
  };
  await onPublished(checkpoint);
  const warning = await completePostSideEffects(
    job,
    groupId,
    postId,
    credential.kind,
    credentials,
    publishedAt,
  );
  return { ...checkpoint, sideEffectsPending: false, warning };
}

async function executePublishJob(job) {
  const credentials = await getLocalCredentials();
  job.results = Array.isArray(job.results) ? job.results : [];

  if (job.deferMediaUntilPublish && !job.sourcePhotosRefreshedAt) {
    await refreshDeferredPhotoSources(job, credentials.userToken);
  }

  for (const groupId of job.groups) {
    const existingIndex = job.results.findIndex(
      (result) => Number(result.gid) === Number(groupId),
    );
    const existing = existingIndex >= 0 ? job.results[existingIndex] : null;
    if (existing?.ok && existing.sideEffectsPending) {
      const warning = await completePostSideEffects(
        job,
        groupId,
        existing.postId,
        existing.credential,
        credentials,
        existing.publishedAt || Date.now(),
      );
      job.results[existingIndex] = {
        ...existing,
        sideEffectsPending: false,
        warning,
      };
      await persistJob(job);
      continue;
    }
    if (existing) {
      continue;
    }

    let attempt = 0;
    while (attempt < 2) {
      try {
        const result = await publishToGroup(
          job,
          groupId,
          credentials,
          async (checkpoint) => {
            job.results.push(checkpoint);
            await persistJob(job);
          },
        );
        const checkpointIndex = job.results.findIndex(
          (item) => Number(item.gid) === Number(groupId),
        );
        job.results[checkpointIndex] = result;
        await persistJob(job);
        break;
      } catch (error) {
        attempt += 1;
        const decision = error.nonRetryable
          ? { action: "fail", code: error.code || null, reason: "media" }
          : classifyVkError(
              error.vkError || {
                code: error.code,
                transport: error.transport === true,
              },
            );

        if (
          decision.action === "retry" &&
          job.mode === "copy" &&
          attempt < 2
        ) {
          await delay(5_000);
          continue;
        }

        if (decision.action === "pause") {
          job.status = "paused";
          job.error = error.message;
          job.pausedGroupId = groupId;
          await setQueuePause(error, job.id, "post");
        } else {
          job.results.push({
            gid: groupId,
            ok: false,
            error: error.message,
            code: error.code || null,
          });
          await persistJob(job);
        }
        break;
      }
    }
    if (job.status === "paused") break;
  }

  const ok = job.results.filter((result) => result.ok).length;
  const fail = job.results.filter((result) => !result.ok).length;
  job.progress = { total: job.groups.length, ok, fail };

  if (job.status !== "paused") {
    job.status = ok > 0 ? "completed" : "failed";
    job.error =
      ok > 0 ? null : job.results.find((result) => !result.ok)?.error;
    job.completedAt = Date.now();
    delete job.pausedGroupId;
    delete job.mediaProgress;
    delete job.preparedMedia;
  }
  delete job.processingStartedAt;
  return job;
}

async function notifyJob(job) {
  const ok = job.results.filter((result) => result.ok).length;
  const fail = job.results.filter((result) => !result.ok).length;
  const paused = job.status === "paused";
  await chrome.notifications.create(`vkr-job-${job.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: paused
      ? "Публикация приостановлена"
      : ok
        ? "Публикация завершена"
        : "Ошибка публикации",
    message: paused
      ? job.error || "VK запросил проверку."
      : `${job.label}: успешно ${ok}, ошибок ${fail}.`,
    priority: paused ? 2 : 1,
  });
}

async function processPublishQueue() {
  if (publishWorkerRunning) return;
  publishWorkerRunning = true;

  try {
    while (true) {
      const pauseData = await chrome.storage.local.get(QUEUE_PAUSE_KEY);
      if (pauseData[QUEUE_PAUSE_KEY]) break;

      let job = null;
      await withStorageLock(PUBLISH_QUEUE_KEY, async () => {
        const data = await chrome.storage.local.get(PUBLISH_QUEUE_KEY);
        const queue = Array.isArray(data[PUBLISH_QUEUE_KEY])
          ? data[PUBLISH_QUEUE_KEY]
          : [];
        const index = nextRunnablePublishJobIndex(queue, Date.now());
        if (index >= 0) {
          job = {
            ...queue[index],
            status: "processing",
            processingStartedAt: new Date().toISOString(),
          };
          queue[index] = job;
          await chrome.storage.local.set({ [PUBLISH_QUEUE_KEY]: queue });
        }
      });
      if (!job) break;

      job = await executePublishJob(job);
      await persistJob(job);
      await writePublishHistory(job);
      await updateBadge();
      await notifyJob(job);
    }
  } finally {
    publishWorkerRunning = false;
    await scheduleNextPublishAlarm();
  }
}

async function recoverQueue() {
  let ambiguousRepost = null;
  await withStorageLock(PUBLISH_QUEUE_KEY, async () => {
    const data = await chrome.storage.local.get(PUBLISH_QUEUE_KEY);
    const rawQueue = Array.isArray(data[PUBLISH_QUEUE_KEY])
      ? data[PUBLISH_QUEUE_KEY]
      : [];
    const prepared = rawQueue.map((job) => {
      const {
        token: _legacyToken,
        processedPhotos: legacyProcessedPhotos,
        ...safeJob
      } = job;
      const preparedJob = {
        ...safeJob,
        processedPhotos: Array.isArray(legacyProcessedPhotos)
          ? legacyProcessedPhotos.length
          : Math.max(0, Number(legacyProcessedPhotos) || 0),
        processingStartedAt:
          job.processingStartedAt ||
          (job.startedAt
            ? new Date(job.startedAt).toISOString()
            : undefined),
      };
      if (
        preparedJob.deferMediaUntilPublish === undefined &&
        preparedJob.status === "queued"
      ) {
        preparedJob.deferMediaUntilPublish = shouldDeferPhotoPublish({
          post: preparedJob.post,
          mode: preparedJob.mode,
          pubDate: preparedJob.pubDate,
        });
      }
      const startedAt = Date.parse(preparedJob.processingStartedAt || "");
      const stale =
        preparedJob.status === "processing" &&
        (!Number.isFinite(startedAt) ||
          Date.now() - startedAt >= 5 * 60_000);
      const unresolvedGroup = (preparedJob.groups || []).find(
        (groupId) =>
          !(preparedJob.results || []).some(
            (result) => Number(result.gid) === Number(groupId),
          ),
      );
      if (
        stale &&
        preparedJob.mode === "repost" &&
        unresolvedGroup !== undefined
      ) {
        preparedJob.status = "paused";
        preparedJob.pausedGroupId = unresolvedGroup;
        preparedJob.pauseReason = "ambiguous_repost";
        preparedJob.error =
          "Результат репоста неизвестен после остановки браузера. Проверьте стену группы перед ручным продолжением.";
        delete preparedJob.processingStartedAt;
        ambiguousRepost ||= {
          code: null,
          message: preparedJob.error,
          jobId: preparedJob.id,
          reason: "ambiguous_repost",
          pausedAt: Date.now(),
        };
      }
      return preparedJob;
    });
    const queue = normalizeQueueJobs(prepared);
    await chrome.storage.local.set({ [PUBLISH_QUEUE_KEY]: queue });
  });
  if (ambiguousRepost) {
    await chrome.storage.local.set({ [QUEUE_PAUSE_KEY]: ambiguousRepost });
  }
  await updateBadge();
  await scheduleNextPublishAlarm();
  runInBackground("Recovered publish queue", () => processPublishQueue());
}

async function processLocalComments() {
  if (localCommentsRunning) return;
  if ((await chrome.storage.local.get(QUEUE_PAUSE_KEY))[QUEUE_PAUSE_KEY]) {
    return;
  }
  localCommentsRunning = true;
  try {
    await withStorageLock(LOCAL_COMMENTS_KEY, async () => {
      const data = await chrome.storage.local.get(LOCAL_COMMENTS_KEY);
      const comments = Array.isArray(data[LOCAL_COMMENTS_KEY])
        ? data[LOCAL_COMMENTS_KEY]
        : [];
      if (!comments.length) return;

      const credentials = await getLocalCredentials();
      const remaining = [];
      for (let index = 0; index < comments.length; index += 1) {
        const item = comments[index];
        if (Number(item.commentAt) > Date.now()) {
          remaining.push(item);
          continue;
        }

        try {
          const groupId =
            item.groupId || Math.abs(Number(item.ownerId));
          const credential = selectCredential({
            groupId,
            operation: "comment",
            groupTokens: credentials.groupTokens,
            userToken: credentials.userToken,
            allowUserFallback: item.allowUserFallback === true,
          });
          await vkApi(
            "wall.createComment",
            {
              owner_id: -Math.abs(Number(groupId)),
              post_id: item.postId,
              message: item.commentText,
              from_group: Math.abs(Number(groupId)),
              guid:
                item.idempotencyKey ||
                `local:${groupId}:${item.postId}:${item.createdAt}`,
            },
            credential.token,
          );
        } catch (error) {
          const decision = classifyVkError(
            error.vkError || {
              code: error.code,
              transport: error.transport === true,
            },
          );
          if (decision.action === "pause") {
            await setQueuePause(error, null, "comment");
            remaining.push(item, ...comments.slice(index + 1));
            break;
          }
          if (
            decision.action === "retry" &&
            Number(item.attempts || 0) < 2
          ) {
            remaining.push({
              ...item,
              attempts: Number(item.attempts || 0) + 1,
              commentAt: Date.now() + 5 * 60_000,
            });
          }
        }
      }
      await chrome.storage.local.set({ [LOCAL_COMMENTS_KEY]: remaining });
    });
  } finally {
    localCommentsRunning = false;
  }
}

async function processLocalDeletions() {
  if (localDeletionsRunning) return;
  if ((await chrome.storage.local.get(QUEUE_PAUSE_KEY))[QUEUE_PAUSE_KEY]) {
    return;
  }
  localDeletionsRunning = true;
  try {
    await withStorageLock("vkr_scheduled_deletions", async () => {
      const data = await chrome.storage.local.get([
        "vkr_scheduled_deletions",
        "vk_token",
      ]);
      const deletions = Array.isArray(data.vkr_scheduled_deletions)
        ? data.vkr_scheduled_deletions
        : [];
      if (!deletions.length || !data.vk_token) return;

      const remaining = [];
      for (let index = 0; index < deletions.length; index += 1) {
        const item = deletions[index];
        if (Number(item.deleteAt) > Date.now()) {
          remaining.push(item);
          continue;
        }
        try {
          await vkApi(
            "wall.delete",
            { owner_id: item.ownerId, post_id: item.postId },
            data.vk_token,
          );
        } catch (error) {
          const decision = classifyVkError(
            error.vkError || {
              code: error.code,
              transport: error.transport === true,
            },
          );
          if (decision.action === "pause") {
            await setQueuePause(error, null, "deletion");
            remaining.push(item, ...deletions.slice(index + 1));
            break;
          }
          remaining.push(item);
        }
      }
      await chrome.storage.local.set({
        vkr_scheduled_deletions: remaining,
      });
    });
  } finally {
    localDeletionsRunning = false;
  }
}

async function loadPost(message) {
  const token = message.token || (await getLocalCredentials()).userToken;
  const match = String(message.postUrl || "").match(/wall(-?\d+_\d+)/);
  if (!match) throw new Error("Не удалось определить ID поста.");

  const response = await vkApi("wall.getById", { posts: match[1] }, token);
  const post = response?.items?.[0] || response?.[0];
  if (!post) throw new Error("Пост не найден или недоступен.");

  const groupsResponse = await vkApi(
    "groups.get",
    { extended: 1, filter: "admin,editor", count: 100 },
    token,
  );
  return {
    post,
    groups: groupsResponse?.items || groupsResponse || [],
  };
}

async function validateUserToken(token) {
  const response = await vkApi(
    "users.get",
    { fields: "photo_50,photo_100,screen_name" },
    token,
  );
  const user = response?.[0];
  if (!user) throw new Error("VK не вернул данные пользователя.");
  return user;
}

async function handleReadOnlyMessage(type, message) {
  const token = message.token || (await getLocalCredentials()).userToken;
  if (type === "resolve_screen_name") {
    const response = await vkApi(
      "utils.resolveScreenName",
      { screen_name: message.screenName },
      token,
    );
    return {
      objectId: response?.object_id,
      objectType: response?.type,
    };
  }
  if (type === "search_best_posts") {
    const response = await vkApi(
      "wall.get",
      {
        owner_id: message.ownerId,
        count: Math.min(100, Number(message.count) || 100),
        offset: Math.max(0, Number(message.offset) || 0),
      },
      token,
    );
    const items = (response?.items || []).filter((post) => {
      const from = Number(message.dateFrom) || 0;
      const to = Number(message.dateTo) || Number.MAX_SAFE_INTEGER;
      return post.date >= from && post.date <= to;
    });
    return { posts: items, hasMore: (response?.items || []).length === 100 };
  }
  if (type === "analyze_activity") {
    const response = await vkApi(
      "wall.get",
      { owner_id: -Math.abs(Number(message.groupId)), count: 100 },
      token,
    );
    const hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      posts: 0,
      engagement: 0,
    }));
    for (const post of response?.items || []) {
      const hour = new Date(post.date * 1000).getHours();
      hourly[hour].posts += 1;
      hourly[hour].engagement +=
        Number(post.likes?.count || 0) +
        Number(post.comments?.count || 0) +
        Number(post.reposts?.count || 0);
    }
    return {
      data: {
        analyzedPosts: response?.items?.length || 0,
        hourly,
        top3: [...hourly]
          .sort((a, b) => b.engagement - a.engagement)
          .slice(0, 3),
      },
    };
  }
  throw new Error("Операция не поддерживается безопасной версией.");
}

function cleanupPhotoLedgerOwnerKey(ownerId) {
  return String(Math.abs(normalizeOwnerId(ownerId)));
}

function cleanupPhotoLedgerEntry(budget) {
  return {
    timestamps: [...budget.timestamps],
    cooldownUntil: budget.cooldownUntil,
    cooldownReason: budget.cooldownReason,
  };
}

async function readCleanupPhotoBudget(ownerId, now = Date.now()) {
  return withStorageLock(CLEANUP_PHOTO_LEDGER_KEY, async () => {
    const ownerKey = cleanupPhotoLedgerOwnerKey(ownerId);
    const data = await chrome.storage.local.get(CLEANUP_PHOTO_LEDGER_KEY);
    const rawLedger = data[CLEANUP_PHOTO_LEDGER_KEY];
    const ledger = rawLedger && typeof rawLedger === "object" && !Array.isArray(rawLedger)
      ? { ...rawLedger }
      : {};
    const budget = photoDeleteBudget(ledger[ownerKey], now);
    if (budget.timestamps.length || budget.cooldownUntil) {
      ledger[ownerKey] = cleanupPhotoLedgerEntry(budget);
    } else {
      delete ledger[ownerKey];
    }
    await chrome.storage.local.set({ [CLEANUP_PHOTO_LEDGER_KEY]: ledger });
    return budget;
  });
}

async function recordCleanupPhotoDeletion(ownerId, now = Date.now()) {
  return withStorageLock(CLEANUP_PHOTO_LEDGER_KEY, async () => {
    const ownerKey = cleanupPhotoLedgerOwnerKey(ownerId);
    const data = await chrome.storage.local.get(CLEANUP_PHOTO_LEDGER_KEY);
    const rawLedger = data[CLEANUP_PHOTO_LEDGER_KEY];
    const ledger = rawLedger && typeof rawLedger === "object" && !Array.isArray(rawLedger)
      ? { ...rawLedger }
      : {};
    const current = photoDeleteBudget(ledger[ownerKey], now);
    const next = photoDeleteBudget({
      timestamps: [...current.timestamps, Number(now)],
      cooldownUntil: current.cooldownUntil,
      cooldownReason: current.cooldownReason,
    }, now);
    ledger[ownerKey] = cleanupPhotoLedgerEntry(next);
    await chrome.storage.local.set({ [CLEANUP_PHOTO_LEDGER_KEY]: ledger });
    return next;
  });
}

async function setCleanupPhotoCooldown(ownerId, error, durationMs, now = Date.now()) {
  return withStorageLock(CLEANUP_PHOTO_LEDGER_KEY, async () => {
    const ownerKey = cleanupPhotoLedgerOwnerKey(ownerId);
    const data = await chrome.storage.local.get(CLEANUP_PHOTO_LEDGER_KEY);
    const rawLedger = data[CLEANUP_PHOTO_LEDGER_KEY];
    const ledger = rawLedger && typeof rawLedger === "object" && !Array.isArray(rawLedger)
      ? { ...rawLedger }
      : {};
    const current = photoDeleteBudget(ledger[ownerKey], now);
    const cooldownUntil = Math.max(
      Number(current.cooldownUntil) || 0,
      Number(now) + Math.max(0, Number(durationMs) || 0),
    );
    const next = photoDeleteBudget({
      timestamps: current.timestamps,
      cooldownUntil,
      cooldownReason: String(error?.message || "VK временно ограничил удаление фотографий"),
    }, now);
    ledger[ownerKey] = cleanupPhotoLedgerEntry(next);
    await chrome.storage.local.set({ [CLEANUP_PHOTO_LEDGER_KEY]: ledger });
    return next;
  });
}

function cleanupPhotoCooldownDuration(error) {
  const code = Number(error?.vkError?.error_code ?? error?.code);
  if (code === 6) return CLEANUP_SHORT_COOLDOWN_MS;
  if (code === 9 || code === 29) return CLEANUP_FLOOD_COOLDOWN_MS;
  return 0;
}

function cleanupPhotoBudgetSummary(
  budget,
  {
    matchedPhotos = 0,
    scheduledPhotos = 0,
    now = Date.now(),
    budgetAlreadyIncludesScheduled = false,
  } = {},
) {
  const matched = Math.max(0, Math.floor(Number(matchedPhotos) || 0));
  const scheduled = Math.max(0, Math.floor(Number(scheduledPhotos) || 0));
  const deferred = Math.max(0, matched - scheduled);
  let nextAvailableAt =
    deferred > 0 && budgetAlreadyIncludesScheduled && budget.remaining > 0
      ? Number(now)
      : deferred > 0
        ? budget.nextAvailableAt
        : null;
  let nextAvailableEstimated = false;
  if (deferred > 0 && !nextAvailableAt && budget.timestamps.length) {
    nextAvailableAt = budget.timestamps[0] + PHOTO_DELETE_WINDOW_MS;
  } else if (deferred > 0 && !nextAvailableAt && scheduled > 0) {
    nextAvailableAt = Number(now) + PHOTO_DELETE_WINDOW_MS;
    nextAvailableEstimated = true;
  }
  return {
    limit: PHOTO_DELETE_SOFT_LIMIT,
    windowMs: PHOTO_DELETE_WINDOW_MS,
    used: budget.used,
    availableNow: budget.remaining,
    scheduled,
    deferred,
    remainingAfterRun: budgetAlreadyIncludesScheduled
      ? budget.remaining
      : Math.max(0, budget.remaining - scheduled),
    nextAvailableAt,
    nextAvailableEstimated,
    isAfterRun: budgetAlreadyIncludesScheduled,
    cooldownUntil: budget.cooldownUntil,
    cooldownReason: budget.cooldownReason,
  };
}

function purgeExpiredCleanupPreviews() {
  const now = Date.now();
  for (const [id, preview] of cleanupPreviews.entries()) {
    if (preview.expiresAt <= now) cleanupPreviews.delete(id);
  }
}

async function sendCleanupEvent(tabId, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    // The user can close or navigate away from the source tab while a cleanup runs.
  }
}

function cleanupTabId(sender) {
  const tabId = Number(sender?.tab?.id);
  if (!Number.isSafeInteger(tabId) || tabId < 0) {
    throw new Error("Очистку можно запускать только со страницы VK.");
  }
  return tabId;
}

async function listWallPostsForCleanup({ ownerId, range, token }) {
  const posts = [];
  for (let offset = 0; ; offset += 100) {
    const response = await vkApi(
      "wall.get",
      { owner_id: ownerId, filter: "all", count: 100, offset },
      token,
    );
    const page = response?.items || [];
    for (const post of page) {
      if (Number(post?.date) >= range.fromUnix && Number(post?.date) <= range.toUnix) {
        posts.push(post);
      }
    }
    if (page.length < 100 || page.every((post) => Number(post?.date) < range.fromUnix)) {
      break;
    }
    await delay(1_500);
  }
  return posts;
}

async function listAlbumsForCleanup(ownerId, token) {
  const response = await vkApi(
    "photos.getAlbums",
    { owner_id: ownerId, need_covers: 1, count: 100 },
    token,
  );
  return [
    { id: "wall", title: "Со стены", size: null },
    ...(response?.items || []).map((album) => ({
      id: album.id,
      title: String(album.title || "Альбом").slice(0, 100),
      size: Number.isFinite(Number(album.size)) ? Number(album.size) : null,
    })),
  ];
}

async function listAlbumPhotosForCleanup({ ownerId, albums, range, token }) {
  const photosByAlbum = {};
  for (const album of albums) {
    const photos = [];
    try {
      for (let offset = 0; ; offset += 200) {
        const response = await vkApi(
          "photos.get",
          { owner_id: ownerId, album_id: album.id, rev: 1, count: 200, offset },
          token,
        );
        const page = response?.items || [];
        for (const photo of page) {
          if (Number(photo?.date) >= range.fromUnix && Number(photo?.date) <= range.toUnix) {
            photos.push(photo);
          }
        }
        if (page.length < 200 || page.every((photo) => Number(photo?.date) < range.fromUnix)) {
          break;
        }
        await delay(1_500);
      }
    } catch (error) {
      const decision = classifyVkError(error.vkError || {
        code: error.code,
        transport: error.transport === true,
      });
      if (decision.action === "pause") throw error;
      photosByAlbum[String(album.id)] = [];
      continue;
    }
    photosByAlbum[String(album.id)] = photos;
    await delay(1_500);
  }
  return photosByAlbum;
}

async function createCleanupPreview(message, sender) {
  purgeExpiredCleanupPreviews();
  const tabId = cleanupTabId(sender);
  const kind = message.kind === "albums" ? "albums" : "wall";
  const ownerId = normalizeOwnerId(message.ownerId);
  const range = normalizeCleanupRange(message);
  const { userToken } = await getLocalCredentials();
  if (!userToken) throw new Error("Сначала добавьте личный токен VK в расширение.");

  let preview;
  let albums = [];
  if (kind === "wall") {
    const posts = await listWallPostsForCleanup({ ownerId, range, token: userToken });
    preview = buildWallPreview({
      ownerId,
      posts,
      includeOwnedPhotos: message.includeOwnedPhotos === true,
      keepPinned: message.keepPinned !== false,
    });
  } else {
    const allAlbums = await listAlbumsForCleanup(ownerId, userToken);
    const allowed = new Set(
      (Array.isArray(message.albumIds) ? message.albumIds : allAlbums.map((album) => album.id))
        .map((id) => String(id)),
    );
    albums = allAlbums.filter((album) => allowed.has(String(album.id)));
    const photosByAlbum = await listAlbumPhotosForCleanup({
      ownerId,
      albums,
      range,
      token: userToken,
    });
    preview = buildAlbumPreview({ ownerId, albums, photosByAlbum });
    albums = allAlbums;
  }

  const previewNow = Date.now();
  const budget = await readCleanupPhotoBudget(ownerId, previewNow);
  const capped = capCleanupItemsByPhotoBudget(preview.items, budget.remaining);
  const photoBudget = cleanupPhotoBudgetSummary(budget, {
    matchedPhotos: capped.matchedCounts.photos,
    scheduledPhotos: capped.counts.photos,
    now: previewNow,
  });
  const baseTicket = createPreviewTicket({
    id: `cleanup_preview_${crypto.randomUUID()}`,
    kind,
    tabId,
    ownerId,
    items: capped.items,
    now: previewNow,
  });
  const ticket = Object.freeze({
    ...baseTicket,
    matchedCounts: Object.freeze({ ...capped.matchedCounts }),
  });
  cleanupPreviews.set(ticket.id, ticket);
  return {
    previewId: ticket.id,
    kind,
    counts: capped.counts,
    matchedCounts: capped.matchedCounts,
    photoBudget,
    sample: preview.sample,
    albums,
    expiresAt: ticket.expiresAt,
  };
}

function cleanupOperations(ticket) {
  return ticket.items.flatMap((item) => {
    if (item.kind === "wall") {
      return [
        { id: `post:${item.postId}`, type: "post", postId: item.postId },
        ...(item.photoIds || []).map((photoId) => ({
          id: `post-photo:${item.postId}:${photoId}`,
          type: "photo",
          photoId,
        })),
      ];
    }
    return [{ id: `album-photo:${item.albumId}:${item.photoId}`, type: "photo", photoId: item.photoId }];
  });
}

async function executeCleanupRun(run, operations, token) {
  let deletedPosts = 0;
  let deletedPhotos = 0;
  try {
    const result = await runCleanup({
      items: operations,
      shouldStop: () => run.stopRequested,
      classifyError: (error) => classifyVkError(error.vkError || {
        code: error.code,
        transport: error.transport === true,
      }),
      deleteItem: async (operation) => {
        if (operation.type === "post") {
          await vkApi("wall.delete", { owner_id: run.ownerId, post_id: operation.postId }, token);
          deletedPosts += 1;
          return;
        }
        try {
          await vkApi("photos.delete", { owner_id: run.ownerId, photo_id: operation.photoId }, token);
        } catch (error) {
          const cooldownDuration = cleanupPhotoCooldownDuration(error);
          if (cooldownDuration > 0) {
            try {
              run.latestPhotoBudget = await setCleanupPhotoCooldown(
                run.ownerId,
                error,
                cooldownDuration,
              );
            } catch (storageError) {
              console.error("[cleanup] Failed to persist VK photo cooldown", storageError);
            }
          }
          throw error;
        }
        deletedPhotos += 1;
        try {
          run.latestPhotoBudget = await recordCleanupPhotoDeletion(run.ownerId);
        } catch (error) {
          run.trackingError = "Счётчик защитной квоты не сохранился. Очистка остановлена, чтобы не превысить лимит.";
          run.stopRequested = true;
          console.error("[cleanup] Failed to persist photo deletion budget", error);
        }
      },
      onProgress: (progress) => {
        void sendCleanupEvent(run.tabId, {
          type: "cleanup_progress",
          runId: run.id,
          kind: run.kind,
          current: progress.current,
          total: progress.total,
          deletedPosts,
          deletedPhotos,
          skipped: progress.skipped,
          errors: progress.errors.slice(-3),
        });
      },
    });
    if (result.status === "paused") {
      const error = Object.assign(new Error(result.pausedError.message), { code: result.pausedError.code });
      await setQueuePause(error, null, "cleanup");
    }
    const finalStatus = run.trackingError && result.status === "completed"
      ? "cancelled"
      : result.status;
    const errors = result.errors.slice(-5);
    if (run.trackingError) errors.push({ id: "quota", message: run.trackingError });
    await sendCleanupEvent(run.tabId, {
      type: "cleanup_finished",
      runId: run.id,
      kind: run.kind,
      status: finalStatus,
      completed: result.completed,
      total: operations.length,
      deletedPosts,
      deletedPhotos,
      skipped: result.skipped,
      errors,
      pausedError: result.pausedError,
      photoBudget: cleanupPhotoBudgetSummary(run.latestPhotoBudget, {
        matchedPhotos: run.matchedPhotos,
        scheduledPhotos: deletedPhotos,
        budgetAlreadyIncludesScheduled: true,
      }),
    });
  } finally {
    if (activeCleanupRun?.id === run.id) activeCleanupRun = null;
  }
}

async function startCleanup(message, sender) {
  purgeExpiredCleanupPreviews();
  const tabId = cleanupTabId(sender);
  const previewId = String(message.previewId || "");
  const ticket = cleanupPreviews.get(previewId);
  if (!ticket || ticket.tabId !== tabId || ticket.expiresAt <= Date.now()) {
    throw new Error("Предпросмотр устарел. Сформируйте его заново.");
  }
  if (activeCleanupRun) throw new Error("Другая очистка уже выполняется. Сначала дождитесь её завершения.");
  const { userToken } = await getLocalCredentials();
  if (!userToken) throw new Error("Сначала добавьте личный токен VK в расширение.");
  const budget = await readCleanupPhotoBudget(ticket.ownerId);
  if (activeCleanupRun) throw new Error("Другая очистка уже выполняется. Сначала дождитесь её завершения.");
  const capped = capCleanupItemsByPhotoBudget(ticket.items, budget.remaining);
  const operations = cleanupOperations({ ...ticket, items: capped.items });
  if (operations.length === 0) {
    throw new Error("Для этого паблика сейчас нет доступных действий. Сформируйте список заново — там будет указано время снятия паузы.");
  }
  const run = {
    id: `cleanup_${crypto.randomUUID()}`,
    tabId,
    kind: ticket.kind,
    ownerId: ticket.ownerId,
    stopRequested: false,
    matchedPhotos: Number(ticket.matchedCounts?.photos) || capped.matchedCounts.photos,
    scheduledPhotos: capped.counts.photos,
    latestPhotoBudget: budget,
    trackingError: null,
  };
  cleanupPreviews.delete(previewId);
  activeCleanupRun = run;
  void executeCleanupRun(run, operations, userToken);
  return {
    started: true,
    runId: run.id,
    total: operations.length,
    counts: capped.counts,
    photoBudget: cleanupPhotoBudgetSummary(budget, {
      matchedPhotos: run.matchedPhotos,
      scheduledPhotos: run.scheduledPhotos,
    }),
  };
}

function stopCleanup(message, sender) {
  const tabId = cleanupTabId(sender);
  if (!activeCleanupRun || activeCleanupRun.tabId !== tabId || activeCleanupRun.id !== message.runId) {
    throw new Error("Активная очистка в этой вкладке не найдена.");
  }
  activeCleanupRun.stopRequested = true;
  return { stopping: true };
}

async function readClipQueue() {
  const data = await chrome.storage.session.get(CLIP_QUEUE_KEY);
  return Array.isArray(data[CLIP_QUEUE_KEY]) ? data[CLIP_QUEUE_KEY] : [];
}

async function writeClipQueue(queue) {
  await chrome.storage.session.set({ [CLIP_QUEUE_KEY]: queue });
}

async function writeClipHistory(job) {
  await withStorageLock(CLIP_HISTORY_KEY, async () => {
    const data = await chrome.storage.local.get(CLIP_HISTORY_KEY);
    const history = Array.isArray(data[CLIP_HISTORY_KEY]) ? data[CLIP_HISTORY_KEY] : [];
    const next = [toClipHistory(job), ...history.filter((item) => item.id !== job.id)].slice(0, 50);
    await chrome.storage.local.set({ [CLIP_HISTORY_KEY]: next });
  });
}

async function updateClipJob(jobId, event) {
  const updated = await withStorageLock(CLIP_QUEUE_KEY, async () => {
    const queue = await readClipQueue();
    const index = queue.findIndex((job) => job.id === jobId);
    if (index < 0) throw new Error("Задание клипа не найдено.");
    const next = transitionClipJob(queue[index], event, Date.now());
    queue[index] = next;
    await writeClipQueue(queue);
    return next;
  });
  if (["completed", "failed", "cancelled"].includes(updated.status)) {
    await writeClipHistory(updated);
  }
  return updated;
}

function getClipSource(sourceId) {
  const source = clipSources.get(String(sourceId || ""));
  if (!source) throw new Error("Страница загрузчика клипов закрыта. Откройте её и запустите очередь заново.");
  return source;
}

async function listClipGroups() {
  const { groupTokens, userToken } = await getLocalCredentials();
  const known = new Map(Object.entries(groupTokens)
    .map(([id, entry]) => ({
      id: Math.abs(Number(id)),
      name: typeof entry === "object" && entry?.label ? String(entry.label) : `Сообщество ${id}`,
      screenName: "",
      photoUrl: typeof entry === "object" ? String(entry?.photoUrl || entry?.photo || "") : "",
    }))
    .filter((group) => Number.isSafeInteger(group.id) && group.id > 0)
    .map((group) => [group.id, group]));
  if (userToken) {
    try {
      const response = await vkApi(
        "groups.get",
        { extended: 1, filter: "admin,editor", count: 100 },
        userToken,
      );
      for (const group of response?.items || []) {
        const id = Math.abs(Number(group?.id));
        if (Number.isSafeInteger(id) && id > 0) {
          known.set(id, {
            id,
            name: String(group.name || `Сообщество ${id}`).slice(0, 160),
            screenName: String(group.screen_name || `club${id}`).slice(0, 100),
            photoUrl: String(group.photo_100 || group.photo_50 || ""),
          });
        }
      }
    } catch {
      // A stale optional user token must not hide communities that have their
      // own locally configured group token.
    }
  }
  for (const group of known.values()) {
    if (group.screenName) continue;
    const entry = groupTokens[String(group.id)] || groupTokens[group.id];
    const token = typeof entry === "string" ? entry : entry?.token;
    if (!token) {
      group.screenName = `club${group.id}`;
      continue;
    }
    try {
      const response = await vkApi(
        "groups.getById",
        { group_ids: group.id, fields: "photo_50,photo_100,screen_name" },
        token,
      );
      const info = response?.groups?.[0] || response?.items?.[0] || response?.[0];
      group.name = String(info?.name || group.name).slice(0, 160);
      group.screenName = String(info?.screen_name || `club${group.id}`).slice(0, 100);
      group.photoUrl = String(info?.photo_100 || info?.photo_50 || group.photoUrl || "");
    } catch {
      group.screenName = `club${group.id}`;
    }
  }
  return [...known.values()].sort((first, second) => first.name.localeCompare(second.name, "ru"));
}

function compactAnalyticsPost(post) {
  return {
    id: Number(post?.id) || null,
    date: Number(post?.date) || 0,
    likes: Math.max(0, Number(post?.likes?.count) || 0),
    views: Math.max(0, Number(post?.views?.count) || 0),
    comments: Math.max(0, Number(post?.comments?.count) || 0),
    reposts: Math.max(0, Number(post?.reposts?.count) || 0),
  };
}

function analyticsVkErrorMessage(error) {
  const code = Number(error?.code ?? error?.error_code) || null;
  if (code === 27) {
    return "VK определил локальный токен как токен сообщества. Для аналитики сохраните именно пользовательский токен и повторите обновление.";
  }
  if (code === 5 || code === 1117) {
    return "Локальный пользовательский токен недействителен или истёк. Переподключите его в настройках расширения.";
  }
  const classification = classifyVkError(error);
  if (classification.action === "pause") {
    return "VK временно ограничил запросы аналитики. Не запускайте обновление повторно сразу — подождите и попробуйте позже.";
  }
  return String(error?.message || "VK не вернул статистику").slice(0, 300);
}

function blocksRemainingAnalytics(error) {
  const code = Number(error?.code ?? error?.error_code) || null;
  const classification = classifyVkError(error);
  return code === 27 || code === 1117 || classification.reason === "auth" || classification.action === "pause";
}

async function getConfiguredGroupAnalytics({ force = false } = {}) {
  const { groupTokens, userToken } = await getLocalCredentials();
  const configured = Object.entries(groupTokens)
    .map(([rawId]) => ({
      groupId: Math.abs(Number(rawId)),
    }))
    .filter(
      (group) =>
        Number.isSafeInteger(group.groupId) && group.groupId > 0,
    )
    .sort((first, second) => first.groupId - second.groupId);

  // wall.get is a read operation on behalf of a user. A community token
  // returns VK error 27 (method unavailable with group auth), even when that
  // token belongs to the target community. Never silently fall back to it.
  const analyticsCredential = configured.length
    ? selectCredential({
      groupId: configured[0].groupId,
      operation: "analytics",
      groupTokens,
      userToken,
    })
    : null;

  const stored = await chrome.storage.local.get(GROUP_ANALYTICS_CACHE_KEY);
  const previous = stored[GROUP_ANALYTICS_CACHE_KEY];
  const cache = {
    version: 1,
    groups:
      previous?.version === 1 && previous.groups && typeof previous.groups === "object"
        ? { ...previous.groups }
        : {},
  };
  const now = Date.now();
  const groups = [];
  let blockingError = "";

  for (const group of configured) {
    const key = String(group.groupId);
    const cached = cache.groups[key];
    const isFresh =
      !force &&
      cached?.fetchedAt &&
      now - Number(cached.fetchedAt) < GROUP_ANALYTICS_CACHE_TTL_MS &&
      Array.isArray(cached.posts);
    if (isFresh) {
      groups.push({ groupId: group.groupId, ...cached, cached: true });
      continue;
    }
    if (blockingError) {
      groups.push({
        groupId: group.groupId,
        posts: Array.isArray(cached?.posts) ? cached.posts : [],
        fetchedAt: Number(cached?.fetchedAt) || null,
        stale: Boolean(cached?.posts),
        error: blockingError,
      });
      continue;
    }
    try {
      const response = await vkApi(
        "wall.get",
        {
          owner_id: -group.groupId,
          filter: "owner",
          count: GROUP_ANALYTICS_POST_LIMIT,
        },
        analyticsCredential.token,
      );
      const entry = {
        fetchedAt: Date.now(),
        posts: (response?.items || []).map(compactAnalyticsPost),
      };
      cache.groups[key] = entry;
      groups.push({ groupId: group.groupId, ...entry, cached: false });
    } catch (error) {
      const readableError = analyticsVkErrorMessage(error);
      if (blocksRemainingAnalytics(error)) blockingError = readableError;
      groups.push({
        groupId: group.groupId,
        posts: Array.isArray(cached?.posts) ? cached.posts : [],
        fetchedAt: Number(cached?.fetchedAt) || null,
        stale: Boolean(cached?.posts),
        error: readableError,
      });
    }
  }

  const configuredIds = new Set(configured.map((group) => String(group.groupId)));
  cache.groups = Object.fromEntries(
    Object.entries(cache.groups).filter(([groupId]) => configuredIds.has(groupId)),
  );
  await chrome.storage.local.set({ [GROUP_ANALYTICS_CACHE_KEY]: cache });
  return {
    groups,
    postLimit: GROUP_ANALYTICS_POST_LIMIT,
    cacheTtlMs: GROUP_ANALYTICS_CACHE_TTL_MS,
    blockingError,
  };
}

async function startNextClipJob() {
  if (activeClipJobId) return;
  const queue = await readClipQueue();
  const job = nextRunnableJob(queue);
  if (!job) return;
  if (!clipSources.has(job.sourceId)) {
    await updateClipJob(job.id, { type: "source_disconnected" });
    return;
  }
  activeClipJobId = job.id;
  let screenName = String(job.groupScreenName || "").trim();
  if (!screenName) {
    try {
      const group = (await listClipGroups()).find((item) => Number(item.id) === Number(job.groupId));
      screenName = group?.screenName || `club${job.groupId}`;
    } catch {
      screenName = `club${job.groupId}`;
    }
  }
  const clipUrl = `https://vk.ru/clips/${encodeURIComponent(screenName)}#vkr_clip_job=${encodeURIComponent(job.id)}`;
  try {
    const tab = await chrome.tabs.create({ url: clipUrl, active: true });
    await updateClipJob(job.id, { type: "tab_opened", tabId: tab.id });
  } catch (error) {
    await updateClipJob(job.id, { type: "pause", error: `Не удалось открыть вкладку VK: ${error.message}` });
    activeClipJobId = null;
  }
}

async function beginClipTransfer(jobId, tabId) {
  const queue = await readClipQueue();
  const job = queue.find((item) => item.id === jobId);
  if (!job || job.status !== "opening_tab") return;
  const tabPort = clipUploadTabs.get(tabId);
  if (!tabPort) return;
  await updateClipJob(job.id, { type: "tab_ready" });
  getClipSource(job.sourceId).postMessage({
    type: "read_chunk", jobId: job.id, fileId: job.fileId, offset: 0, size: CLIP_CHUNK_BYTES,
  });
}

async function relayClipChunk(message, sourceId) {
  const jobId = String(message.jobId || "");
  const queue = await readClipQueue();
  const job = queue.find((item) => item.id === jobId);
  if (!job || job.sourceId !== sourceId || job.status !== "transferring") return;
  const tabPort = clipUploadTabs.get(Number(job.tabId));
  if (!tabPort) {
    await updateClipJob(jobId, { type: "pause", error: "Вкладка загрузки клипа закрыта." });
    activeClipJobId = null;
    return;
  }
  const encoded = String(message.data || "");
  const offset = Number(message.offset);
  const byteLength = Number(message.byteLength);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > CLIP_CHUNK_BYTES || encoded.length > Math.ceil(CLIP_CHUNK_BYTES * 1.4)) {
    await updateClipJob(jobId, { type: "pause", error: "Получен некорректный фрагмент файла." });
    activeClipJobId = null;
    return;
  }
  if (byteLength > 0) {
    await updateClipJob(jobId, { type: "transfer_progress", progress: Math.floor(((offset + byteLength) / job.fileSize) * 99) });
  }
  tabPort.postMessage({ type: "clip_chunk", jobId, offset, byteLength, data: encoded, done: message.done === true, file: { name: job.fileName, type: job.fileType, size: job.fileSize }, description: job.description, wallPost: job.wallPost, publishAt: job.publishAt, groupId: job.groupId, groupName: job.groupName, screenName: job.groupScreenName });
}

async function handleClipTabMessage(port, message) {
  const tabId = Number(port.sender?.tab?.id);
  const jobId = String(message?.jobId || "");
  if (!Number.isSafeInteger(tabId) || !jobId) return;
  const queue = await readClipQueue();
  const job = queue.find((item) => item.id === jobId);
  if (!job || job.tabId !== tabId) return;
  if (message.type === "clip_tab_ready") {
    clipUploadTabs.set(tabId, port);
    if (job.status === "opening_tab") {
      await beginClipTransfer(jobId, tabId);
    } else if (job.status === "transferring") {
      getClipSource(job.sourceId).postMessage({
        type: "read_chunk", jobId, fileId: job.fileId, offset: 0, size: CLIP_CHUNK_BYTES,
      });
    }
  } else if (message.type === "clip_chunk_ack") {
    if (job.status !== "transferring") return;
    getClipSource(job.sourceId).postMessage({ type: "read_chunk", jobId, fileId: job.fileId, offset: Number(message.nextOffset), size: CLIP_CHUNK_BYTES });
  } else if (message.type === "clip_upload_started") {
    if (job.status === "transferring") await updateClipJob(jobId, { type: "upload_started" });
  } else if (message.type === "clip_upload_progress") {
    if (job.status === "uploading") await updateClipJob(jobId, { type: "upload_progress", progress: message.progress });
  } else if (message.type === "clip_terminal") {
    const event = ["complete", "pause", "fail"].includes(message.event) ? message.event : "pause";
    const updated = await updateClipJob(jobId, { type: event, error: message.error, tabId });
    if (event === "complete") {
      try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
    if (activeClipJobId === updated.id) activeClipJobId = null;
    if (event === "complete" || event === "fail") void startNextClipJob().catch(reportClipCoordinatorError);
  }
}

async function handleClipSourceDisconnect(sourceId) {
  clipSources.delete(sourceId);
  let changed = false;
  const updated = await withStorageLock(CLIP_QUEUE_KEY, async () => {
    const queue = await readClipQueue();
    const next = queue.map((job) => {
      if (job.sourceId !== sourceId || ["completed", "failed", "cancelled"].includes(job.status)) return job;
      changed = true;
      return transitionClipJob(job, { type: "source_disconnected" }, Date.now());
    });
    if (changed) await writeClipQueue(next);
    return next;
  });
  if (activeClipJobId && updated.some((job) => job.id === activeClipJobId && job.status === "paused")) activeClipJobId = null;
}

async function handleClipTabDisconnect(tabId) {
  const queue = await readClipQueue();
  const job = queue.find((item) => item.tabId === tabId && ["opening_tab", "transferring", "uploading"].includes(item.status));
  if (!job) return;
  await updateClipJob(job.id, { type: "pause", error: "Связь с вкладкой VK прервана. Проверьте вкладку и возобновите задание вручную.", tabId });
  if (activeClipJobId === job.id) activeClipJobId = null;
}

function reportClipCoordinatorError(error) {
  console.warn("[clips] Coordinator paused after an internal error", {
    message: String(error?.message || "Unknown clip coordinator error").slice(0, 300),
  });
}

async function purgeLocalMaintenanceRecords(scope) {
  const normalizedScope = normalizeMaintenanceScope(scope);
  const counts = { postQueue: 0, postHistory: 0, clipQueue: 0, clipHistory: 0, analyticsCache: 0 };

  await withStorageLock(PUBLISH_QUEUE_KEY, async () => {
    const data = await chrome.storage.local.get(PUBLISH_QUEUE_KEY);
    const result = purgeRecords(data[PUBLISH_QUEUE_KEY], normalizedScope);
    counts.postQueue = result.removedCount;
    if (result.kept.length) {
      await chrome.storage.local.set({ [PUBLISH_QUEUE_KEY]: result.kept });
    } else {
      await chrome.storage.local.remove(PUBLISH_QUEUE_KEY);
    }
  });

  await withStorageLock(POST_HISTORY_KEY, async () => {
    const data = await chrome.storage.local.get(POST_HISTORY_KEY);
    const result = purgeRecords(data[POST_HISTORY_KEY], normalizedScope, { assumeTerminal: true });
    counts.postHistory = result.removedCount;
    if (result.kept.length) {
      await chrome.storage.local.set({ [POST_HISTORY_KEY]: result.kept });
    } else {
      await chrome.storage.local.remove(POST_HISTORY_KEY);
    }
  });

  await withStorageLock(CLIP_HISTORY_KEY, async () => {
    const data = await chrome.storage.local.get(CLIP_HISTORY_KEY);
    const result = purgeRecords(data[CLIP_HISTORY_KEY], normalizedScope, { assumeTerminal: true });
    counts.clipHistory = result.removedCount;
    if (result.kept.length) {
      await chrome.storage.local.set({ [CLIP_HISTORY_KEY]: result.kept });
    } else {
      await chrome.storage.local.remove(CLIP_HISTORY_KEY);
    }
  });

  await withStorageLock(CLIP_QUEUE_KEY, async () => {
    const queue = await readClipQueue();
    const result = purgeRecords(queue, normalizedScope);
    counts.clipQueue = result.removedCount;
    if (result.kept.length) {
      await writeClipQueue(result.kept);
    } else {
      await chrome.storage.session.remove(CLIP_QUEUE_KEY);
    }
  });

  if (normalizedScope === "all") {
    const cache = await chrome.storage.local.get(GROUP_ANALYTICS_CACHE_KEY);
    if (cache[GROUP_ANALYTICS_CACHE_KEY]) counts.analyticsCache = 1;
    await chrome.storage.local.remove(GROUP_ANALYTICS_CACHE_KEY);
  }
  await updateBadge();
  return counts;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "vkr_clips_source") {
    let sourceId = "";
    port.onMessage.addListener((message) => {
      void (async () => {
        if (message?.type === "register_source") {
          const value = String(message.sourceId || "").trim().slice(0, 120);
          if (!value) return;
          sourceId = value;
          clipSources.set(sourceId, port);
          port.postMessage({ type: "source_registered", sourceId });
          void startNextClipJob().catch(reportClipCoordinatorError);
          return;
        }
        if (message?.type === "clip_chunk" && sourceId) await relayClipChunk(message, sourceId);
      })().catch(reportClipCoordinatorError);
    });
    port.onDisconnect.addListener(() => { if (sourceId) void handleClipSourceDisconnect(sourceId).catch(reportClipCoordinatorError); });
    return;
  }
  if (port.name === "vkr_clip_upload_tab") {
    port.onMessage.addListener((message) => { void handleClipTabMessage(port, message).catch(reportClipCoordinatorError); });
    port.onDisconnect.addListener(() => {
      const tabId = Number(port.sender?.tab?.id);
      clipUploadTabs.delete(tabId);
      if (Number.isSafeInteger(tabId)) void handleClipTabDisconnect(tabId).catch(reportClipCoordinatorError);
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  const respond = (operation) => {
    Promise.resolve()
      .then(operation)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error.message || String(error),
          code: error.code || null,
        }),
      );
    return true;
  };

  if (type === "enqueue_publish") {
    return respond(async () => {
      const job = await enqueuePublishJob(message);
      return { queued: true, jobId: job.id };
    });
  }
  if (type === "send_to_groups") {
    return respond(async () => {
      const job = await enqueuePublishJob(message);
      return { queued: true, jobId: job.id, results: [] };
    });
  }
  if (type === "load_post") {
    return respond(() => loadPost(message));
  }
  if (
    ["resolve_screen_name", "search_best_posts", "analyze_activity"].includes(
      type,
    )
  ) {
    return respond(() => handleReadOnlyMessage(type, message));
  }
  if (type === "validate_local_user_token") {
    return respond(async () => {
      const user = await validateUserToken(message.token);
      return { user };
    });
  }
  if (type === "check_server") {
    return respond(async () => {
      const result = await serverRequest("/api/status");
      return { data: result };
    });
  }
  if (type === "cleanup_preview") {
    return respond(() => createCleanupPreview(message, sender));
  }
  if (type === "cleanup_start") {
    return respond(() => startCleanup(message, sender));
  }
  if (type === "cleanup_stop") {
    return respond(() => stopCleanup(message, sender));
  }
  if (type === "list_clip_groups") {
    return respond(async () => ({ groups: await listClipGroups() }));
  }
  if (type === "get_group_analytics") {
    return respond(() =>
      getConfiguredGroupAnalytics({ force: message.force === true }),
    );
  }
  if (type === "clips_list") {
    return respond(async () => {
      const [queue, data] = await Promise.all([
        readClipQueue(),
        chrome.storage.local.get(CLIP_HISTORY_KEY),
      ]);
      return { queue, history: data[CLIP_HISTORY_KEY] || [] };
    });
  }
  if (type === "clips_clear_history") {
    return respond(async () => {
      await withStorageLock(CLIP_QUEUE_KEY, async () => {
        const queue = await readClipQueue();
        const result = purgeRecords(queue, "all");
        if (result.kept.length) await writeClipQueue(result.kept);
        else await chrome.storage.session.remove(CLIP_QUEUE_KEY);
      });
      await chrome.storage.local.remove(CLIP_HISTORY_KEY);
      return { cleared: true };
    });
  }
  if (type === "purge_maintenance") {
    return respond(async () => {
      const scope = normalizeMaintenanceScope(message.scope);
      const local = await purgeLocalMaintenanceRecords(scope);
      const warnings = [];
      let comments = { removedJobs: 0 };
      let stories = { removedJobs: 0, removedMedia: 0, retainedJobs: 0, hasMore: false };
      try {
        comments = await serverRequest(
          `/api/scheduled-comments?scope=${encodeURIComponent(scope)}`,
          { method: "DELETE" },
        );
      } catch (error) {
        warnings.push(`Комментарии на сервере не очищены: ${error.message}`);
      }
      try {
        stories = await serverRequest(
          `/api/scheduled-stories?scope=${encodeURIComponent(scope)}`,
          { method: "DELETE" },
        );
      } catch (error) {
        warnings.push(`Истории на сервере не очищены: ${error.message}`);
      }
      if (stories.hasMore) {
        warnings.push("На сервере осталось больше 100 записей Историй. Нажмите очистку ещё раз.");
      }
      if (Number(stories.retainedJobs) > 0) {
        warnings.push(`Не удалось удалить медиа у ${stories.retainedJobs} Историй; записи сохранены для безопасного повтора.`);
      }
      return { cleared: true, scope, local, comments, stories, warnings };
    });
  }
  if (type === "clips_start") {
    return respond(async () => {
      const sourceId = String(message.sourceId || "");
      getClipSource(sourceId);
      const jobs = createClipJobs({
        sourceId,
        files: message.files,
        groups: message.groups,
        defaults: message.defaults,
      });
      await withStorageLock(CLIP_QUEUE_KEY, async () => {
        const queue = await readClipQueue();
        await writeClipQueue([...queue, ...jobs]);
      });
      void startNextClipJob().catch(reportClipCoordinatorError);
      return { queued: jobs.length, jobs };
    });
  }
  if (type === "clips_cancel") {
    return respond(async () => {
      const queue = await readClipQueue();
      const job = queue.find((item) => item.id === message.jobId);
      if (!job || ["completed", "failed", "cancelled"].includes(job.status)) {
        throw new Error("Задание клипа уже нельзя отменить.");
      }
      const updated = await updateClipJob(job.id, { type: "cancel" });
      if (job.tabId) {
        try { await chrome.tabs.remove(job.tabId); } catch { /* already closed */ }
      }
      if (activeClipJobId === updated.id) activeClipJobId = null;
      void startNextClipJob().catch(reportClipCoordinatorError);
      return { cancelled: true };
    });
  }
  if (type === "clips_resume") {
    return respond(async () => {
      const queue = await readClipQueue();
      const job = queue.find((item) => item.id === message.jobId && item.status === "paused");
      if (!job) throw new Error("Приостановленное задание не найдено.");
      getClipSource(job.sourceId);
      await updateClipJob(job.id, { type: "resume" });
      void startNextClipJob().catch(reportClipCoordinatorError);
      return { resumed: true };
    });
  }
  if (type === "list_scheduled_comments") {
    return respond(async () => {
      const result = await serverRequest("/api/scheduled-comments?limit=100");
      return { jobs: result.jobs || [] };
    });
  }
  if (type === "delete_scheduled_comment") {
    return respond(async () => {
      await serverRequest(
        `/api/scheduled-comments/${encodeURIComponent(message.id)}`,
        { method: "DELETE" },
      );
      return { removed: true };
    });
  }
  if (type === "retry_scheduled_comment") {
    return respond(async () => {
      const result = await serverRequest(
        `/api/scheduled-comments/${encodeURIComponent(message.id)}/retry`,
        { method: "POST" },
      );
      return { retried: true, job: result.job };
    });
  }
  if (type === "get_queue_status") {
    return respond(async () => {
      const data = await chrome.storage.local.get([
        PUBLISH_QUEUE_KEY,
        QUEUE_PAUSE_KEY,
      ]);
      return {
        queue: data[PUBLISH_QUEUE_KEY] || [],
        pause: data[QUEUE_PAUSE_KEY] || null,
      };
    });
  }
  if (type === "resume_publish_queue") {
    return respond(async () => {
      let requiresDecision = false;
      await withStorageLock(PUBLISH_QUEUE_KEY, async () => {
        const data = await chrome.storage.local.get(PUBLISH_QUEUE_KEY);
        const queue = (data[PUBLISH_QUEUE_KEY] || []).map((job) => {
          if (job.status !== "paused") return job;
          if (job.pauseReason === "ambiguous_repost") {
            requiresDecision = true;
            return job;
          }
          const pausedGroupId = job.pausedGroupId;
          const results = (job.results || []).filter((result) => {
            if (
              pausedGroupId !== undefined &&
              Number(result.gid) === Number(pausedGroupId)
            ) {
              return false;
            }
            return (
              classifyVkError({ error_code: result.code }).action !== "pause"
            );
          });
          const {
            pausedGroupId: _pausedGroupId,
            processingStartedAt: _processingStartedAt,
            ...safeJob
          } = job;
          return {
            ...safeJob,
            results,
            status: "queued",
            error: null,
          };
        });
        await chrome.storage.local.set({ [PUBLISH_QUEUE_KEY]: queue });
      });
      if (requiresDecision) {
        return {
          resumed: false,
          requiresDecision: true,
          message:
            "Сначала откройте очередь и укажите, появился ли спорный репост на стене.",
        };
      }
      await chrome.storage.local.remove(QUEUE_PAUSE_KEY);
      await updateBadge();
      runInBackground("Resumed publish queue", () => processPublishQueue());
      return { resumed: true };
    });
  }
  if (type === "resolve_ambiguous_repost") {
    return respond(async () => {
      const action = String(message.action || "");
      if (!["skip", "retry", "cancel"].includes(action)) {
        throw new Error("Неизвестное решение для спорного репоста.");
      }
      let resolved = false;
      await withStorageLock(PUBLISH_QUEUE_KEY, async () => {
        const data = await chrome.storage.local.get(PUBLISH_QUEUE_KEY);
        const queue = data[PUBLISH_QUEUE_KEY] || [];
        const index = queue.findIndex(
          (job) =>
            job.id === message.jobId &&
            job.status === "paused" &&
            job.pauseReason === "ambiguous_repost",
        );
        if (index < 0) {
          throw new Error("Спорное задание больше не найдено.");
        }
        const job = { ...queue[index] };
        const groupId = job.pausedGroupId;
        const results = (job.results || []).filter(
          (result) => Number(result.gid) !== Number(groupId),
        );
        if (action === "skip") {
          results.push({
            gid: groupId,
            ok: true,
            postId: null,
            credential: "user",
            sideEffectsPending: false,
            verifiedByUser: true,
            warning:
              "Репост отмечен опубликованным вручную; авто-комментарий для него не создавался.",
          });
        }
        const {
          pausedGroupId: _pausedGroupId,
          pauseReason: _pauseReason,
          processingStartedAt: _processingStartedAt,
          ...safeJob
        } = job;
        queue[index] =
          action === "cancel"
            ? {
                ...safeJob,
                results,
                status: "cancelled",
                error: "Задание отменено пользователем.",
                completedAt: Date.now(),
              }
            : {
                ...safeJob,
                results,
                status: "queued",
                error: null,
              };
        await chrome.storage.local.set({ [PUBLISH_QUEUE_KEY]: queue });
        resolved = true;
      });
      if (resolved) {
        await chrome.storage.local.remove(QUEUE_PAUSE_KEY);
        await updateBadge();
        runInBackground("Resolved repost queue", () => processPublishQueue());
      }
      return { resolved, action };
    });
  }
  if (type === "clear_finished_queue") {
    return respond(async () => {
      await withStorageLock(PUBLISH_QUEUE_KEY, async () => {
        const data = await chrome.storage.local.get(PUBLISH_QUEUE_KEY);
        const queue = (data[PUBLISH_QUEUE_KEY] || []).filter((job) =>
          ["queued", "processing", "paused"].includes(job.status),
        );
        await chrome.storage.local.set({ [PUBLISH_QUEUE_KEY]: queue });
      });
      await updateBadge();
      return { cleared: true };
    });
  }
  if (type === "fetch_image") {
    return respond(async () => {
      const response = await fetch(message.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
        reader.readAsDataURL(blob);
      });
      return { dataUrl };
    });
  }
  if (type === "create_comment") {
    return respond(async () => {
      const token = message.token || (await getLocalCredentials()).userToken;
      const response = await vkApi(
        "wall.createComment",
        {
          owner_id: message.ownerId,
          post_id: message.postId,
          message: message.text,
        },
        token,
      );
      return { response };
    });
  }
  if (type === "create_group_comment") {
    return respond(async () => {
      const groupId = Math.abs(Number(message.groupId));
      const credentials = await getLocalCredentials();
      const credential = selectCredential({
        groupId,
        operation: "comment",
        groupTokens: credentials.groupTokens,
        userToken: credentials.userToken,
      });
      const response = await vkApi(
        "wall.createComment",
        {
          owner_id: -groupId,
          post_id: message.postId,
          message: message.text,
          from_group: groupId,
        },
        credential.token,
      );
      return { response };
    });
  }
  sendResponse({
    ok: false,
    error: "Эта функция отключена в безопасной версии расширения.",
  });
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PUBLISH_DUE_ALARM) {
    runInBackground("Scheduled photo alarm", () => processPublishQueue());
    return;
  }
  if (alarm.name === "vkr_safe_jobs") {
    runInBackground("Local comments", () => processLocalComments());
    runInBackground("Local deletions", () => processLocalDeletions());
    runInBackground("Periodic queue recovery", () => recoverQueue());
  }
});

let contextMenusSetup = null;

function setupContextMenus() {
  if (contextMenusSetup) return contextMenusSetup;
  contextMenusSetup = new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: "vkr-open-scheduled", title: "Посты и вся отложка", contexts: ["action"] });
      chrome.contextMenus.create({ id: "vkr-open-clips", title: "Загрузить клипы", contexts: ["action"] });
      chrome.contextMenus.create({ id: "vkr-open-stories", title: "Запланировать историю", contexts: ["action"] });
      resolve();
    });
  });
  return contextMenusSetup;
}

async function handleInstalled(details) {
  await chrome.alarms.clear("autolike_check");
  await chrome.alarms.clear("cookie_keepalive");
  await chrome.alarms.clear("vk_token_health_check");
  const isLegacyUpgrade =
    details.reason === "install" ||
    (details.reason === "update" &&
      !String(details.previousVersion || "").startsWith("4."));
  if (isLegacyUpgrade) {
    await chrome.storage.local.remove([
      "vk_token",
      "vk_accounts",
      "vk_publisher_account_id",
      "vkr_user_profile",
    ]);
  }
  await chrome.storage.local.remove([
    "vkr_autolike_settings",
    "vkr_autolike_log",
    "vkr_account_errors",
    "vkr_last_sync_ts",
    "vkr_video_download",
  ]);
  await chrome.alarms.create("vkr_safe_jobs", { periodInMinutes: 1 });
  await setupContextMenus();
  await recoverQueue();
}

chrome.runtime.onInstalled.addListener((details) => {
  runInBackground("Extension installation", () => handleInstalled(details));
});

chrome.runtime.onStartup.addListener(() => {
  runInBackground("Browser startup", async () => {
    await chrome.alarms.create("vkr_safe_jobs", { periodInMinutes: 1 });
    await setupContextMenus();
    await recoverQueue();
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "vkr-open-scheduled") {
    chrome.tabs.create({ url: chrome.runtime.getURL("scheduled.html") });
  } else if (info.menuItemId === "vkr-open-clips") {
    chrome.tabs.create({ url: chrome.runtime.getURL("clips.html") });
  } else if (info.menuItemId === "vkr-open-stories") {
    chrome.tabs.create({ url: chrome.runtime.getURL("stories.html") });
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith("vkr-job-")) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL("scheduled.html") });
});

runInBackground("Initial queue recovery", () => recoverQueue());
runInBackground("Initial context menus", () => setupContextMenus());
