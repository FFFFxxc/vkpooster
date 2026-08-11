(function exposeWaitingDraftCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.VkrWaitingDraftCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createWaitingDraftCore() {
  "use strict";

  function uniqueGroups(groups) {
    return [...new Set((Array.isArray(groups) ? groups : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  }

  function normalizeDraft(value, { defaultText = "" } = {}) {
    const draft = value && typeof value === "object" ? value : {};
    return {
      groups: uniqueGroups(draft.groups),
      mode: draft.mode === "repost" ? "repost" : "copy",
      text: typeof draft.text === "string" ? draft.text : String(defaultText || ""),
      commentText: typeof draft.commentText === "string" ? draft.commentText : "",
      pubDateLocal: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(draft.pubDateLocal || "")) ? String(draft.pubDateLocal) : "",
      updatedAt: Math.max(0, Number(draft.updatedAt) || 0),
    };
  }

  function describeDraft(value, labels = {}) {
    const draft = normalizeDraft(value);
    const groups = draft.groups.map((id) => labels[id] || labels[String(id)] || `club${id}`);
    const timeText = draft.pubDateLocal
      ? new Date(draft.pubDateLocal).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })
      : "Время ещё не выбрано";
    return {
      groupsText: groups.length ? groups.join(", ") : "Паблики ещё не выбраны",
      timeText,
    };
  }

  return { normalizeDraft, describeDraft };
});
