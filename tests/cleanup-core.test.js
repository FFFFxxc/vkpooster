"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PHOTO_DELETE_SOFT_LIMIT,
  PHOTO_DELETE_WINDOW_MS,
  buildAlbumPreview,
  buildWallPreview,
  capCleanupItemsByPhotoBudget,
  createPreviewTicket,
  normalizeCleanupRange,
  photoDeleteBudget,
} = require("../cleanup-core.js");

test("wall preview keeps pinned posts and photos owned by another community", () => {
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
      { id: 3, owner_id: -99, date: 1_754_006_402 },
    ],
  });

  assert.deepEqual(preview.items, [
    { kind: "wall", postId: 2, photoIds: [10] },
  ]);
  assert.equal(preview.counts.posts, 1);
  assert.equal(preview.counts.photos, 1);
  assert.equal(preview.sample[0].text, "own post");
});

test("wall preview supports skipping attached photos", () => {
  const preview = buildWallPreview({
    ownerId: -42,
    includeOwnedPhotos: false,
    keepPinned: false,
    posts: [
      {
        id: 2,
        owner_id: -42,
        date: 1_754_006_401,
        attachments: [{ type: "photo", photo: { id: 10, owner_id: -42 } }],
      },
    ],
  });

  assert.deepEqual(preview.items, [
    { kind: "wall", postId: 2, photoIds: [] },
  ]);
  assert.equal(preview.counts.photos, 0);
});

test("album preview emits only selected community-owned photos", () => {
  const preview = buildAlbumPreview({
    ownerId: -42,
    albums: [
      { id: "wall", title: "Со стены" },
      { id: 7, title: "Лето" },
    ],
    photosByAlbum: {
      wall: [
        { id: 1, owner_id: -42, date: 1_754_006_401 },
        { id: 2, owner_id: -8, date: 1_754_006_402 },
      ],
      7: [{ id: 3, owner_id: -42, date: 1_754_006_403 }],
    },
  });

  assert.deepEqual(preview.items, [
    { kind: "album", photoId: 1, albumId: "wall" },
    { kind: "album", photoId: 3, albumId: 7 },
  ]);
  assert.equal(preview.counts.photos, 2);
  assert.equal(preview.sample[1].albumTitle, "Лето");
});

test("range normalisation is inclusive and rejects inverted dates", () => {
  const fromUnix = Math.floor(
    new Date("2026-08-01T00:00:00").getTime() / 1000,
  );
  const toUnix = Math.floor(
    new Date("2026-08-01T23:59:59.999").getTime() / 1000,
  );
  assert.deepEqual(
    normalizeCleanupRange({ dateFrom: "2026-08-01", dateTo: "2026-08-01" }),
    { fromUnix, toUnix },
  );
  assert.throws(
    () =>
      normalizeCleanupRange({
        dateFrom: "2026-08-02",
        dateTo: "2026-08-01",
      }),
    /before or equal/i,
  );
});

test("preview tickets expire after ten minutes and never hold a token", () => {
  const ticket = createPreviewTicket({
    id: "cleanup_preview_a",
    kind: "wall",
    tabId: 7,
    ownerId: -42,
    items: [{ kind: "wall", postId: 10, photoIds: [] }],
    now: 1_754_000_000_000,
  });

  assert.equal(ticket.expiresAt, 1_754_000_600_000);
  assert.equal("token" in ticket, false);
  assert.deepEqual(ticket.items, [{ kind: "wall", postId: 10, photoIds: [] }]);
});

test("photo budget is rolling, discards expired entries and exposes the next slot", () => {
  const now = 1_800_000_000_000;
  const budget = photoDeleteBudget({
    timestamps: [
      now - PHOTO_DELETE_WINDOW_MS,
      now - PHOTO_DELETE_WINDOW_MS + 1,
      now - 10_000,
      now + 1,
      "invalid",
    ],
  }, now, 2);

  assert.equal(PHOTO_DELETE_SOFT_LIMIT, 950);
  assert.equal(budget.used, 2);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.nextAvailableAt, now + 1);
  assert.deepEqual(budget.timestamps, [
    now - PHOTO_DELETE_WINDOW_MS + 1,
    now - 10_000,
  ]);
});

test("an explicit VK cooldown blocks only the supplied community budget", () => {
  const now = 1_800_000_000_000;
  const budget = photoDeleteBudget({
    timestamps: [now - 1_000],
    cooldownUntil: now + 15 * 60_000,
    cooldownReason: "Flood control",
  }, now);

  assert.equal(budget.used, 1);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.nextAvailableAt, now + 15 * 60_000);
  assert.equal(budget.cooldownReason, "Flood control");
});

test("album cleanup is capped to the available photo slots", () => {
  const capped = capCleanupItemsByPhotoBudget([
    { kind: "album", albumId: 1, photoId: 10 },
    { kind: "album", albumId: 1, photoId: 11 },
    { kind: "album", albumId: 2, photoId: 12 },
  ], 2);

  assert.deepEqual(capped.items, [
    { kind: "album", albumId: 1, photoId: 10 },
    { kind: "album", albumId: 1, photoId: 11 },
  ]);
  assert.deepEqual(capped.counts, { posts: 0, photos: 2 });
  assert.deepEqual(capped.matchedCounts, { posts: 0, photos: 3 });
  assert.equal(capped.deferredPhotos, 1);
});

test("a 2205-photo cleanup becomes one 950-photo batch without losing the remainder count", () => {
  const items = Array.from({ length: 2_205 }, (_, index) => ({
    kind: "album",
    albumId: "wall",
    photoId: index + 1,
  }));
  const capped = capCleanupItemsByPhotoBudget(items, PHOTO_DELETE_SOFT_LIMIT);

  assert.equal(capped.items.length, 950);
  assert.deepEqual(capped.counts, { posts: 0, photos: 950 });
  assert.deepEqual(capped.matchedCounts, { posts: 0, photos: 2_205 });
  assert.equal(capped.deferredPhotos, 1_255);
});

test("wall cleanup keeps every post while deferring photos beyond the budget", () => {
  const capped = capCleanupItemsByPhotoBudget([
    { kind: "wall", postId: 1, photoIds: [10, 11] },
    { kind: "wall", postId: 2, photoIds: [12] },
    { kind: "wall", postId: 3, photoIds: [] },
  ], 2);

  assert.deepEqual(capped.items, [
    { kind: "wall", postId: 1, photoIds: [10, 11] },
    { kind: "wall", postId: 2, photoIds: [] },
    { kind: "wall", postId: 3, photoIds: [] },
  ]);
  assert.deepEqual(capped.counts, { posts: 3, photos: 2 });
  assert.deepEqual(capped.matchedCounts, { posts: 3, photos: 3 });
  assert.equal(capped.deferredPhotos, 1);
});
