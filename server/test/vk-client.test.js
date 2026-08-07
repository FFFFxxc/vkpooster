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

  await client.createGroupComment({
    groupId: 42,
    postId: 10,
    commentText: "comment",
    groupToken: "group-secret",
    guid: "stable-comment-guid",
  });

  assert.equal(requestUrl, "https://api.vk.com/method/wall.createComment");
  assert.equal(requestUrl.includes("group-secret"), false);
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.body.get("access_token"), "group-secret");
  assert.equal(requestOptions.body.get("guid"), "stable-comment-guid");
  assert.equal(requestOptions.body.get("from_group"), "42");
});
