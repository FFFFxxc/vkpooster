"use strict";

(function attachHlsDownloadCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.VkrHlsDownloadCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createHlsDownloadCore() {
  function linesOf(text) {
    return String(text || "")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseAttributes(value) {
    const attributes = {};
    const source = String(value || "");
    let token = "";
    let quoted = false;

    const commit = () => {
      const separator = token.indexOf("=");
      if (separator > 0) {
        const key = token.slice(0, separator).trim();
        let item = token.slice(separator + 1).trim();
        if (item.startsWith('"') && item.endsWith('"')) item = item.slice(1, -1);
        attributes[key] = item;
      }
      token = "";
    };

    for (const char of source) {
      if (char === '"') quoted = !quoted;
      if (char === "," && !quoted) commit();
      else token += char;
    }
    commit();
    return attributes;
  }

  function resolveUrl(value, baseUrl) {
    return new URL(String(value || ""), String(baseUrl || "")).href;
  }

  function selectMasterVariant(text, playlistUrl) {
    const lines = linesOf(text);
    const variants = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const attributes = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const uri = lines.slice(index + 1).find((candidate) => !candidate.startsWith("#"));
      if (!uri) continue;
      variants.push({
        bandwidth: Number(attributes.BANDWIDTH || attributes["AVERAGE-BANDWIDTH"]) || 0,
        url: resolveUrl(uri, playlistUrl),
      });
    }

    variants.sort((left, right) => right.bandwidth - left.bandwidth);
    return variants[0]?.url || null;
  }

  function parseByteRange(value, previousEnd = 0) {
    if (!value) return null;
    const [lengthRaw, offsetRaw] = String(value).split("@");
    const length = Number.parseInt(lengthRaw, 10);
    const start = offsetRaw === undefined ? previousEnd : Number.parseInt(offsetRaw, 10);
    if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(start) || start < 0) {
      throw new Error("VK вернул некорректный диапазон HLS-сегмента.");
    }
    return { start, end: start + length - 1 };
  }

  function parseMediaPlaylist(text, playlistUrl) {
    const lines = linesOf(text);
    if (lines[0] !== "#EXTM3U") throw new Error("VK вернул некорректный HLS-плейлист.");

    const segments = [];
    let initUrl = null;
    let initByteRange = null;
    let pendingByteRange = null;
    let previousRangeEnd = 0;
    let sequence = 0;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        sequence = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10) || 0;
        continue;
      }
      if (line.startsWith("#EXT-X-KEY:")) {
        const attributes = parseAttributes(line.slice("#EXT-X-KEY:".length));
        if (String(attributes.METHOD || "NONE").toUpperCase() !== "NONE") {
          throw new Error("Этот HLS-поток зашифрован и не может быть собран напрямую.");
        }
        continue;
      }
      if (line.startsWith("#EXT-X-MAP:")) {
        const attributes = parseAttributes(line.slice("#EXT-X-MAP:".length));
        if (!attributes.URI) throw new Error("VK не указал init-сегмент HLS.");
        initUrl = resolveUrl(attributes.URI, playlistUrl);
        initByteRange = parseByteRange(attributes.BYTERANGE, 0);
        continue;
      }
      if (line.startsWith("#EXT-X-BYTERANGE:")) {
        pendingByteRange = line.slice("#EXT-X-BYTERANGE:".length);
        continue;
      }
      if (line.startsWith("#")) continue;

      const byteRange = parseByteRange(pendingByteRange, previousRangeEnd);
      if (byteRange) previousRangeEnd = byteRange.end + 1;
      else previousRangeEnd = 0;
      segments.push({
        url: resolveUrl(line, playlistUrl),
        byteRange,
        sequence: sequence + segments.length,
      });
      pendingByteRange = null;
    }

    if (segments.length === 0) throw new Error("В HLS-плейлисте VK нет видеофрагментов.");
    return { initUrl, initByteRange, segments };
  }

  function detectContainer(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (data[0] === 0x47) return { extension: "ts", mimeType: "video/mp2t" };
    const box = String.fromCharCode(...data.slice(4, 8));
    if (["ftyp", "styp", "moof"].includes(box)) {
      return { extension: "mp4", mimeType: "video/mp4" };
    }
    return { extension: "mp4", mimeType: "video/mp4" };
  }

  function isHlsUrl(rawUrl) {
    try {
      return /\.m3u8$/i.test(new URL(String(rawUrl || "")).pathname);
    } catch {
      return false;
    }
  }

  return {
    detectContainer,
    isHlsUrl,
    parseAttributes,
    parseMediaPlaylist,
    selectMasterVariant,
  };
});
