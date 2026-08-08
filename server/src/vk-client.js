"use strict";

function createVkClient({ apiVersion = "5.199", fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  async function fetchWithTimeout(url, options, requestTimeout = timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`VK HTTP ${response.status}`);
        error.transport = true;
        throw error;
      }
      return response;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("VK request timed out");
        timeoutError.transport = true;
        throw timeoutError;
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function callVkMethod(method, parameters, groupToken) {
    const body = new URLSearchParams({ access_token: groupToken, v: apiVersion });
    for (const [key, value] of Object.entries(parameters || {})) {
      if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
    }
    const response = await fetchWithTimeout(`https://api.vk.com/method/${method}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    const payload = await response.json();
    if (payload.error) {
      const error = new Error(payload.error.error_msg || "VK API error");
      error.code = Number(payload.error.error_code) || null;
      error.vkError = payload.error;
      throw error;
    }
    return payload.response;
  }

  return Object.freeze({
    async createGroupComment({ groupId, postId, commentText, groupToken, guid }) {
      return callVkMethod("wall.createComment", {
        owner_id: -Math.abs(groupId), post_id: postId, message: commentText,
        from_group: Math.abs(groupId), guid,
      }, groupToken);
    },

    async createStoryUploadServer({ kind, groupId, groupToken, linkUrl, linkText }) {
      const method = kind === "photo" ? "stories.getPhotoUploadServer" : "stories.getVideoUploadServer";
      return callVkMethod(method, { group_id: Math.abs(groupId), link_url: linkUrl, link_text: linkText }, groupToken);
    },

    async uploadStoryMedia({ uploadUrl, kind, media, fileName, mimeType }) {
      const form = new FormData();
      const field = kind === "photo" ? "file" : "video_file";
      form.append(field, new Blob([media], { type: mimeType }), fileName);
      const response = await fetchWithTimeout(uploadUrl, { method: "POST", body: form }, Math.max(timeoutMs, 5 * 60_000));
      const text = await response.text();
      try { return JSON.parse(text); } catch { return text; }
    },

    async saveCommunityStory({ groupToken, uploadResult }) {
      const parameters = typeof uploadResult === "string"
        ? { upload_results: uploadResult }
        : { upload_results_json: JSON.stringify([uploadResult]) };
      return callVkMethod("stories.save", parameters, groupToken);
    },
  });
}

module.exports = { createVkClient };
