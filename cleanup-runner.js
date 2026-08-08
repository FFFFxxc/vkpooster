(function exposeCleanupRunner(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VkrCleanupRunner = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const ITEM_INTERVAL_MS = 1_500;
  const RETRY_DELAYS_MS = [5_000, 15_000];

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function safeErrorMessage(error) {
    return String(error?.message || "VK error")
      .replace(
        /((?:access[_\s-]?token|token)\s*[=:]\s*)[^\s&]+/gi,
        "$1[redacted]",
      )
      .slice(0, 500);
  }

  function itemId(item) {
    return String(item?.id ?? item?.postId ?? item?.photoId ?? "unknown");
  }

  async function runCleanup({
    items,
    deleteItem,
    classifyError,
    shouldStop = () => false,
    onProgress = () => {},
    sleep = delay,
  }) {
    if (!Array.isArray(items)) throw new TypeError("items must be an array");
    if (typeof deleteItem !== "function") {
      throw new TypeError("deleteItem must be a function");
    }
    if (typeof classifyError !== "function") {
      throw new TypeError("classifyError must be a function");
    }

    const result = {
      status: "completed",
      completed: 0,
      deleted: 0,
      skipped: 0,
      errors: [],
      pausedError: null,
    };

    for (const item of items) {
      if (shouldStop()) return { ...result, status: "cancelled" };

      let retries = 0;
      while (true) {
        if (shouldStop()) return { ...result, status: "cancelled" };
        try {
          await deleteItem(item);
          result.deleted += 1;
          break;
        } catch (error) {
          const decision = classifyError(error) || { action: "fail" };
          const message = safeErrorMessage(error);
          if (decision.action === "pause") {
            return {
              ...result,
              status: "paused",
              pausedError: { code: Number(decision.code) || null, message },
            };
          }
          if (decision.action === "retry" && retries < RETRY_DELAYS_MS.length) {
            await sleep(RETRY_DELAYS_MS[retries]);
            retries += 1;
            continue;
          }
          result.skipped += 1;
          result.errors.push({ id: itemId(item), message });
          break;
        }
      }

      result.completed += 1;
      onProgress({ ...result, current: result.completed, total: items.length });
      if (result.completed < items.length && !shouldStop()) {
        await sleep(ITEM_INTERVAL_MS);
      }
    }

    return result;
  }

  return Object.freeze({
    ITEM_INTERVAL_MS,
    RETRY_DELAYS_MS,
    runCleanup,
    safeErrorMessage,
  });
});
