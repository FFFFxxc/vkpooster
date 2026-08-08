"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAlbumPreview,
  buildWallPreview,
  createPreviewTicket,
  normalizeCleanupRange,
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
