"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");

test("managed communities are discovered locally with the user token", () => {
  assert.match(background, /const USER_GROUPS_KEY = "vkr_user_groups"/);
  assert.match(background, /async function listManagedCommunities/);
  assert.match(background, /"groups\.get"/);
  assert.match(background, /filter: "admin,editor"/);
  assert.match(background, /count: 1000/);
  assert.match(background, /type === "list_managed_communities"/);
});

test("normal delayed comments stay local and server mode sends only a community token", () => {
  assert.match(background, /executionMode = "local_user"/);
  assert.match(background, /executionMode === "community_24_7" && groupToken/);
  const serverBlock = background.slice(
    background.indexOf('serverRequest("/api/scheduled-comments"'),
    background.indexOf("await scheduleLocalComment", background.indexOf('serverRequest("/api/scheduled-comments"')),
  );
  assert.match(serverBlock, /groupToken/);
  assert.doesNotMatch(serverBlock, /userToken|vk_token/);
});

test("comments are staggered between communities", () => {
  assert.match(background, /COMMENT_GROUP_INTERVAL_KEY/);
  assert.match(background, /groupPosition \* groupIntervalSeconds \* 1000/);
});
