"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

let core = {};
try {
  core = require("../hls-download-core.js");
} catch {
  // RED phase: the production module does not exist yet.
}

test("media playlist resolves init and ordered segment URLs", () => {
  assert.equal(typeof core.parseMediaPlaylist, "function");
  const result = core.parseMediaPlaylist(
    [
      "#EXTM3U",
      "#EXT-X-MAP:URI=\"init.mp4\"",
      "#EXTINF:4.0,",
      "segment-1.m4s",
      "#EXTINF:4.0,",
      "../segment-2.m4s?token=vk",
      "#EXT-X-ENDLIST",
    ].join("\n"),
    "https://vkvd630.okcdn.ru/path/video.m3u8?sig=vk",
  );

  assert.equal(result.initUrl, "https://vkvd630.okcdn.ru/path/init.mp4");
  assert.deepEqual(result.segments.map((item) => item.url), [
    "https://vkvd630.okcdn.ru/path/segment-1.m4s",
    "https://vkvd630.okcdn.ru/segment-2.m4s?token=vk",
  ]);
});

test("master playlist chooses the highest bandwidth variant", () => {
  assert.equal(typeof core.selectMasterVariant, "function");
  const result = core.selectMasterVariant(
    [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=426x240",
      "240/video.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480",
      "480/video.m3u8",
    ].join("\n"),
    "https://vkvd630.okcdn.ru/master.m3u8?sig=vk",
  );

  assert.equal(result, "https://vkvd630.okcdn.ru/480/video.m3u8");
});

test("playlist rejects encrypted streams instead of saving unusable bytes", () => {
  assert.equal(typeof core.parseMediaPlaylist, "function");
  assert.throws(
    () => core.parseMediaPlaylist(
      "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg.ts",
      "https://vkvd630.okcdn.ru/video.m3u8",
    ),
    /зашифрован/i,
  );
});

test("container detection keeps transport streams playable and fMP4 as MP4", () => {
  assert.equal(typeof core.detectContainer, "function");
  assert.deepEqual(core.detectContainer(new Uint8Array([0x47, 0x40, 0x00, 0x10])), {
    extension: "ts",
    mimeType: "video/mp2t",
  });
  assert.deepEqual(core.detectContainer(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])), {
    extension: "mp4",
    mimeType: "video/mp4",
  });
});
