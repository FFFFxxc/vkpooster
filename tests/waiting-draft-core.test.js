"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  describeDraft,
  normalizeDraft,
} = require("../waiting-draft-core.js");

test("waiting draft normalizes groups and keeps every form field", () => {
  const draft = normalizeDraft({
    groups: [42, "43", 42, -1],
    mode: "repost",
    pubDateLocal: "2026-08-12T10:30",
    text: "Текст",
    commentText: "Комментарий",
    updatedAt: 123,
  }, { defaultText: "Исходный" });
  assert.deepEqual(draft.groups, [42, 43]);
  assert.equal(draft.mode, "repost");
  assert.equal(draft.pubDateLocal, "2026-08-12T10:30");
  assert.equal(draft.text, "Текст");
  assert.equal(draft.commentText, "Комментарий");
});

test("legacy waiting item receives readable defaults and a group summary", () => {
  const draft = normalizeDraft(null, { defaultText: "Исходный" });
  assert.deepEqual(draft.groups, []);
  assert.equal(draft.mode, "copy");
  assert.equal(draft.text, "Исходный");
  assert.equal(draft.pubDateLocal, "");
  assert.deepEqual(describeDraft(draft, { 42: "Первая", 43: "Вторая" }), {
    groupsText: "Паблики ещё не выбраны",
    timeText: "Время ещё не выбрано",
  });
  assert.deepEqual(describeDraft({ ...draft, groups: [42, 43], pubDateLocal: "2026-08-12T10:30" }, { 42: "Первая", 43: "Вторая" }), {
    groupsText: "Первая, Вторая",
    timeText: "12.08.2026, 10:30",
  });
});
