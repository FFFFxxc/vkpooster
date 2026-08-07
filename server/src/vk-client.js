"use strict";

function createVkClient({
  apiVersion = "5.199",
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
} = {}) {
  return Object.freeze({
    async createGroupComment({
      groupId,
      postId,
      commentText,
      groupToken,
      guid,
    }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const body = new URLSearchParams({
        access_token: groupToken,
        v: apiVersion,
        owner_id: String(-Math.abs(groupId)),
        post_id: String(postId),
        message: commentText,
        from_group: String(Math.abs(groupId)),
        guid,
      });

      try {
        const response = await fetchImpl(
          "https://api.vk.com/method/wall.createComment",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          const error = new Error(`VK API HTTP ${response.status}`);
          error.transport = true;
          throw error;
        }
        const payload = await response.json();
        if (payload.error) {
          const error = new Error(payload.error.error_msg || "VK API error");
          error.code = Number(payload.error.error_code) || null;
          error.vkError = payload.error;
          throw error;
        }
        return payload.response;
      } catch (error) {
        if (error.name === "AbortError") {
          const timeoutError = new Error("VK API request timed out");
          timeoutError.transport = true;
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

module.exports = { createVkClient };
