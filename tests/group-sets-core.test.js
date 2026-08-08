"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_GROUPS_PER_SET,
  createGroupSet,
  normalizeGroupIds,
  normalizeGroupSets,
  resolveAvailableGroups,
  sameSelection,
  updateGroupSet,
} = require("../group-sets-core.js");

test("community IDs are normalised, deduplicated and bounded", () => {
  assert.deepEqual(normalizeGroupIds([1, "2", -3, "2", 0, "bad", null]), [
    "1",
    "2",
    "3",
  ]);

  const many = Array.from({ length: MAX_GROUPS_PER_SET + 20 }, (_, index) => index + 1);
  assert.equal(normalizeGroupIds(many).length, MAX_GROUPS_PER_SET);
});

test("stored sets recover safely from malformed local storage", () => {
  assert.deepEqual(
    normalizeGroupSets([
      { id: "first", name: "  Группа   1  ", groupIds: [10, "20", 10] },
      { id: "first", name: "Дубликат ID", groupIds: [30] },
      { id: "empty", name: "", groupIds: [40] },
      { id: "no-groups", name: "Без групп", groupIds: [] },
      null,
    ]),
    [
      {
        id: "first",
        name: "Группа 1",
        groupIds: ["10", "20"],
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  );
});

test("creating a set requires both a name and selected communities", () => {
  assert.throws(
    () => createGroupSet({ id: "new", name: "", groupIds: [1] }),
    /название/i,
  );
  assert.throws(
    () => createGroupSet({ id: "new", name: "Группа 1", groupIds: [] }),
    /хотя бы один паблик/i,
  );

  assert.deepEqual(
    createGroupSet({ id: "new", name: " Группа 1 ", groupIds: [5, "6"], now: 123 }),
    {
      id: "new",
      name: "Группа 1",
      groupIds: ["5", "6"],
      createdAt: 123,
      updatedAt: 123,
    },
  );
});

test("editing preserves identity and original creation time", () => {
  const updated = updateGroupSet(
    {
      id: "set_1",
      name: "Старое",
      groupIds: [1],
      createdAt: 100,
      updatedAt: 100,
    },
    { name: "Новое", groupIds: [2, 3], now: 200 },
  );

  assert.deepEqual(updated, {
    id: "set_1",
    name: "Новое",
    groupIds: ["2", "3"],
    createdAt: 100,
    updatedAt: 200,
  });
});

test("applying a set separates visible and unavailable communities", () => {
  assert.deepEqual(resolveAvailableGroups([1, 2, 3], [3, 1, 9]), {
    selectedIds: ["1", "3"],
    missingIds: ["2"],
  });
  assert.equal(sameSelection([1, "2", 2], [2, 1]), true);
  assert.equal(sameSelection([1, 2], [1, 3]), false);
});
