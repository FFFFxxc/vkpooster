"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createVkClient } = require("../src/vk-client.js");

test("VK client posts the token in the body and sends a stable guid", async () => {
  let requestUrl;
  let requestOptions;
  const client = createVkClient({
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return {
        ok: true,
        async json() {
          return { response: { comment_id: 99 } };
        },
      };
    },
  });

  await client.createUserComment({
    groupId: 42,
    postId: 10,
    commentText: "comment",
    userToken: "user-secret",
    guid: "stable-comment-guid",
  });

  assert.equal(requestUrl, "https://api.vk.com/method/wall.createComment");
  assert.equal(requestUrl.includes("user-secret"), false);
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.body.get("access_token"), "user-secret");
  assert.equal(requestOptions.body.get("guid"), "stable-comment-guid");
  assert.equal(requestOptions.body.get("from_group"), "42");
});

test("story upload server uses community fields and save sends upload result only", async () => {
  const requests = [];
  const client = createVkClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, async json() { return url.includes("getPhoto") ? { response: { upload_url: "https://upload.example" } } : { response: { count: 1, items: [{ id: 7 }] } }; } };
    },
  });
  await client.createStoryUploadServer({ kind: "photo", groupId: 42, userToken: "secret", linkUrl: "https://vk.ru/club42", linkText: "go_to" });
  await client.saveCommunityStory({ userToken: "secret", uploadResult: { response: "upload-result" } });
  assert.equal(requests[0].options.body.get("group_id"), "42");
  assert.equal(requests[0].options.body.get("link_url"), "https://vk.ru/club42");
  assert.equal(requests[0].url.includes("secret"), false);
  assert.equal(requests[1].options.body.has("link_url"), false);
  assert.match(requests[1].options.body.get("upload_results_json"), /upload-result/);
});

test("server copy publishes only at execution time and never sends publish_date", async () => {
  const requests = [];
  const client = createVkClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("wall.getById")) {
        return { ok: true, async json() { return { response: [{ owner_id: -100, id: 5, attachments: [] }] }; } };
      }
      return { ok: true, async json() { return { response: { post_id: 77 } }; } };
    },
  });

  const published = await client.publishCopiedPost({
    sourceOwnerId: -100,
    sourcePostId: 5,
    targetGroupId: 42,
    text: "Текст",
    userToken: "user-secret",
    randomId: 123,
  });

  assert.equal(published.postId, 77);
  assert.equal(requests[1].url, "https://api.vk.com/method/wall.post");
  assert.equal(requests[1].options.body.get("owner_id"), "-42");
  assert.equal(requests[1].options.body.get("access_token"), "user-secret");
  assert.equal(requests[1].options.body.has("publish_date"), false);
});
