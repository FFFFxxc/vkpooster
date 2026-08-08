"use strict";

function createStoryMediaStore({ bucket, maxBytes }) {
  if (!bucket) throw new Error("GridFS bucket is required");
  return Object.freeze({
    async save({ buffer, fileName, mimeType }) {
      if (!Buffer.isBuffer(buffer) || buffer.length <= 0 || buffer.length > maxBytes) throw new Error("Story media is empty or exceeds the maximum");
      return new Promise((resolve, reject) => {
        const stream = bucket.openUploadStream(fileName, { contentType: mimeType, metadata: { kind: "scheduled-story" } });
        stream.once("error", reject);
        stream.once("finish", () => resolve(stream.id));
        stream.end(buffer);
      });
    },
    async read(id) {
      if (!id) throw new Error("Story media ID is required");
      return new Promise((resolve, reject) => {
        const chunks = [];
        let length = 0;
        const stream = bucket.openDownloadStream(id);
        stream.on("data", (chunk) => {
          length += chunk.length;
          if (length > maxBytes) stream.destroy(new Error("Stored story media exceeds the maximum"));
          else chunks.push(chunk);
        });
        stream.once("error", reject);
        stream.once("end", () => resolve(Buffer.concat(chunks, length)));
      });
    },
    async remove(id) {
      if (!id) return false;
      try { await bucket.delete(id); return true; }
      catch (error) {
        if (error?.code === 26 || /FileNotFound/i.test(error?.message || "")) return false;
        throw error;
      }
    },
  });
}

module.exports = { createStoryMediaStore };
