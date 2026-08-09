(function exposeSafetyCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VkrSafetyCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const PAUSE_ERROR_CODES = new Set([
    6, 9, 14, 17, 24, 25, 29, 1105, 3300, 3301, 3302, 3303, 3304, 3305,
    11500,
  ]);
  const TRANSIENT_ERROR_CODES = new Set([1, 2, 10]);

  function classifyVkError(error) {
    const rawCode = error?.error_code ?? error?.code;
    const code = Number.isFinite(Number(rawCode)) ? Number(rawCode) : null;

    if (error?.transport === true || code === null) {
      return { action: "retry", code, reason: "transport" };
    }
    if (PAUSE_ERROR_CODES.has(code)) {
      return { action: "pause", code, reason: "protection" };
    }
    if (code === 5) {
      return { action: "fail", code, reason: "auth" };
    }
    if (TRANSIENT_ERROR_CODES.has(code)) {
      return { action: "retry", code, reason: "transient" };
    }
    return { action: "fail", code, reason: "vk" };
  }

  function unwrapAttachment(rawAttachment) {
    if (!rawAttachment || typeof rawAttachment !== "object") return null;
    const type = rawAttachment.type;
    const nested =
      type && rawAttachment[type] && typeof rawAttachment[type] === "object"
        ? rawAttachment[type]
        : rawAttachment;
    return { type, value: nested };
  }

  function buildReusableAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];

    return attachments.flatMap((rawAttachment) => {
      const unwrapped = unwrapAttachment(rawAttachment);
      if (!unwrapped) return [];

      const { type, value } = unwrapped;
      if (!["photo", "video", "doc", "audio"].includes(type)) return [];

      const ownerId = value.owner_id ?? value.ownerId;
      const id = value.id;
      if (!Number.isFinite(Number(ownerId)) || !Number.isFinite(Number(id))) {
        return [];
      }

      const accessKey = value.access_key ?? value.accessKey;
      const suffix = accessKey ? `_${accessKey}` : "";
      return [`${type}${Number(ownerId)}_${Number(id)}${suffix}`];
    });
  }

  function largestPhotoUrl(photo) {
    const sizes = Array.isArray(photo?.sizes)
      ? photo.sizes.filter((size) => size && typeof size.url === "string")
      : [];
    if (sizes.length > 0) {
      const best = sizes.reduce((current, size) => {
        const currentArea =
          (Number(current.width) || 0) * (Number(current.height) || 0);
        const sizeArea =
          (Number(size.width) || 0) * (Number(size.height) || 0);
        return sizeArea >= currentArea ? size : current;
      });
      return best.url.trim();
    }
    return String(photo?.orig_photo?.url || photo?.url || "").trim();
  }

  function isUploadedPhotoAttachment(value) {
    return /^photo-?[1-9]\d*_[1-9]\d*(?:_[A-Za-z0-9_-]+)?$/.test(
      String(value || ""),
    );
  }

  function buildUploadedPhotoAttachment(photo, sourcePhoto = null) {
    const ownerId = Number(photo?.owner_id ?? photo?.ownerId);
    const photoId = Number(photo?.id);
    if (
      !Number.isSafeInteger(ownerId) ||
      ownerId === 0 ||
      !Number.isSafeInteger(photoId) ||
      photoId <= 0
    ) {
      throw new Error(
        "VK не вернул корректный идентификатор загруженной фотографии.",
      );
    }

    const sourceOwnerId = Number(sourcePhoto?.owner_id ?? sourcePhoto?.ownerId);
    const sourcePhotoId = Number(sourcePhoto?.id);
    if (ownerId === sourceOwnerId && photoId === sourcePhotoId) {
      throw new Error(
        "VK вернул исходную фотографию вместо нового загруженного файла.",
      );
    }

    const accessKey = String(photo?.access_key ?? photo?.accessKey ?? "").trim();
    if (accessKey && !/^[A-Za-z0-9_-]+$/.test(accessKey)) {
      throw new Error("VK вернул некорректный ключ доступа к фотографии.");
    }
    const suffix = accessKey ? `_${accessKey}` : "";
    const attachment = `photo${ownerId}_${photoId}${suffix}`;
    if (!isUploadedPhotoAttachment(attachment)) {
      throw new Error("VK вернул некорректное вложение фотографии.");
    }
    return attachment;
  }

  function readGroupToken(groupTokens, groupId) {
    const entry = groupTokens?.[String(groupId)] ?? groupTokens?.[Number(groupId)];
    if (typeof entry === "string") return entry.trim();
    if (entry && typeof entry.token === "string") return entry.token.trim();
    return "";
  }

  function selectCredential({
    groupId,
    operation,
    groupTokens = {},
    userToken = "",
    allowUserFallback = false,
  }) {
    const normalizedGroupId = Math.abs(Number(groupId));
    if (!Number.isSafeInteger(normalizedGroupId) || normalizedGroupId === 0) {
      throw new Error("Некорректный ID сообщества.");
    }

    const localUserToken =
      typeof userToken === "string" ? userToken.trim() : "";
    if (["repost", "upload", "analytics"].includes(operation)) {
      if (!localUserToken) {
        const messages = {
          upload: "VK не разрешает загружать фотографии токеном сообщества. Добавьте локальный пользовательский токен.",
          repost: "Для репоста нужен локальный пользовательский токен.",
          analytics: "Для аналитики нужен локальный пользовательский токен: VK не разрешает читать стену методом wall.get с токеном сообщества.",
        };
        throw new Error(messages[operation]);
      }
      return {
        kind: "user",
        token: localUserToken,
        groupId: normalizedGroupId,
      };
    }

    const groupToken = readGroupToken(groupTokens, normalizedGroupId);
    if (groupToken) {
      return {
        kind: "group",
        token: groupToken,
        groupId: normalizedGroupId,
      };
    }

    if (allowUserFallback && localUserToken) {
      return {
        kind: "user",
        token: localUserToken,
        groupId: normalizedGroupId,
      };
    }

    throw new Error(
      `Не настроен токен сообщества ${normalizedGroupId}. Добавьте его в расширении.`,
    );
  }

  function normalizeQueueJobs(
    jobs,
    { now = Date.now(), staleAfterMs = 5 * 60_000 } = {},
  ) {
    if (!Array.isArray(jobs)) return [];

    return jobs.map((job) => {
      const normalized = { ...job };
      const startedAt = Date.parse(job?.processingStartedAt || "");
      const isStale =
        job?.status === "processing" &&
        (!Number.isFinite(startedAt) || now - startedAt >= staleAfterMs);

      if (isStale) {
        normalized.status = "queued";
        normalized.recoveredAt = new Date(now).toISOString();
        delete normalized.processingStartedAt;
      }
      return normalized;
    });
  }

  function hasPostPhotos(post) {
    return (Array.isArray(post?.attachments) ? post.attachments : []).some(
      (attachment) => attachment?.type === "photo",
    );
  }

  function shouldDeferPhotoPublish({ post, mode, pubDate } = {}) {
    const scheduledAt = Number(pubDate);
    return (
      mode === "copy" &&
      Number.isFinite(scheduledAt) &&
      scheduledAt > 0 &&
      hasPostPhotos(post)
    );
  }

  function nextRunnablePublishJobIndex(jobs, now = Date.now()) {
    if (!Array.isArray(jobs)) return -1;
    return jobs.findIndex((job) => {
      if (job?.status !== "queued") return false;
      if (!job.deferMediaUntilPublish) return true;
      const publishAt = Number(job.pubDate);
      return !Number.isFinite(publishAt) || publishAt <= now;
    });
  }

  function createSerialScheduler({
    minIntervalMs = 1200,
    now = Date.now,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    let tail = Promise.resolve();
    let lastStartedAt = null;

    function run(task) {
      if (typeof task !== "function") {
        return Promise.reject(new TypeError("task must be a function"));
      }

      const result = tail.then(async () => {
        if (lastStartedAt !== null) {
          const remaining = minIntervalMs - (now() - lastStartedAt);
          if (remaining > 0) await sleep(remaining);
        }
        lastStartedAt = now();
        return task();
      });

      tail = result.catch(() => undefined);
      return result;
    }

    return { run };
  }

  return Object.freeze({
    PAUSE_ERROR_CODES,
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
  });
});
