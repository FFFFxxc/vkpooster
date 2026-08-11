"use strict";

const {
  buildReusableAttachments,
  buildUploadedPhotoAttachment,
  largestPhotoUrl,
} = require("../../safety-core.js");

const MAX_SOURCE_PHOTO_BYTES = 50 * 1024 * 1024;

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

  async function callVkMethod(method, parameters, token) {
    const body = new URLSearchParams({ access_token: token, v: apiVersion });
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

  function checkedHttpsUrl(rawUrl, allowedSuffixes, label) {
    let url;
    try { url = new URL(String(rawUrl || "")); }
    catch { throw new Error(`${label} has an invalid URL`); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      throw new Error(`${label} has an unsupported HTTPS host`);
    }
    return url.toString();
  }

  async function fetchSourcePost({ sourceOwnerId, sourcePostId, userToken }) {
    const response = await callVkMethod("wall.getById", {
      posts: `${Number(sourceOwnerId)}_${Number(sourcePostId)}`,
      extended: 0,
    }, userToken);
    const post = Array.isArray(response) ? response[0] : response?.items?.[0];
    if (!post) throw new Error("VK did not return the source post");
    return post;
  }

  async function uploadCopiedPhoto({ photo, targetGroupId, userToken, position }) {
    const sourceUrl = checkedHttpsUrl(
      largestPhotoUrl(photo),
      ["userapi.com", "vkuserphoto.ru", "vk-cdn.net", "vk.com", "vk.ru"],
      `Photo ${position}`,
    );
    const source = await fetchWithTimeout(sourceUrl, { method: "GET" }, Math.max(timeoutMs, 60_000));
    const blob = await source.blob();
    if (!blob.size || blob.size > MAX_SOURCE_PHOTO_BYTES || (blob.type && !blob.type.toLowerCase().startsWith("image/"))) {
      throw new Error(`Photo ${position} is empty, too large, or is not an image`);
    }
    const uploadServer = await callVkMethod("photos.getWallUploadServer", { group_id: Math.abs(targetGroupId) }, userToken);
    const uploadUrl = checkedHttpsUrl(uploadServer?.upload_url, ["vk.com", "vk.ru"], `Photo ${position} upload server`);
    const form = new FormData();
    form.append("photo", blob, `vkr-server-copy-${position}.jpg`);
    const uploadedResponse = await fetchWithTimeout(uploadUrl, { method: "POST", body: form }, Math.max(timeoutMs, 60_000));
    const uploaded = await uploadedResponse.json();
    if (!uploaded?.photo || uploaded.server === undefined || !uploaded?.hash) {
      const error = new Error(`Photo ${position} upload response is incomplete`);
      error.transport = true;
      throw error;
    }
    const saved = await callVkMethod("photos.saveWallPhoto", {
      group_id: Math.abs(targetGroupId),
      photo: uploaded.photo,
      server: uploaded.server,
      hash: uploaded.hash,
    }, userToken);
    if (!Array.isArray(saved) || !saved[0]) throw new Error(`Photo ${position} was not saved by VK`);
    return buildUploadedPhotoAttachment(saved[0], photo);
  }

  return Object.freeze({
    async createUserComment({ groupId, postId, commentText, userToken, guid }) {
      return callVkMethod("wall.createComment", {
        owner_id: -Math.abs(groupId), post_id: postId, message: commentText,
        from_group: Math.abs(groupId), guid,
      }, userToken);
    },

    async publishCopiedPost({ sourceOwnerId, sourcePostId, targetGroupId, text, userToken, randomId }) {
      const post = await fetchSourcePost({ sourceOwnerId, sourcePostId, userToken });
      const attachments = Array.isArray(post.attachments) ? post.attachments : [];
      const photos = attachments.flatMap((attachment) => attachment?.type === "photo" && attachment.photo ? [attachment.photo] : []);
      const copiedPhotos = [];
      for (let index = 0; index < photos.length; index += 1) {
        copiedPhotos.push(await uploadCopiedPhoto({ photo: photos[index], targetGroupId, userToken, position: index + 1 }));
      }
      const reusable = buildReusableAttachments(attachments.filter((attachment) => attachment?.type !== "photo"));
      const params = {
        owner_id: -Math.abs(targetGroupId),
        from_group: 1,
        message: String(text || ""),
        random_id: Number(randomId) || 1,
      };
      const finalAttachments = [...copiedPhotos, ...reusable];
      if (finalAttachments.length) params.attachments = finalAttachments.join(",");
      const response = await callVkMethod("wall.post", params, userToken);
      return { postId: Number(response?.post_id) || null };
    },

    async repostToGroup({ sourceOwnerId, sourcePostId, targetGroupId, userToken }) {
      const response = await callVkMethod("wall.repost", {
        object: `wall${Number(sourceOwnerId)}_${Number(sourcePostId)}`,
        group_id: Math.abs(targetGroupId),
      }, userToken);
      return { postId: Number(response?.post_id) || null };
    },

    async createStoryUploadServer({ kind, groupId, userToken, linkUrl, linkText }) {
      const method = kind === "photo" ? "stories.getPhotoUploadServer" : "stories.getVideoUploadServer";
      return callVkMethod(method, { group_id: Math.abs(groupId), link_url: linkUrl, link_text: linkText }, userToken);
    },

    async uploadStoryMedia({ uploadUrl, kind, media, fileName, mimeType }) {
      const form = new FormData();
      const field = kind === "photo" ? "file" : "video_file";
      form.append(field, new Blob([media], { type: mimeType }), fileName);
      const response = await fetchWithTimeout(uploadUrl, { method: "POST", body: form }, Math.max(timeoutMs, 5 * 60_000));
      const text = await response.text();
      try { return JSON.parse(text); } catch { return text; }
    },

    async saveCommunityStory({ userToken, uploadResult }) {
      const parameters = typeof uploadResult === "string"
        ? { upload_results: uploadResult }
        : { upload_results_json: JSON.stringify([uploadResult]) };
      return callVkMethod("stories.save", parameters, userToken);
    },
  });
}

module.exports = { createVkClient };
