(function exposeGroupSetsCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VkrGroupSetsCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const MAX_SETS = 50;
  const MAX_GROUPS_PER_SET = 500;
  const MAX_NAME_LENGTH = 48;

  function normalizeGroupId(value) {
    const id = Math.abs(Number(value));
    return Number.isSafeInteger(id) && id > 0 ? String(id) : "";
  }

  function normalizeGroupIds(values) {
    const unique = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const id = normalizeGroupId(value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
      if (unique.length >= MAX_GROUPS_PER_SET) break;
    }
    return unique;
  }

  function normalizeName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME_LENGTH);
  }

  function normalizeSetId(value, fallbackIndex = 0) {
    const id = String(value || "").trim();
    return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : `legacy_${fallbackIndex}`;
  }

  function normalizeGroupSets(rawSets) {
    const normalized = [];
    const ids = new Set();
    for (const [index, raw] of (Array.isArray(rawSets) ? rawSets : []).entries()) {
      if (!raw || typeof raw !== "object") continue;
      const name = normalizeName(raw.name);
      const groupIds = normalizeGroupIds(raw.groupIds);
      const id = normalizeSetId(raw.id, index);
      if (!name || !groupIds.length || ids.has(id)) continue;
      ids.add(id);
      normalized.push({
        id,
        name,
        groupIds,
        createdAt: Number(raw.createdAt) || 0,
        updatedAt: Number(raw.updatedAt) || 0,
      });
      if (normalized.length >= MAX_SETS) break;
    }
    return normalized;
  }

  function createGroupSet({ id, name, groupIds, now = Date.now() }) {
    const normalizedName = normalizeName(name);
    const normalizedIds = normalizeGroupIds(groupIds);
    const normalizedId = normalizeSetId(id, now);
    if (!normalizedName) throw new Error("Введите название набора.");
    if (!normalizedIds.length) throw new Error("Выберите хотя бы один паблик.");
    return {
      id: normalizedId,
      name: normalizedName,
      groupIds: normalizedIds,
      createdAt: Number(now) || Date.now(),
      updatedAt: Number(now) || Date.now(),
    };
  }

  function updateGroupSet(existing, { name, groupIds, now = Date.now() }) {
    if (!existing || typeof existing !== "object") {
      throw new Error("Набор не найден.");
    }
    const updated = createGroupSet({
      id: existing.id,
      name,
      groupIds,
      now,
    });
    updated.createdAt = Number(existing.createdAt) || updated.createdAt;
    return updated;
  }

  function sameSelection(left, right) {
    const a = normalizeGroupIds(left).sort();
    const b = normalizeGroupIds(right).sort();
    return a.length === b.length && a.every((id, index) => id === b[index]);
  }

  function resolveAvailableGroups(groupIds, availableIds) {
    const wanted = normalizeGroupIds(groupIds);
    const available = new Set(normalizeGroupIds(availableIds));
    return {
      selectedIds: wanted.filter((id) => available.has(id)),
      missingIds: wanted.filter((id) => !available.has(id)),
    };
  }

  return Object.freeze({
    MAX_GROUPS_PER_SET,
    MAX_NAME_LENGTH,
    MAX_SETS,
    createGroupSet,
    normalizeGroupIds,
    normalizeGroupSets,
    normalizeName,
    resolveAvailableGroups,
    sameSelection,
    updateGroupSet,
  });
});
