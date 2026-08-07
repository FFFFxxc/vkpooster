/**
 * VK Reposter Pro 4 — safe service worker.
 *
 * User tokens never leave this browser. Cookie-based authorization, token
 * impersonation, auto-likes and multi-account automation are intentionally absent.
 */

importScripts("safety-core.js");

const VK_API_VERSION = "5.199";
const PUBLISH_QUEUE_KEY = "vkr_publish_queue";
const LOCAL_COMMENTS_KEY = "vkr_scheduled_comments";
const GROUP_TOKENS_KEY = "vkr_group_tokens";
const QUEUE_PAUSE_KEY = "vkr_queue_pause";
const DEFAULT_COMMENT_DELAY_SECONDS = 60;
const API_INTERVAL_MS = 1200;
const API_TIMEOUT_MS = 20_000;

const {
  buildReusableAttachments,
  classifyVkError,
  createSerialScheduler,
  normalizeQueueJobs,
  selectCredential,
} = globalThis.VkrSafetyCore;

const vkScheduler = createSerialScheduler({ minIntervalMs: API_INTERVAL_MS });
const storageLocks = new Map();
let publishWorkerRunning = false;
let localCommentsRunning = false;
let localDeletionsRunning = false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function setQueuePause(error, jobId = null) {
  const pause = {
    code: Number(error?.code) || null,
    message:
      error?.message ||
      "VK запросил дополнительную проверку. Очередь остановлена.",
    jobId,
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

  return {
    id: `pub_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    post: message.post,
    groups,
    mode: message.mode === "repost" ? "repost" : "copy",
    text: String(message.text || ""),
    pubDate,
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
  void processPublishQueue();
  return job;
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
  const data = await chrome.storage.local.get("vkr_posts_history");
  const history = Array.isArray(data.vkr_posts_history)
    ? data.vkr_posts_history
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
  await chrome.storage.local.set({ vkr_posts_history: history.slice(0, 100) });
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
      const commentAt = (job.pubDate || Date.now()) + delaySeconds * 1000;
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
              deleteAt: (job.pubDate || Date.now()) + job.autoDeleteAfter,
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

async function publishToGroup(job, groupId, credentials, onPublished) {
  if (job.processedPhotos > 0) {
    throw new Error(
      "Водяные знаки требуют повторной загрузки фото и отключены в безопасном режиме.",
    );
  }

  const configuredEntry =
    credentials.groupTokens[String(groupId)] ||
    credentials.groupTokens[groupId];
  const publishWithUser =
    configuredEntry &&
    typeof configuredEntry === "object" &&
    configuredEntry.publishAs === "user";
  const postingGroupTokens = publishWithUser
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
    allowUserFallback: publishWithUser,
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
    const attachments = buildReusableAttachments(job.post.attachments);
    const params = {
      owner_id: -groupId,
      from_group: 1,
      message: job.text,
      random_id: stableRandomId(job.id, groupId),
    };
    if (attachments.length) params.attachments = attachments.join(",");
    if (job.pubDate) params.publish_date = Math.floor(job.pubDate / 1000);
    const response = await vkApi("wall.post", params, credential.token);
    postId = response?.post_id;
  }

  const checkpoint = {
    gid: groupId,
    ok: true,
    postId,
    credential: credential.kind,
    sideEffectsPending: true,
  };
  await onPublished(checkpoint);
  const warning = await completePostSideEffects(
    job,
    groupId,
    postId,
    credential.kind,
    credentials,
  );
  return { ...checkpoint, sideEffectsPending: false, warning };
}

async function executePublishJob(job) {
  const credentials = await getLocalCredentials();
  job.results = Array.isArray(job.results) ? job.results : [];

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
        const decision = classifyVkError(
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
          await setQueuePause(error, job.id);
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
        const index = queue.findIndex((item) => item.status === "queued");
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
  void processPublishQueue();
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
            await setQueuePause(error);
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
            await setQueuePause(error);
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
    { fields: "photo_50" },
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
      void processPublishQueue();
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
        void processPublishQueue();
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
  if (alarm.name === "vkr_safe_jobs") {
    void processLocalComments();
    void processLocalDeletions();
    void recoverQueue();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
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
  chrome.alarms.create("vkr_safe_jobs", { periodInMinutes: 1 });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "vkr-open-scheduled",
      title: "Отложенные посты и очередь",
      contexts: ["action"],
    });
  });
  await recoverQueue();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("vkr_safe_jobs", { periodInMinutes: 1 });
  void recoverQueue();
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "vkr-open-scheduled") {
    chrome.tabs.create({ url: chrome.runtime.getURL("scheduled.html") });
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith("vkr-job-")) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL("scheduled.html") });
});

void recoverQueue();
