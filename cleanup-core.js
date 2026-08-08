(function exposeCleanupCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VkrCleanupCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const PREVIEW_TTL_MS = 10 * 60_000;
  const SAMPLE_LIMIT = 5;
  const PHOTO_DELETE_WINDOW_MS = 24 * 60 * 60_000;
  const PHOTO_DELETE_SOFT_LIMIT = 950;

  function normalizeOwnerId(ownerId) {
    const numeric = Math.abs(Number(ownerId));
    if (!Number.isSafeInteger(numeric) || numeric === 0) {
      throw new Error("ownerId must be a community ID");
    }
    return -numeric;
  }

  function normalizeCleanupRange({ dateFrom, dateTo }) {
    const from = new Date(`${String(dateFrom || "")}T00:00:00`);
    const to = new Date(`${String(dateTo || "")}T23:59:59.999`);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      throw new Error("Cleanup dates must be valid ISO dates");
    }
    if (from.getTime() > to.getTime()) {
      throw new Error("dateFrom must be before or equal to dateTo");
    }
    return {
      fromUnix: Math.floor(from.getTime() / 1000),
      toUnix: Math.floor(to.getTime() / 1000),
    };
  }

  function sanitizeText(value, limit = 180) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function bestPhotoUrl(photo) {
    const sizes = Array.isArray(photo?.sizes) ? photo.sizes : [];
    return sizes
      .slice()
      .sort((first, second) => Number(second.width || 0) - Number(first.width || 0))[0]
      ?.url || "";
  }

  function ownAttachmentPhotoIds(attachments, ownerId) {
    if (!Array.isArray(attachments)) return [];
    const ids = new Set();
    for (const attachment of attachments) {
      const photo =
        attachment?.type === "photo" && attachment.photo
          ? attachment.photo
          : null;
      const id = Number(photo?.id);
      if (
        photo &&
        Number(photo.owner_id) === ownerId &&
        Number.isSafeInteger(id) &&
        id > 0
      ) {
        ids.add(id);
      }
    }
    return [...ids];
  }

  function buildWallPreview({
    ownerId,
    posts,
    includeOwnedPhotos = false,
    keepPinned = true,
  }) {
    const normalizedOwnerId = normalizeOwnerId(ownerId);
    const items = [];
    const sample = [];
    const seenPosts = new Set();

    for (const post of Array.isArray(posts) ? posts : []) {
      const postId = Number(post?.id);
      if (
        Number(post?.owner_id) !== normalizedOwnerId ||
        !Number.isSafeInteger(postId) ||
        postId <= 0 ||
        seenPosts.has(postId) ||
        (keepPinned && Number(post?.is_pinned) === 1)
      ) {
        continue;
      }
      seenPosts.add(postId);
      const photoIds = includeOwnedPhotos
        ? ownAttachmentPhotoIds(post.attachments, normalizedOwnerId)
        : [];
      items.push({ kind: "wall", postId, photoIds });
      if (sample.length < SAMPLE_LIMIT) {
        const firstPhoto = (post.attachments || [])
          .map((attachment) => attachment?.photo)
          .find((photo) => Number(photo?.owner_id) === normalizedOwnerId);
        sample.push({
          kind: "wall",
          postId,
          date: Number(post.date) || null,
          text: sanitizeText(post.text) || "Запись без текста",
          thumbnail: bestPhotoUrl(firstPhoto),
        });
      }
    }

    return {
      items,
      sample,
      counts: {
        posts: items.length,
        photos: items.reduce((total, item) => total + item.photoIds.length, 0),
      },
    };
  }

  function buildAlbumPreview({ ownerId, albums, photosByAlbum }) {
    const normalizedOwnerId = normalizeOwnerId(ownerId);
    const items = [];
    const sample = [];
    const seenPhotos = new Set();

    for (const album of Array.isArray(albums) ? albums : []) {
      const albumId = album?.id;
      if (albumId === undefined || albumId === null || albumId === "") continue;
      const photos =
        photosByAlbum?.[String(albumId)] ?? photosByAlbum?.[albumId] ?? [];
      for (const photo of Array.isArray(photos) ? photos : []) {
        const photoId = Number(photo?.id);
        const key = `${albumId}:${photoId}`;
        if (
          Number(photo?.owner_id) !== normalizedOwnerId ||
          !Number.isSafeInteger(photoId) ||
          photoId <= 0 ||
          seenPhotos.has(key)
        ) {
          continue;
        }
        seenPhotos.add(key);
        items.push({ kind: "album", photoId, albumId });
        if (sample.length < SAMPLE_LIMIT) {
          sample.push({
            kind: "album",
            photoId,
            albumId,
            albumTitle: sanitizeText(album.title, 100) || "Альбом",
            date: Number(photo.date) || null,
            thumbnail: bestPhotoUrl(photo),
          });
        }
      }
    }

    return {
      items,
      sample,
      counts: { posts: 0, photos: items.length },
    };
  }

  function cloneItems(items) {
    return (Array.isArray(items) ? items : []).map((item) => ({
      ...item,
      photoIds: Array.isArray(item.photoIds) ? [...item.photoIds] : undefined,
    }));
  }

  function countCleanupItems(items) {
    let posts = 0;
    let photos = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.kind === "wall") {
        posts += 1;
        photos += Array.isArray(item.photoIds) ? item.photoIds.length : 0;
      } else if (item?.kind === "album") {
        photos += 1;
      }
    }
    return { posts, photos };
  }

  function normalizePhotoDeleteState(rawState, now = Date.now()) {
    const currentTime = Number(now);
    const source = rawState && typeof rawState === "object" ? rawState : {};
    const timestamps = (Array.isArray(source.timestamps) ? source.timestamps : [])
      .map(Number)
      .filter(
        (timestamp) =>
          Number.isFinite(timestamp) &&
          timestamp > currentTime - PHOTO_DELETE_WINDOW_MS &&
          timestamp <= currentTime,
      )
      .sort((first, second) => first - second);
    const rawCooldownUntil = Number(source.cooldownUntil);
    const cooldownUntil =
      Number.isFinite(rawCooldownUntil) && rawCooldownUntil > currentTime
        ? rawCooldownUntil
        : null;
    return {
      timestamps,
      cooldownUntil,
      cooldownReason: cooldownUntil
        ? sanitizeText(source.cooldownReason, 240) || null
        : null,
    };
  }

  function photoDeleteBudget(
    rawState,
    now = Date.now(),
    limit = PHOTO_DELETE_SOFT_LIMIT,
  ) {
    const state = normalizePhotoDeleteState(rawState, now);
    const safeLimit = Math.max(1, Math.floor(Number(limit) || PHOTO_DELETE_SOFT_LIMIT));
    const used = state.timestamps.length;
    const isCoolingDown = Number(state.cooldownUntil) > Number(now);
    const remaining = isCoolingDown ? 0 : Math.max(0, safeLimit - used);
    const nextAvailableAt = isCoolingDown
      ? state.cooldownUntil
      : remaining === 0 && state.timestamps.length
        ? state.timestamps[0] + PHOTO_DELETE_WINDOW_MS
        : null;
    return {
      ...state,
      limit: safeLimit,
      used,
      remaining,
      nextAvailableAt,
    };
  }

  function capCleanupItemsByPhotoBudget(items, remainingPhotos) {
    let available = Math.max(0, Math.floor(Number(remainingPhotos) || 0));
    const cappedItems = [];

    for (const item of Array.isArray(items) ? items : []) {
      if (item?.kind === "wall") {
        const photoIds = Array.isArray(item.photoIds) ? item.photoIds : [];
        const scheduledPhotoIds = photoIds.slice(0, available);
        available -= scheduledPhotoIds.length;
        cappedItems.push({ ...item, photoIds: scheduledPhotoIds });
      } else if (item?.kind === "album" && available > 0) {
        cappedItems.push({ ...item });
        available -= 1;
      }
    }

    const matchedCounts = countCleanupItems(items);
    const counts = countCleanupItems(cappedItems);
    return {
      items: cappedItems,
      counts,
      matchedCounts,
      deferredPhotos: Math.max(0, matchedCounts.photos - counts.photos),
    };
  }

  function createPreviewTicket({
    id,
    kind,
    tabId,
    ownerId,
    items,
    now = Date.now(),
  }) {
    if (!String(id || "").trim()) throw new Error("Preview ID is required");
    if (!["wall", "albums"].includes(kind)) {
      throw new Error("Unknown cleanup kind");
    }
    if (!Number.isSafeInteger(Number(tabId)) || Number(tabId) < 0) {
      throw new Error("Preview tab is required");
    }
    return Object.freeze({
      id: String(id),
      kind,
      tabId: Number(tabId),
      ownerId: normalizeOwnerId(ownerId),
      items: cloneItems(items),
      createdAt: Number(now),
      expiresAt: Number(now) + PREVIEW_TTL_MS,
    });
  }

  return Object.freeze({
    PHOTO_DELETE_SOFT_LIMIT,
    PHOTO_DELETE_WINDOW_MS,
    PREVIEW_TTL_MS,
    buildAlbumPreview,
    buildWallPreview,
    capCleanupItemsByPhotoBudget,
    countCleanupItems,
    createPreviewTicket,
    normalizeCleanupRange,
    normalizeOwnerId,
    normalizePhotoDeleteState,
    photoDeleteBudget,
  });
});
