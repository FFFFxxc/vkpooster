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

test("delayed comments use an encrypted server-side user token with local fallback", () => {
  assert.match(background, /userToken/);
  const serverBlock = background.slice(
    background.indexOf('serverRequest("/api/scheduled-comments"'),
    background.indexOf("await scheduleLocalComment", background.indexOf('serverRequest("/api/scheduled-comments"')),
  );
  assert.match(serverBlock, /userToken/);
  assert.doesNotMatch(serverBlock, /groupToken/);
  assert.match(background, /serverRequest\("\/api\/scheduled-posts"/);
  assert.match(background, /scheduleMode:\s*"server_user"/);
});

test("comments are staggered between communities", () => {
  assert.match(background, /COMMENT_GROUP_INTERVAL_KEY/);
  assert.match(background, /groupPosition \* groupIntervalSeconds \* 1000/);
});
