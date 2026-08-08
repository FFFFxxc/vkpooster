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

  function buildOwnedPhotoAttachment(photo, groupId) {
    const normalizedGroupId = Math.abs(Number(groupId));
    const ownerId = Number(photo?.owner_id ?? photo?.ownerId);
    const photoId = Number(photo?.id);
    if (
      !Number.isSafeInteger(normalizedGroupId) ||
      normalizedGroupId === 0 ||
      !Number.isSafeInteger(photoId) ||
      ownerId !== -normalizedGroupId
    ) {
      throw new Error(
        "VK не подтвердил, что загруженное фото принадлежит целевому сообществу.",
      );
    }
    const accessKey = photo?.access_key ?? photo?.accessKey;
    const suffix = accessKey ? `_${accessKey}` : "";
    return `photo${ownerId}_${photoId}${suffix}`;
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
    if (operation === "repost" || operation === "upload") {
      if (!localUserToken) {
        throw new Error(operation === "upload"
          ? "VK не разрешает загружать фотографии токеном сообщества. Добавьте локальный пользовательский токен."
          : "Для репоста нужен локальный пользовательский токен.");
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
    buildOwnedPhotoAttachment,
    buildReusableAttachments,
    classifyVkError,
    createSerialScheduler,
    largestPhotoUrl,
    normalizeQueueJobs,
    selectCredential,
  });
});
