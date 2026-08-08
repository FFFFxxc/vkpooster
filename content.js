/**
 * VK Reposter Pro - Content Script
 * Modern UI with Glassmorphism Design
 * @version 4.3.1
 * @updated 2026-08-09
 */

// ========== CONSTANTS ==========
const BUTTON_CLASS = "vkr-btn";
const PROCESSED_ATTR = "data-vkr-checked";
const VKR_VERSION = "4.3.1";
const GROUP_SETS_STORAGE_KEY = "vkr_group_sets_v1";
const groupSetsCore = globalThis.VkrGroupSetsCore;
const POST_SELECTORS = '[data-post-id], div[id^="post-"], article[data-post-id], .post, .wall_item, .feed_row, .Post, [data-testid="post-root"], [data-testid="post"]';
const IGNORE_SELECTOR = '.reply, .wl_reply, [class*="CommentItem"], [class*="ReplyItem"], [class*="vkitComment"], [data-testid*="comment"], [id^="reply"], [id^="photo_comment"], [id^="video_comment"], .FCThumb, .FCPanel__list, [id*="fastchat"], [class*="FastChat"]';

// В safe-версии служебной бывает только текущая страница загрузки клипа.
// Старый постоянный флаг sessionStorage переживал переход на страницу паблика
// в той же вкладке и навсегда скрывал там кнопки расширения.
const clipAutomationJobId = /^\/clips/.test(location.pathname)
  ? new URLSearchParams(location.hash.replace(/^#/, "")).get("vkr_clip_job")
  : null;
const isAutomationTab = Boolean(clipAutomationJobId);
if (!isAutomationTab) {
  sessionStorage.removeItem("vkr_automation_tab");
  sessionStorage.removeItem("vkr_active_upload_id");
}
console.log("[VKR] Content script loaded, version:", VKR_VERSION, "isAutomationTab:", isAutomationTab);

/** True на странице клипов — там не нужны кнопки постов, комментариев и FAB. */
function isClipsPage() {
  return /^\/clips/.test(location.pathname);
}

// ========== EXTENSION CONTEXT GUARD ==========
// Проверяем, жив ли контекст расширения. После перезагрузки/обновления
// расширения chrome.runtime.id становится undefined.
function isContextAlive() {
  try {
    return !!chrome?.runtime?.id;
  } catch (e) {
    return false;
  }
}

let _invalidatedNotified = false;
function handleContextInvalidated() {
  if (_invalidatedNotified) return;
  _invalidatedNotified = true;
  try {
    const div = document.createElement("div");
    div.textContent =
      "🔄 Расширение обновлено. Нажмите F5, чтобы продолжить работу.";
    div.style.cssText = [
      "position:fixed",
      "top:16px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "background:#1e1e2e",
      "color:#fff",
      "padding:14px 22px",
      "border-radius:12px",
      "font-size:13px",
      "font-family:system-ui,sans-serif",
      "box-shadow:0 4px 24px rgba(0,0,0,0.6)",
      "border:1px solid rgba(99,102,241,0.4)",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 7000);
  } catch (_) { }
}

// Перехватываем все необработанные режекции с этой ошибкой в одном месте
window.addEventListener("unhandledrejection", (event) => {
  const msg = event.reason?.message || "";
  if (msg.includes("Extension context invalidated")) {
    event.preventDefault(); // не показываем в консоли
    handleContextInvalidated();
  }
});

let tok = null;
let post = null;
let grps = [];
let mode = "copy";
let modalEl = null;
let groupSets = [];
let editingGroupSetId = null;

// Comment modal variables
let sRoot = null;
let commentModalEl = null;
let currentCommentPostId = null;

// Best posts modal variables
let bestPostsModalEl = null;
let currentOwnerId = null;
let isLoadingPosts = false;
let loadedPosts = [];

// ========== API via background ==========
async function sendMessage(type, data) {
  return new Promise((resolve, reject) => {
    if (!isContextAlive()) {
      handleContextInvalidated();
      return reject(new Error("Расширение обновлено. Нажмите F5!"));
    }

    chrome.runtime.sendMessage({ type, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.ok) {
        resolve(response);
      } else {
        const errorMsg = response?.error || "Unknown error";
        if (
          errorMsg.includes("Auth failed") ||
          errorMsg.includes("invalid access_token")
        ) {
          showCustomAlert("❌ Токен недействителен. Авторизуйтесь заново.");
          chrome.storage.local.remove("vk_token");
        }
        reject(new Error(errorMsg));
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(min = 3000, max = 7000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(delay);
}

async function fetchClipSourcesById(clipId) {
  return null;
  void clipId;
}

// Слушаем сообщения от инъектированного скрипта
window.addEventListener("message", async function (event) {
  if (event.source !== window) return;

  const { type } = event.data || {};

  // Прокси-запрос качеств видео через API в background
  if (type === "VKR_REQUEST_VIDEO_QUALITIES") {
    window.postMessage(
      {
        type: "VKR_RESPONSE_VIDEO_QUALITIES",
        videoId: event.data.videoId,
        ok: false,
        files: null,
        title: null,
        error: "Скачивание видео отключено в безопасной версии.",
      },
      "*",
    );
    return;
  }
});

// ========== POST DETECTION ==========
function getPostIdFromElement(postEl) {
  if (!postEl) return null;
  let dataId = postEl.getAttribute("data-post-id") || postEl.dataset?.postId;
  if (!dataId) {
    const desc = postEl.querySelector('[data-post-id]');
    if (desc) {
      dataId = desc.getAttribute("data-post-id") || desc.dataset?.postId;
    }
  }
  if (dataId) {
    return dataId.startsWith("wall") ? dataId : `wall${dataId}`;
  }
  if (postEl.id && postEl.id.startsWith("post-")) {
    return `wall${postEl.id.replace("post-", "")}`;
  }
  const link = postEl.querySelector('a[href*="wall"], a[href*="post"]');
  if (link) {
    const m = link.href.match(/wall-?\d+_\d+/);
    if (m) return m[0];
  }
  return null;
}

function getPostUrl(postEl) {
  const id = getPostIdFromElement(postEl);
  if (!id) return null;
  return `https://vk.com/${id}`;
}

function findActionsContainer(postEl) {
  const like = postEl.querySelector('[data-testid="post_footer_action_like"], [data-testid^="post_footer_action"]');
  if (like && like.parentElement) return like.parentElement;

  const selectors = [
    '[data-testid="post-bottom-actions"]',
    ".PostActions",
    ".post_actions",
    ".post_actions_btns",
    ".PostActionsWrapper",
    ".PostActionsBottom",
    ".PostBottomActions",
    ".PostFooter",
    ".post_footer",
    '[class*="PostActions"]',
    '[class*="post_actions"]',
    '[class*="PostBottom"]',
    '[class*="PostFooter"]',
    ".like_wrap",
    ".like_cont",
    '[class*="like_wrap"]',
    '[class*="like_cont"]',
  ];

  const ignoreSelector = IGNORE_SELECTOR;

  for (const selector of selectors) {
    const elements = postEl.querySelectorAll(selector);
    for (const el of elements) {
      if (!el.closest(ignoreSelector)) {
        return el;
      }
    }
  }

  const actionButtons = postEl.querySelectorAll(
    'button[aria-label*="Нравится"], button[aria-label*="Мне нравится"], a[aria-label*="Нравится"], [data-like-button], [data-testid="post-like-button"]',
  );

  for (const btn of actionButtons) {
    if (!btn.closest(ignoreSelector)) {
      return (
        btn.closest(
          '[class*="Actions"], [class*="actions"], [class*="PostButton"], [class*="like"]',
        ) || btn.parentElement
      );
    }
  }

  return postEl;
}

// ========== BUTTON INJECTION ==========
function addButton(postEl) {
  if (!postEl) return;
  postEl = postEl.closest('article, [data-testid="post"]') || postEl;

  if (!getPostIdFromElement(postEl)) return;

  // Не показываем кнопки в уведомлениях
  // Проверяем, находится ли пост внутри контейнера уведомлений
  if (
    postEl.closest("#top_notify_cont") ||
    postEl.closest("#top_notify_wrap") ||
    postEl.closest(".top_notify_wrap") ||
    postEl.closest(".feedback_row_wrap") ||
    postEl.closest(".NotificationsFeedPage") ||
    postEl.closest('[class*="Notifications"]') ||
    postEl.closest('[id*="notifications"]') ||
    postEl.closest('[id*="top_notify"]')
  ) {
    return;
  }

  const actions = findActionsContainer(postEl);
  if (!actions) return;

  if (postEl.querySelector(`.${BUTTON_CLASS}`)) return;

  // Создаём отдельный контейнер для кнопок расширения
  const vkrContainer = document.createElement("div");
  vkrContainer.className = "vkr-buttons-container";
  vkrContainer.style.cssText = `
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
    margin-top: 8px !important;
    margin-left: 12px !important;
    flex-wrap: wrap !important;
  `;

  // Repost button - используем только CSS-классы
  const btnRepost = document.createElement("button");
  btnRepost.type = "button";
  btnRepost.className = BUTTON_CLASS;
  btnRepost.innerHTML = "📋 В группы";

  btnRepost.addEventListener("click", async (event) => {
    event.stopPropagation();
    event.preventDefault();
    const postUrl = getPostUrl(postEl);
    if (!postUrl)
      return showCustomAlert("Не удалось определить ссылку на пост.");
    await openModal(postUrl);
  });
  vkrContainer.appendChild(btnRepost);

  // Comment button - используем только CSS-классы
  const btnComment = document.createElement("button");
  btnComment.type = "button";
  btnComment.className = `${BUTTON_CLASS} vkr-btn-comment`;
  btnComment.innerHTML = "💬 Коммент";

  btnComment.addEventListener("click", async (event) => {
    event.stopPropagation();
    event.preventDefault();
    const postUrl = getPostUrl(postEl);
    if (!postUrl)
      return showCustomAlert("Не удалось определить ссылку на пост.");
    await openCommentModal(postUrl);
  });
  vkrContainer.appendChild(btnComment);

  // Pending button - используем только CSS-классы
  const btnPending = document.createElement("button");
  btnPending.type = "button";
  btnPending.className = `${BUTTON_CLASS} vkr-btn-pending`;
  btnPending.innerHTML = "⏳ В ожидания";

  btnPending.addEventListener("click", async (event) => {
    event.stopPropagation();
    event.preventDefault();
    const postUrl = getPostUrl(postEl);
    if (!postUrl)
      return showCustomAlert("Не удалось определить ссылку на пост.");
    await addPostToPending(postUrl);
  });
  vkrContainer.appendChild(btnPending);

  // Ищем родительский контейнер actions (обычно это div с классом содержащим "Actions" или "Footer")
  if (actions === postEl) {
    postEl.appendChild(vkrContainer);
    console.warn("[VKR] Actions container not found, appending to post root", postEl);
  } else {
    let actionsParent = actions.parentElement;

    // Если actions.parentElement это тот же postEl, добавляем после actions
    if (actionsParent === postEl || !actionsParent) {
      actions.parentElement.insertBefore(vkrContainer, actions.nextSibling);
    } else {
      // Иначе добавляем после родительского контейнера actions
      actionsParent.parentElement.insertBefore(
        vkrContainer,
        actionsParent.nextSibling,
      );
    }
  }
}

function processPosts(root = document) {
  // Удаляем ошибочно вставленные кнопки в чатах
  document.querySelectorAll('.FCThumb .vkr-buttons-container').forEach((el) => el.remove());

  const posts = root.querySelectorAll(POST_SELECTORS);
  const ignoreSelector = IGNORE_SELECTOR;

  const roots = new Set();
  posts.forEach((postEl) => {
    const r = postEl.closest('article, [data-testid="post"]') || postEl;
    roots.add(r);
  });

  console.log("[VKR] processPosts: найдено постов:", roots.size);

  roots.forEach((postRoot) => {
    if (postRoot.matches(ignoreSelector) || postRoot.closest(ignoreSelector))
      return;
    if (postRoot.querySelector(`.${BUTTON_CLASS}`)) return;

    if (!postRoot.getAttribute(PROCESSED_ATTR)) {
      postRoot.setAttribute(PROCESSED_ATTR, "1");
    }

    addButton(postRoot);
  });
}

// ========== COMMENT BOOST INJECTION ==========
function addCommentButtons(comment) {
  // Multi-account likes and paid boosting were removed in v4 safe mode.
  return;

  let fullId = null;
  let itemType = "comment";

  const reactBtn = comment.querySelector(
    "[data-reaction-id], [data-object-id], [data-item-id]",
  );
  if (reactBtn) {
    const rawId =
      reactBtn.getAttribute("data-reaction-id") ||
      reactBtn.getAttribute("data-object-id") ||
      reactBtn.getAttribute("data-item-id");
    if (rawId) {
      const m = rawId.match(/(video_comment|photo_comment|comment)?-?\d+_\d+/);
      if (m) {
        fullId = m[0].replace(/^(video_comment|photo_comment|comment)/, "");
        if (rawId.includes("video_comment")) itemType = "video_comment";
        else if (rawId.includes("photo_comment")) itemType = "photo_comment";
      }
    }
  }

  if (!fullId && comment.id) {
    const m = comment.id.match(
      /(video_comment|photo_comment|reply|comment)(-?\d+_\d+)/,
    );
    if (m) {
      fullId = m[2];
      if (m[1] === "video_comment") itemType = "video_comment";
      else if (m[1] === "photo_comment") itemType = "photo_comment";
    }
  }

  if (!fullId) {
    const timeLink = comment.querySelector('a[href*="reply="]');
    if (timeLink) {
      const m = timeLink
        .getAttribute("href")
        .match(/(video|photo|wall)(-?\d+_\d+)\?reply=(\d+)/);
      if (m) {
        fullId = m[2].split("_")[0] + "_" + m[3];
        if (m[1] === "video") itemType = "video_comment";
        else if (m[1] === "photo") itemType = "photo_comment";
      }
    }
  }

  if (!fullId || !fullId.includes("_")) return;

  const parts = fullId.match(/(-?\d+)_(\d+)/);
  if (!parts) return;

  const ownerId = parts[1];
  const commentId = parts[2];

  let targetContainer = null;

  const likeContainers = comment.querySelectorAll(
    '[class*="likeShowOnHover"], [class*="CommentLike"], [class*="groupLike"]',
  );
  for (const container of likeContainers) {
    const likeBtn = container.querySelector(
      '[aria-label*="лайк"], [data-testid*="like"], svg[class*="like"]',
    );
    if (likeBtn && !container.querySelector(".vkr-boost-btn")) {
      const style = window.getComputedStyle(container);
      if (style.display !== "none" && style.visibility !== "hidden") {
        targetContainer = container;
        break;
      }
    }
  }

  if (!targetContainer) {
    const likeButton = comment.querySelector(
      '[aria-label*="Нравится"], [aria-label*="лайк"], [data-testid="comment-liked"]',
    );
    if (likeButton) {
      targetContainer =
        likeButton.closest('[class*="like"]') || likeButton.parentElement;
    }
  }

  if (!targetContainer) return;

  if (
    !targetContainer.style.display ||
    targetContainer.style.display === "none"
  ) {
    targetContainer.style.display = "flex";
  }
  targetContainer.style.alignItems = "center";
  targetContainer.style.gap = "4px";

  const btn = document.createElement("button");
  btn.className = "vkr-boost-btn";
  btn.innerHTML = "🤖";
  btn.title = "Накрутить лайки со всех аккаунтов";
  btn.type = "button";

  btn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.innerHTML = "⏳";
    btn.disabled = true;
    btn.classList.add("loading");
    showToast("🤖 Накручиваем лайки...", "info");

    try {
      // Пытаемся получить postId через подъём по DOM
      let postId = null;
      try {
        let parent = comment.parentElement;
        while (parent) {
          if (parent.id && (parent.id.startsWith('post') || parent.id.startsWith('wall'))) {
            const postMatch = parent.id.match(/post(-?\d+)_(\d+)/) || parent.id.match(/wall(-?\d+)_(\d+)/);
            if (postMatch) {
              postId = postMatch[2];
              break;
            }
          }
          if (parent.dataset && parent.dataset.postId) {
            postId = parent.dataset.postId;
            break;
          }
          parent = parent.parentElement;
        }
      } catch (err) {
        // silently fail
      }

      const res = await sendMessage("boost_comment", {
        ownerId,
        commentId,
        postId,
        itemType,
      });
      if (res.ok) {
        showToast(`✅ Успешно! Поставлено ${res.count} лайков`, "success");
        btn.innerHTML = "❤️";
        btn.classList.remove("loading");
        btn.classList.add("success");
      } else {
        showToast(`❌ Ошибка: ${res.error}`, "error");
        btn.innerHTML = "🤖";
        btn.classList.remove("loading");
      }
    } catch (err) {
      showToast(`❌ Ошибка: ${err.message}`, "error");
      btn.innerHTML = "🤖";
      btn.classList.remove("loading");
    }
    btn.disabled = false;
  };

  // Новая кнопка для накрутки через TwiBoost
  const twiBoostBtn = document.createElement("button");
  twiBoostBtn.className = "vkr-twiboost-btn";
  twiBoostBtn.innerHTML = "🚀";
  twiBoostBtn.title = "Накрутить лайки через TwiBoost";
  twiBoostBtn.type = "button";

  twiBoostBtn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Формируем ссылку на комментарий
    const currentUrl = window.location.href;
    let commentUrl = "";

    // Определяем тип страницы и формируем ссылку
    if (currentUrl.includes("/wall")) {
      // Страница поста
      const wallMatch = currentUrl.match(/wall(-?\d+_\d+)/);
      if (wallMatch) {
        commentUrl = `https://vk.com/wall${wallMatch[1]}?reply=${commentId}`;
      }
    } else if (currentUrl.includes("/photo")) {
      // Страница фото
      const photoMatch = currentUrl.match(/photo(-?\d+_\d+)/);
      if (photoMatch) {
        commentUrl = `https://vk.com/photo${photoMatch[1]}?reply=${commentId}`;
      }
    } else if (currentUrl.includes("/video")) {
      // Страница видео
      const videoMatch = currentUrl.match(/video(-?\d+_\d+)/);
      if (videoMatch) {
        commentUrl = `https://vk.com/video${videoMatch[1]}?reply=${commentId}`;
      }
    } else {
      // Попробуем найти ссылку на комментарий в DOM
      const timeLink = comment.querySelector('a[href*="reply="]');
      if (timeLink) {
        commentUrl = timeLink.href;
      } else {
        // Fallback - используем текущий URL и добавляем reply
        commentUrl = `${currentUrl.split("?")[0]}?reply=${commentId}`;
      }
    }

    // Сначала открываем модал накрутки
    await openBoostModal(commentUrl, comment, "comment");

    // Затем копируем ссылку в буфер обмена
    try {
      await navigator.clipboard.writeText(commentUrl);
      showToast(`📋 Ссылка скопирована в буфер обмена`, "success");
    } catch (err) {
      // Fallback для старых браузеров
      const textArea = document.createElement("textarea");
      textArea.value = commentUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      showToast(`📋 Ссылка скопирована в буфер обмена`, "success");
    }
  };

  targetContainer.appendChild(btn);
  targetContainer.appendChild(twiBoostBtn);
}

function processComments(root = document) {
  // Comment-like automation is disabled in safe mode.
  return;

  const comments = root.querySelectorAll(
    '.reply, .wl_reply, [class*="ReplyItem"], [class*="CommentItem"], [class*="vkitComment"], [data-testid*="comment"], [id^="reply"], [id^="photo_comment"], [id^="video_comment"]',
  );

  comments.forEach((comment) => {
    try {
      if (comment.hasAttribute("data-vkr-boost-processed")) return;
      if (comment.querySelector(".vkr-boost-btn")) return;

      comment.setAttribute("data-vkr-boost-processed", "1");
      addCommentButtons(comment);
    } catch (err) {
      console.error("[VKR] Error processing comment:", err);
    }
  });
}

function showToast(text, type = "info") {
  const colors = {
    success: {
      bg: 'linear-gradient(135deg, rgba(6, 78, 59, 0.85), rgba(4, 120, 87, 0.85))',
      border: 'rgba(52, 211, 153, 0.35)',
      shadow: '0 8px 32px rgba(4, 120, 87, 0.25)'
    },
    error: {
      bg: 'linear-gradient(135deg, rgba(136, 19, 55, 0.85), rgba(159, 18, 57, 0.85))',
      border: 'rgba(251, 113, 133, 0.35)',
      shadow: '0 8px 32px rgba(159, 18, 57, 0.25)'
    },
    info: {
      bg: 'linear-gradient(135deg, rgba(30, 27, 75, 0.85), rgba(67, 56, 202, 0.85))',
      border: 'rgba(129, 140, 248, 0.35)',
      shadow: '0 8px 32px rgba(67, 56, 202, 0.25)'
    },
    warning: {
      bg: 'linear-gradient(135deg, rgba(120, 53, 4, 0.85), rgba(180, 83, 9, 0.85))',
      border: 'rgba(251, 191, 36, 0.35)',
      shadow: '0 8px 32px rgba(180, 83, 9, 0.25)'
    }
  };
  const c = colors[type] || colors.info;
  const icons = { success: "✅ ", error: "❌ ", warning: "⚠️ ", info: "ℹ️ " };
  let icon = icons[type] || "";
  if (text.startsWith("✅") || text.startsWith("❌") || text.startsWith("⚠️") || text.startsWith("ℹ️") || text.startsWith("ℹ") || text.startsWith("⏹") || text.startsWith("⏳") || text.startsWith("❤️") || text.startsWith("🤖") || text.startsWith("🚀") || text.startsWith("⬇️")) {
    icon = "";
  }

  // Inject keyframes once
  if (!document.getElementById('vkr-bounce-css')) {
    const st = document.createElement('style');
    st.id = 'vkr-bounce-css';
    st.textContent = `
      @keyframes vkr-bounceInDown {
        0% { opacity: 0; transform: translateY(-120px); }
        60% { opacity: 1; transform: translateY(10px); }
        80% { transform: translateY(-5px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes vkr-bounceOutUp {
        0% { opacity: 1; transform: translateY(0); }
        100% { opacity: 0; transform: translateY(-120px); }
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  const existing = document.querySelector('.vkr-toast-notify');
  if (existing) existing.remove();

  const d = document.createElement('div');
  d.className = 'vkr-toast-notify';
  d.style.cssText = 'position:fixed!important;top:20px!important;left:50%!important;translate:-50% 0!important;padding:14px 24px!important;background:' + c.bg + '!important;border:1px solid ' + c.border + '!important;border-radius:12px!important;font-size:14px!important;font-weight:500!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;box-shadow:' + c.shadow + '!important;z-index:999999999!important;animation:vkr-bounceInDown 0.6s cubic-bezier(0.34,1.56,0.64,1) forwards!important;max-width:400px!important;min-width:200px!important;width:auto!important;height:auto!important;min-height:40px!important;max-height:200px!important;white-space:normal!important;text-align:center!important;backdrop-filter:blur(12px)!important;-webkit-backdrop-filter:blur(12px)!important;pointer-events:auto!important;display:flex!important;align-items:center!important;justify-content:center!important;box-sizing:border-box!important;overflow:visible!important;line-height:1.5!important;bottom:auto!important;';

  const sp = document.createElement('span');
  sp.style.cssText = 'display:block!important;color:#fff!important;font-size:14px!important;font-weight:500!important;line-height:1.5!important;text-shadow:0 1px 2px rgba(0,0,0,0.2)!important;opacity:1!important;visibility:visible!important;';
  sp.textContent = icon + text;
  d.appendChild(sp);

  document.body.appendChild(d);

  setTimeout(function () {
    d.style.setProperty('animation', 'vkr-bounceOutUp 0.35s ease-in forwards', 'important');
    setTimeout(function () { d.remove(); }, 400);
  }, 3000);
}

// Expose for console debugging
window.showToast = showToast;

async function fetchImageAsDataUrl(url) {
  const res = await sendMessage("fetch_image", { url });
  return res.dataUrl;
}

async function compressImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      const maxSize = 1280;
      if (width > maxSize || height > maxSize) {
        if (width > height) {
          height = Math.round((height * maxSize) / width);
          width = maxSize;
        } else {
          width = Math.round((width * maxSize) / height);
          height = maxSize;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Failed to load image in Canvas"));
    img.src = dataUrl;
  });
}

async function addPostToPending(postUrl) {
  showToast("⏳ Загрузка поста для добавления в ожидания...", "info");

  if (!chrome || !chrome.storage || !chrome.storage.local) {
    return showCustomAlert("❌ Скрипт обновлен. Нажмите F5!");
  }

  const d = await chrome.storage.local.get(["vk_token", "vkr_waiting_posts"]);
  if (!d.vk_token) {
    return showCustomAlert("❌ Сначала авторизуйтесь!");
  }

  try {
    const response = await Promise.race([
      sendMessage("load_post", { postUrl, token: d.vk_token }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout 15 сек")), 15000)
      )
    ]);

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Не удалось загрузить пост");
    }

    const postData = response.post;
    const waitingPosts = d.vkr_waiting_posts || [];

    // Проверим, есть ли он уже
    const exists = waitingPosts.some(p => p.url === postUrl || (p.post && p.post.id === postData.id && p.post.owner_id === postData.owner_id));
    if (exists) {
      showToast("⚠️ Этот пост уже в ожиданиях!", "warning");
      return;
    }

    const photoDataUrls = [];
    if (postData.attachments && Array.isArray(postData.attachments)) {
      const photos = postData.attachments.filter(a => a.type === "photo" && a.photo);
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i].photo;
        const sizes = photo.sizes || [];
        if (sizes.length > 0) {
          const largestSize = sizes[sizes.length - 1];
          const photoUrl = largestSize.url;
          try {
            const dataUrl = await fetchImageAsDataUrl(photoUrl);
            photoDataUrls.push(dataUrl);
          } catch (err) {
            console.error(`[VKR] Failed to download photo ${i + 1}:`, err);
            showToast(`Фото ${i + 1} не удалось сохранить`, "warning");
          }
        }
      }
    }

    let totalSize = photoDataUrls.reduce((sum, du) => sum + du.length, 0);
    if (totalSize > 8 * 1024 * 1024) {
      console.log(`[VKR] Total photo size ${totalSize} bytes is > 8MB. Compressing...`);
      for (let i = 0; i < photoDataUrls.length; i++) {
        try {
          photoDataUrls[i] = await compressImage(photoDataUrls[i]);
        } catch (e) {
          console.warn(`[VKR] Failed to compress image ${i}:`, e.message);
        }
      }
    }

    waitingPosts.push({
      id: Date.now().toString() + "_" + Math.floor(Math.random() * 1000),
      url: postUrl,
      post: postData,
      photoDataUrls: photoDataUrls,
      addedAt: Date.now()
    });

    await chrome.storage.local.set({ vkr_waiting_posts: waitingPosts });
    showToast("✅ Пост успешно добавлен в список ожидания!", "success");
  } catch (e) {
    showToast("❌ Ошибка: " + e.message, "error");
  }
}

// ========== INIT OBSERVER ==========
// Константы для оптимизации производительности
const DEBOUNCE_DELAY = 500; // Увеличено с 400ms для снижения нагрузки
const THROTTLE_DELAY = 1000; // Для throttling повторных вызовов
const SCROLL_DEBOUNCE = 1000; // Увеличено с 800ms

let debounceTimeout;
let lastProcessTime = 0;
let isProcessing = false;

// Оптимизированная функция обработки с throttling
async function processWithThrottle() {
  const now = Date.now();

  // Throttling: не обрабатываем чаще чем раз в секунду
  if (now - lastProcessTime < THROTTLE_DELAY) {
    return;
  }

  // Предотвращаем параллельное выполнение
  if (isProcessing) {
    return;
  }

  isProcessing = true;
  lastProcessTime = now;

  try {
    // Обрабатываем только видимую область + небольшой запас
    const viewportHeight = window.innerHeight;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const visibleArea = {
      top: scrollTop - viewportHeight,
      bottom: scrollTop + viewportHeight * 2,
    };

    // Находим только посты в видимой области
    const allPosts = document.querySelectorAll(POST_SELECTORS);

    const roots = new Set();
    allPosts.forEach((postEl) => {
      const r = postEl.closest('article, [data-testid="post"]') || postEl;
      roots.add(r);
    });

    const visibleRoots = Array.from(roots).filter((postRoot) => {
      const rect = postRoot.getBoundingClientRect();
      const postTop = rect.top + scrollTop;
      return postTop >= visibleArea.top && postTop <= visibleArea.bottom;
    });

    console.log("[VKR] processWithThrottle: видимых постов:", visibleRoots.length);

    // Обрабатываем только видимые посты
    const ignoreSelector = IGNORE_SELECTOR;

    visibleRoots.forEach((postRoot) => {
      if (postRoot.matches(ignoreSelector) || postRoot.closest(ignoreSelector))
        return;
      if (postRoot.querySelector(`.${BUTTON_CLASS}`)) return;

      if (!postRoot.getAttribute(PROCESSED_ATTR)) {
        postRoot.setAttribute(PROCESSED_ATTR, "1");
      }

      addButton(postRoot);
    });

  } catch (err) {
    console.error("[VKR] Error in processWithThrottle:", err);
  } finally {
    isProcessing = false;
  }
}

// Находим контейнер с постами для более точного наблюдения
// ========== Event Handlers Cleanup System ==========
const eventHandlers = {
  scroll: null,
  observer: null,
  urlObserver: null,
  timers: new Set(),
};

function cleanupEventHandlers() {
  // Remove scroll listener
  if (eventHandlers.scroll) {
    window.removeEventListener("scroll", eventHandlers.scroll);
    eventHandlers.scroll = null;
  }

  // Disconnect observers
  if (eventHandlers.observer) {
    eventHandlers.observer.disconnect();
    eventHandlers.observer = null;
  }

  if (eventHandlers.urlObserver) {
    eventHandlers.urlObserver.disconnect();
    eventHandlers.urlObserver = null;
  }

  // Clear all timers
  eventHandlers.timers.forEach((timer) => clearTimeout(timer));
  eventHandlers.timers.clear();

  console.log("[VKR] Event handlers cleaned up");
}

// Cleanup on page unload
window.addEventListener("beforeunload", cleanupEventHandlers);

// ========== Posts Container Detection ==========
function findPostsContainer() {
  // Ищем основной контейнер с постами (feed)
  const containers = [
    document.getElementById("page_wall_posts"),
    document.getElementById("feed_rows"),
    document.querySelector('[id^="feed"]'),
    document.querySelector(".feed_rows"),
    document.querySelector('[class*="wall_posts"]'),
    document.querySelector("main"),
    document.body,
  ];

  return containers.find((c) => c !== null) || document.body;
}

// MutationObserver с оптимизацией - наблюдаем только за контейнером постов
// На странице клипов не запускаем — она непрерывно мутирует, вызывая шторм пересканирований
if (!isClipsPage() && !isAutomationTab) {
  const postsContainer = findPostsContainer();
  eventHandlers.observer = new MutationObserver((mutations) => {
    // Проверяем, есть ли реальные изменения в постах
    const hasRelevantChanges = mutations.some((mutation) => {
      // Игнорируем изменения атрибутов (style, class и т.д.)
      if (mutation.type !== "childList") return false;

      // Проверяем, добавлены ли новые узлы
      if (mutation.addedNodes.length === 0) return false;

      // Проверяем, есть ли среди добавленных узлов посты или комментарии
      return Array.from(mutation.addedNodes).some((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return false;

        const el = node;
        // Проверяем, является ли элемент постом
        if (el.matches?.(POST_SELECTORS)) {
          return true;
        }

        // Проверяем, содержит ли элемент посты
        return el.querySelector(POST_SELECTORS) !== null;
      });
    });

    if (!hasRelevantChanges) return;

    clearTimeout(debounceTimeout);
    const timer = setTimeout(() => {
      eventHandlers.timers.delete(timer);
      processWithThrottle();
    }, DEBOUNCE_DELAY);
    eventHandlers.timers.add(timer);
  });

  // Наблюдаем только за контейнером постов, а не за всем документом
  eventHandlers.observer.observe(postsContainer, {
    childList: true,
    subtree: true,
    // Не отслеживаем изменения атрибутов и текста - только структуру DOM
    attributes: false,
    characterData: false,
  });

  console.log(
    "[VKR] Observer initialized for:",
    postsContainer.tagName,
    postsContainer.id || postsContainer.className,
  );
}

// Scroll listener с увеличенным debounce
let scrollTimeout;
let lastScrollProcess = 0;

eventHandlers.scroll = () => {
  clearTimeout(scrollTimeout);

  scrollTimeout = setTimeout(() => {
    const now = Date.now();
    // Дополнительный throttling для scroll
    if (now - lastScrollProcess < SCROLL_DEBOUNCE) {
      return;
    }
    lastScrollProcess = now;

    processWithThrottle();
  }, SCROLL_DEBOUNCE);
};

if (!isAutomationTab) {
  window.addEventListener("scroll", eventHandlers.scroll, { passive: true });
}

// Global debug functions
window.VKR_processPosts = () => {
  console.log("[VKR] Manual processPosts");
  processPosts(document);
};

window.VKR_processComments = () => {
  console.log("[VKR] Manual processComments");
  processComments(document);
};

window.VKR_clearButtons = () => {
  console.log("[VKR] Clearing all buttons");
  document
    .querySelectorAll(
      ".vkr-boost-btn, .vkr-twiboost-btn, .vkr-download-btn, .vkr-direct-download-btn",
    )
    .forEach((btn) => btn.remove());
  document.querySelectorAll("[data-vkr-boost-processed]").forEach((el) => {
    el.removeAttribute("data-vkr-boost-processed");
  });
};

console.log("[VKR] Extension loaded!");

// Удаляем ошибочно вставленные кнопки в чатах
document.querySelectorAll('.FCThumb .vkr-buttons-container').forEach((el) => el.remove());

// На странице клипов и автоматизации не запускаем постовую логику
if (!isClipsPage() && !isAutomationTab) {
  processPosts(document);
  processComments(document);
  setTimeout(() => {
    processPosts(document);
    processComments(document);
  }, 1500);
}

// ========== BULK DELETE FEATURE ===========
// Функция openBulkDeleteModal уже используется в createFAB выше

// Открываем модальное окно массового удаления
function openLegacyBulkDeleteModal(groupId) {
  // Создаем overlay
  const overlay = document.createElement("div");
  overlay.className = "vkr-bulk-delete-overlay";

  // Создаем модальное окно
  const modal = document.createElement("div");
  modal.className = "vkr-bulk-delete-modal";

  // Устанавливаем дату "до" на сегодня
  const today = new Date().toISOString().split("T")[0];

  modal.innerHTML = `
    <h2>Массовое удаление постов</h2>

    <div class="vkr-quick-select">
      <button data-days="7">Неделя</button>
      <button data-days="14">2 недели</button>
      <button data-days="30">Месяц</button>
    </div>

    <div class="vkr-date-range">
      <label>
        От:
        <input type="date" id="vkr-date-from" max="${today}">
      </label>
      <label>
        До:
        <input type="date" id="vkr-date-to" value="${today}" max="${today}">
      </label>
    </div>

    <div class="vkr-bulk-options">
      <label>
        <input type="checkbox" id="vkr-delete-photos" checked>
        Удалять фотографии из альбомов
      </label>
    </div>

    <div class="vkr-bulk-preview" id="vkr-bulk-preview">
      <div class="vkr-bulk-preview-title">Предпросмотр:</div>
      <div class="vkr-bulk-preview-stats">
        <div class="vkr-bulk-preview-stat">
          Постов: <strong id="vkr-preview-posts">0</strong>
        </div>
        <div class="vkr-bulk-preview-stat">
          Фотографий: <strong id="vkr-preview-photos">0</strong>
        </div>
      </div>
    </div>

    <div class="vkr-bulk-progress" id="vkr-bulk-progress">
      <div class="vkr-progress-bar-container">
        <div class="vkr-progress-bar" id="vkr-progress-bar"></div>
      </div>
      <div class="vkr-progress-text" id="vkr-progress-text">Удалено: 0 / 0</div>
      <div class="vkr-progress-details">
        <span id="vkr-progress-posts">Посты: 0</span>
        <span id="vkr-progress-photos">Фото: 0</span>
      </div>
    </div>

    <div class="vkr-bulk-actions">
      <button class="vkr-bulk-btn-cancel" id="vkr-bulk-cancel">Отмена</button>
      <button class="vkr-bulk-btn-preview" id="vkr-bulk-preview-btn">Предпросмотр</button>
      <button class="vkr-bulk-btn-delete" id="vkr-bulk-delete" disabled>Удалить</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Обработчики событий
  const dateFrom = modal.querySelector("#vkr-date-from");
  const dateTo = modal.querySelector("#vkr-date-to");
  const deletePhotos = modal.querySelector("#vkr-delete-photos");
  const previewBtn = modal.querySelector("#vkr-bulk-preview-btn");
  const deleteBtn = modal.querySelector("#vkr-bulk-delete");
  const cancelBtn = modal.querySelector("#vkr-bulk-cancel");
  const previewDiv = modal.querySelector("#vkr-bulk-preview");
  const progressDiv = modal.querySelector("#vkr-bulk-progress");

  // ── Refs прогресс-элементов (замыкание вместо document.querySelector) ──
  const progressBar = modal.querySelector("#vkr-progress-bar");
  const progressText = modal.querySelector("#vkr-progress-text");
  const progressPosts = modal.querySelector("#vkr-progress-posts");
  const progressPhotos = modal.querySelector("#vkr-progress-photos");

  let isDeleting = false;
  let cancelRequested = false;

  // Progress listener привязан к конкретному модалу, а не к document
  function onProgress(message) {
    if (message.type !== "bulk_delete_progress") return;
    const total = message.total > 0 ? message.total : 1; // защита от деления на ноль
    const percent = Math.min(100, (message.current / total) * 100);
    progressBar.style.width = percent + "%";
    progressText.textContent = `Удалено: ${message.current} / ${total}`;
    progressPosts.textContent = `Посты: ${message.deletedPosts}`;
    progressPhotos.textContent = `Фото: ${message.deletedPhotos}`;
  }
  chrome.runtime.onMessage.addListener(onProgress);

  function cleanupModal() {
    chrome.runtime.onMessage.removeListener(onProgress);
    overlay.remove();
  }

  // Быстрый выбор периода
  modal.querySelectorAll(".vkr-quick-select button").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Убираем active у всех кнопок
      modal
        .querySelectorAll(".vkr-quick-select button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const days = parseInt(btn.dataset.days);
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - days);

      dateFrom.value = from.toISOString().split("T")[0];
      dateTo.value = to.toISOString().split("T")[0];

      console.log(
        "[VKR BULK DELETE] Quick select:",
        days,
        "days. From:",
        dateFrom.value,
        "To:",
        dateTo.value,
      );

      // Сбрасываем предпросмотр
      previewDiv.classList.remove("visible");
      deleteBtn.disabled = true;
    });
  });

  // Изменение дат - сбрасываем предпросмотр
  dateFrom.addEventListener("change", () => {
    previewDiv.classList.remove("visible");
    deleteBtn.disabled = true;
    modal
      .querySelectorAll(".vkr-quick-select button")
      .forEach((b) => b.classList.remove("active"));
  });

  dateTo.addEventListener("change", () => {
    previewDiv.classList.remove("visible");
    deleteBtn.disabled = true;
    modal
      .querySelectorAll(".vkr-quick-select button")
      .forEach((b) => b.classList.remove("active"));
  });

  // Смена опции "удалять фото" тоже инвалидирует preview
  deletePhotos.addEventListener("change", () => {
    previewDiv.classList.remove("visible");
    deleteBtn.disabled = true;
  });

  // Предпросмотр
  previewBtn.addEventListener("click", async () => {
    if (!dateFrom.value || !dateTo.value) {
      showToast("❌ Выберите период", "error");
      return;
    }

    console.log("[VKR BULK DELETE] Preview request:", {
      groupId: groupId,
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
      deletePhotos: deletePhotos.checked,
    });

    previewBtn.disabled = true;
    previewBtn.textContent = "Загрузка...";

    try {
      const response = await sendMessage("bulk_delete_preview", {
        ownerId: groupId,
        dateFrom: dateFrom.value,
        dateTo: dateTo.value,
        deletePhotos: deletePhotos.checked,
      });

      console.log("[VKR BULK DELETE] Preview response:", response);

      if (response.ok) {
        modal.querySelector("#vkr-preview-posts").textContent =
          response.postsCount;
        modal.querySelector("#vkr-preview-photos").textContent =
          response.photosCount;
        previewDiv.classList.add("visible");
        deleteBtn.disabled = false;
        showToast(
          `✅ Найдено: ${response.postsCount} постов, ${response.photosCount} фото`,
          "success",
        );
      } else {
        showToast(`❌ Ошибка: ${response.error || "Неизвестная ошибка"}`, "error");
      }
    } catch (error) {
      console.error("[VKR BULK DELETE] Preview error:", error);
      showToast(`❌ Ошибка: ${error.message}`, "error");
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = "Предпросмотр";
    }
  });

  // Удаление
  deleteBtn.addEventListener("click", async () => {
    const postsCount =
      parseInt(modal.querySelector("#vkr-preview-posts").textContent) || 0;
    const photosCount =
      parseInt(modal.querySelector("#vkr-preview-photos").textContent) || 0;
    const totalLabel =
      photosCount > 0
        ? `${postsCount} постов и ${photosCount} фото`
        : `${postsCount} постов`;

    const confirmed = await showCustomConfirm(
      `Удалить ${totalLabel}?\n\nЭто действие необратимо!`,
    );
    if (!confirmed) return;

    isDeleting = true;
    cancelRequested = false;
    deleteBtn.disabled = true;
    previewBtn.disabled = true;
    cancelBtn.textContent = "⏹ Стоп";
    cancelBtn.disabled = false;
    previewDiv.style.display = "none";
    progressDiv.classList.add("visible");

    try {
      const response = await sendMessage("bulk_delete_execute", {
        ownerId: groupId,
        dateFrom: dateFrom.value,
        dateTo: dateTo.value,
        deletePhotos: deletePhotos.checked,
      });

      if (response.ok) {
        const msg = response.cancelled
          ? `⏹ Остановлено: удалено ${response.deletedPosts} постов, ${response.deletedPhotos} фото`
          : `✅ Удалено: ${response.deletedPosts} постов, ${response.deletedPhotos} фото`;
        showToast(msg, response.cancelled ? "info" : "success");
        setTimeout(() => {
          cleanupModal();
          window.location.reload();
        }, 2000);
      } else {
        showToast(`❌ Ошибка: ${response.error}`, "error");
        deleteBtn.disabled = false;
        previewBtn.disabled = false;
        cancelBtn.textContent = "Отмена";
      }
    } catch (error) {
      showToast(`❌ Ошибка: ${error.message}`, "error");
      deleteBtn.disabled = false;
      previewBtn.disabled = false;
      cancelBtn.textContent = "Отмена";
    } finally {
      isDeleting = false;
    }
  });

  // Отмена / Стоп
  cancelBtn.addEventListener("click", async () => {
    if (isDeleting) {
      // Запрашиваем остановку в background
      cancelRequested = true;
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Останавливаем...";
      try {
        await sendMessage("bulk_delete_cancel", {});
      } catch (_) { }
    } else {
      cleanupModal();
    }
  });

  // Закрытие по клику на overlay (только если не идёт удаление)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && !isDeleting) {
      cleanupModal();
    }
  });
}

// ========== ALBUM CLEAN MODAL ==========
function openLegacyAlbumCleanModal(groupId) {
  const overlay = document.createElement("div");
  overlay.className = "vkr-bulk-delete-overlay";

  const modal = document.createElement("div");
  modal.className = "vkr-bulk-delete-modal";

  const today = new Date().toISOString().split("T")[0];

  modal.innerHTML = `
    <h2 style="gap:12px">
      <span style="font-size:28px">\uD83D\uDDBC\uFE0F</span>
      \u041E\u0447\u0438\u0441\u0442\u043A\u0430 \u0430\u043B\u044C\u0431\u043E\u043C\u0430
    </h2>

    <div style="background:rgba(234,179,8,0.12);border:1px solid rgba(234,179,8,0.35);border-radius:10px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#fde047;line-height:1.5">
      \u26A0\uFE0F \u041B\u0438\u043C\u0438\u0442 VK: <strong>1\u00A0000 \u0444\u043E\u0442\u043E \u0432 \u0434\u0435\u043D\u044C</strong>. \u0415\u0441\u043B\u0438 \u0444\u043E\u0442\u043E\u0433\u0440\u0430\u0444\u0438\u0439 \u0431\u043E\u043B\u044C\u0448\u0435 — \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u043E\u0447\u0438\u0441\u0442\u043A\u0443 \u0441\u043D\u043E\u0432\u0430 \u0437\u0430\u0432\u0442\u0440\u0430.
    </div>

    <div class="vkr-quick-select">
      <button data-days="30">\u041C\u0435\u0441\u044F\u0446</button>
      <button data-days="90">3 \u043C\u0435\u0441\u044F\u0446\u0430</button>
      <button data-days="180">\u041F\u043E\u043B\u0433\u043E\u0434\u0430</button>
      <button data-days="365">\u0413\u043E\u0434</button>
    </div>

    <div class="vkr-date-range">
      <label>\u041E\u0442:
        <input type="date" id="vkr-ac-date-from" max="${today}">
      </label>
      <label>\u0414\u043E:
        <input type="date" id="vkr-ac-date-to" value="${today}" max="${today}">
      </label>
    </div>

    <div class="vkr-bulk-preview" id="vkr-ac-preview">
      <div class="vkr-bulk-preview-title">\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440:</div>
      <div class="vkr-bulk-preview-stats">
        <div class="vkr-bulk-preview-stat">
          \u0424\u043E\u0442\u043E\u0433\u0440\u0430\u0444\u0438\u0439: <strong id="vkr-ac-count">0</strong>
        </div>
      </div>
      <div id="vkr-ac-limit-warn" style="display:none;margin-top:10px;padding:8px 12px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);border-radius:8px;font-size:12px;color:#fca5a5">
        \u26A0\uFE0F \u041D\u0430\u0439\u0434\u0435\u043D\u043E \u0431\u043E\u043B\u044C\u0448\u0435 1\u00A0000 \u0444\u043E\u0442\u043E. \u0421\u0435\u0433\u043E\u0434\u043D\u044F \u0431\u0443\u0434\u0443\u0442 \u0443\u0434\u0430\u043B\u0435\u043D\u044B \u043F\u0435\u0440\u0432\u044B\u0435 1\u00A0000, \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 — \u0437\u0430\u0432\u0442\u0440\u0430.
      </div>
    </div>

    <div class="vkr-bulk-progress" id="vkr-ac-progress">
      <div class="vkr-progress-bar-container">
        <div class="vkr-progress-bar" id="vkr-ac-bar"></div>
      </div>
      <div class="vkr-progress-text" id="vkr-ac-text">\u0423\u0434\u0430\u043B\u0435\u043D\u043E: 0 / 0</div>
    </div>

    <div class="vkr-bulk-actions">
      <button class="vkr-bulk-btn-cancel" id="vkr-ac-cancel">\u041E\u0442\u043C\u0435\u043D\u0430</button>
      <button class="vkr-bulk-btn-preview" id="vkr-ac-preview-btn">\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440</button>
      <button class="vkr-bulk-btn-delete" id="vkr-ac-delete" disabled>\u0423\u0434\u0430\u043B\u0438\u0442\u044C</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const dateFrom = modal.querySelector("#vkr-ac-date-from");
  const dateTo = modal.querySelector("#vkr-ac-date-to");
  const previewDiv = modal.querySelector("#vkr-ac-preview");
  const progressDiv = modal.querySelector("#vkr-ac-progress");
  const progressBar = modal.querySelector("#vkr-ac-bar");
  const progressTxt = modal.querySelector("#vkr-ac-text");
  const limitWarn = modal.querySelector("#vkr-ac-limit-warn");
  const previewBtn = modal.querySelector("#vkr-ac-preview-btn");
  const deleteBtn = modal.querySelector("#vkr-ac-delete");
  const cancelBtn = modal.querySelector("#vkr-ac-cancel");

  let isDeleting = false;

  function onProgress(msg) {
    if (msg.type !== "album_clean_progress") return;
    const pct = Math.min(100, (msg.current / (msg.total || 1)) * 100);
    progressBar.style.width = pct + "%";
    progressTxt.textContent = `\u0423\u0434\u0430\u043B\u0435\u043D\u043E: ${msg.current} / ${msg.total}`;
  }
  chrome.runtime.onMessage.addListener(onProgress);

  function cleanupModal() {
    chrome.runtime.onMessage.removeListener(onProgress);
    overlay.remove();
  }

  function resetPreview() {
    previewDiv.classList.remove("visible");
    deleteBtn.disabled = true;
    limitWarn.style.display = "none";
  }

  // \u0411\u044B\u0441\u0442\u0440\u044B\u0439 \u0432\u044B\u0431\u043E\u0440 \u043F\u0435\u0440\u0438\u043E\u0434\u0430
  modal.querySelectorAll(".vkr-quick-select button").forEach((btn) => {
    btn.addEventListener("click", () => {
      modal
        .querySelectorAll(".vkr-quick-select button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const days = parseInt(btn.dataset.days);
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - days);
      dateFrom.value = from.toISOString().split("T")[0];
      dateTo.value = to.toISOString().split("T")[0];
      resetPreview();
    });
  });

  dateFrom.addEventListener("change", () => {
    resetPreview();
    modal
      .querySelectorAll(".vkr-quick-select button")
      .forEach((b) => b.classList.remove("active"));
  });
  dateTo.addEventListener("change", () => {
    resetPreview();
    modal
      .querySelectorAll(".vkr-quick-select button")
      .forEach((b) => b.classList.remove("active"));
  });

  // \u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440
  previewBtn.addEventListener("click", async () => {
    if (!dateFrom.value || !dateTo.value) {
      showToast(
        "\u274C \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043F\u0435\u0440\u0438\u043E\u0434",
        "error",
      );
      return;
    }
    previewBtn.disabled = true;
    previewBtn.textContent =
      "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430...";
    try {
      const resp = await sendMessage("album_clean_preview", {
        ownerId: groupId,
        dateFrom: dateFrom.value,
        dateTo: dateTo.value,
      });
      if (resp.ok) {
        modal.querySelector("#vkr-ac-count").textContent = resp.photosCount;
        limitWarn.style.display = resp.photosCount > 1000 ? "" : "none";
        previewDiv.classList.add("visible");
        deleteBtn.disabled = resp.photosCount === 0;
        showToast(
          resp.photosCount === 0
            ? "\u2139\uFE0F \u0424\u043E\u0442\u043E \u0437\u0430 \u044D\u0442\u043E\u0442 \u043F\u0435\u0440\u0438\u043E\u0434 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E"
            : `\u2705 \u041D\u0430\u0439\u0434\u0435\u043D\u043E: ${resp.photosCount} \u0444\u043E\u0442\u043E`,
          resp.photosCount === 0 ? "info" : "success",
        );
      } else {
        showToast(`\u274C ${resp.error}`, "error");
      }
    } catch (err) {
      showToast(`\u274C ${err.message}`, "error");
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent =
        "\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440";
    }
  });

  // \u0423\u0434\u0430\u043B\u0435\u043D\u0438\u0435
  deleteBtn.addEventListener("click", async () => {
    const count =
      parseInt(modal.querySelector("#vkr-ac-count").textContent) || 0;
    const toDelete = Math.min(count, 1000);
    const confirmed = await showCustomConfirm(
      `\u0423\u0434\u0430\u043B\u0438\u0442\u044C ${toDelete} \u0444\u043E\u0442\u043E${count > 1000 ? " (\u0441\u0435\u0433\u043E\u0434\u043D\u044F \u043C\u0430\u043A\u0441 1\u00A0000)" : ""}?\n\n\u042D\u0442\u043E \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u043D\u0435\u043E\u0431\u0440\u0430\u0442\u0438\u043C\u043E!`,
    );
    if (!confirmed) return;

    isDeleting = true;
    deleteBtn.disabled = true;
    previewBtn.disabled = true;
    cancelBtn.textContent = "\u23F9 \u0421\u0442\u043E\u043F";
    previewDiv.style.display = "none";
    progressDiv.classList.add("visible");

    try {
      const resp = await sendMessage("album_clean_execute", {
        ownerId: groupId,
        dateFrom: dateFrom.value,
        dateTo: dateTo.value,
      });

      if (resp.ok) {
        let msg;
        if (resp.cancelled) {
          msg = `\u23F9 \u041E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E: \u0443\u0434\u0430\u043B\u0435\u043D\u043E ${resp.deletedPhotos} \u0444\u043E\u0442\u043E`;
        } else if (resp.limitReached) {
          msg = `\u26A0\uFE0F \u041B\u0438\u043C\u0438\u0442 \u0434\u043D\u044F \u0434\u043E\u0441\u0442\u0438\u0433\u043D\u0443\u0442. \u0423\u0434\u0430\u043B\u0435\u043D\u043E 1\u00A0000 \u0444\u043E\u0442\u043E. \u041E\u0441\u0442\u0430\u043B\u043E\u0441\u044C: ${resp.remaining}. \u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0437\u0430\u0432\u0442\u0440\u0430!`;
        } else {
          msg = `\u2705 \u0423\u0434\u0430\u043B\u0435\u043D\u043E: ${resp.deletedPhotos} \u0444\u043E\u0442\u043E`;
        }
        showToast(
          msg,
          resp.limitReached ? "info" : resp.cancelled ? "info" : "success",
        );
        setTimeout(() => {
          cleanupModal();
          if (!resp.limitReached && !resp.cancelled) window.location.reload();
        }, 3000);
      } else {
        // \u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C \u0441\u043F\u0435\u0446\u0438\u0444\u0438\u0447\u0435\u0441\u043A\u0443\u044E \u043E\u0448\u0438\u0431\u043A\u0443 standalone
        if (resp.error && resp.error.includes("STANDALONE_REQUIRED")) {
          progressDiv.classList.remove("visible");
          const hint = modal.querySelector("#vkr-ac-standalone-hint");
          if (hint) {
            hint.style.display = "";
          } else {
            const block = document.createElement("div");
            block.id = "vkr-ac-standalone-hint";
            block.style.cssText =
              "background:rgba(239,68,68,0.13);border:1px solid rgba(239,68,68,0.4);" +
              "border-radius:10px;padding:14px 16px;margin-top:16px;font-size:13px;" +
              "color:#fca5a5;line-height:1.6";
            block.innerHTML =
              "<strong style='color:#f87171;font-size:14px'>\u274C \u041E\u043F\u0435\u0440\u0430\u0446\u0438\u044F \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u0430</strong><br>" +
              "\u041C\u0430\u0441\u0441\u043E\u0432\u043E\u0435 \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u0435 \u0444\u043E\u0442\u043E \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442 \u0432 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C v4.";
            modal.appendChild(block);
          }
          cancelBtn.textContent = "\u0417\u0430\u043A\u0440\u044B\u0442\u044C";
          cancelBtn.disabled = false;
        } else {
          showToast(`\u274C ${resp.error}`, "error");
          deleteBtn.disabled = false;
          previewBtn.disabled = false;
          cancelBtn.textContent = "\u041E\u0442\u043C\u0435\u043D\u0430";
          previewDiv.style.display = "";
          progressDiv.classList.remove("visible");
        }
      }
    } catch (err) {
      showToast(`\u274C ${err.message}`, "error");
      deleteBtn.disabled = false;
      previewBtn.disabled = false;
      cancelBtn.textContent = "\u041E\u0442\u043C\u0435\u043D\u0430";
    } finally {
      isDeleting = false;
    }
  });

  // \u041E\u0442\u043C\u0435\u043D\u0430 / \u0421\u0442\u043E\u043F
  cancelBtn.addEventListener("click", async () => {
    if (isDeleting) {
      cancelBtn.disabled = true;
      cancelBtn.textContent =
        "\u041E\u0441\u0442\u0430\u043D\u0430\u0432\u043B\u0438\u0432\u0430\u0435\u043C...";
      try {
        await sendMessage("album_clean_cancel", {});
      } catch (_) { }
    } else {
      cleanupModal();
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && !isDeleting) cleanupModal();
  });
}

// ========== MODALS SHARED LOGIC ==========
async function initModals() {
  if (!sRoot) {
    if (typeof createShadowModal !== "function") {
      throw new Error("createShadowModal not found!");
    }
    sRoot = await createShadowModal();
    modalEl = sRoot.querySelector("#vkr-modal-overlay");
    commentModalEl = sRoot.querySelector("#vkr-comment-modal-overlay");

    bindModalEvents();
    bindCommentModalEvents();
  }
}

// ========== AUTOCOMMENT TEMPLATES ==========
async function loadAutocommentTemplates() {
  if (!modalEl) return;
  const select = modalEl.querySelector("#vkr-autocomment-template");
  if (!select) return;

  const data = await chrome.storage.local.get("vkr_comment_templates");
  const templates = data.vkr_comment_templates || [];

  select.innerHTML = '<option value="">Выбрать заготовку...</option>';
  templates.forEach((text) => {
    const option = document.createElement("option");
    option.value = text;
    option.textContent = text.length > 40 ? text.slice(0, 40) + "..." : text;
    select.appendChild(option);
  });
}

// ========== REPOST MODAL LOGIC ==========
async function openModal(postUrl) {
  if (!chrome || !chrome.storage || !chrome.storage.local) {
    return showCustomAlert("❌ Скрипт обновлен. Нажмите F5!");
  }

  const d = await chrome.storage.local.get(["vk_token"]);
  if (!d.vk_token) return showCustomAlert("❌ Сначала авторизуйтесь!");
  tok = d.vk_token;

  await initModals();
  await loadAutocommentTemplates();

  // Сбрасываем свернутое состояние
  modalEl.classList.remove("vkr-minimized");
  const minimizeBtn = modalEl.querySelector("#vkr-minimize");
  if (minimizeBtn) {
    minimizeBtn.textContent = "🗕";
    minimizeBtn.title = "Свернуть";
  }

  modalEl.style.display = "flex";

  try {
    await loadPost(postUrl);
  } catch (e) {
    const statusEl = modalEl.querySelector("#vkr-status");
    if (statusEl) {
      statusEl.textContent = "❌ Ошибка загрузки: " + e.message;
      statusEl.className = "error";
    }
  }
}

// ========== SAVED COMMUNITY SETS ==========
function selectedGroupIds() {
  if (!modalEl) return [];
  return Array.from(
    modalEl.querySelectorAll("#vkr-groups-list input[type='checkbox']:checked"),
    (input) => String(input.value),
  );
}

function availableGroupIds() {
  if (!modalEl) return [];
  return Array.from(
    modalEl.querySelectorAll("#vkr-groups-list input[type='checkbox']"),
    (input) => String(input.value),
  );
}

function nextGroupSetName() {
  const used = new Set(groupSets.map((set) => set.name.toLocaleLowerCase("ru")));
  let number = 1;
  while (used.has(`группа ${number}`)) number += 1;
  return `Группа ${number}`;
}

function createGroupSetId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return `set_${globalThis.crypto.randomUUID()}`;
    }
  } catch (_) { }
  return `set_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function unavailableIdsFromEditingSet() {
  if (!editingGroupSetId || !groupSetsCore) return [];
  const set = groupSets.find((item) => item.id === editingGroupSetId);
  if (!set) return [];
  return groupSetsCore.resolveAvailableGroups(set.groupIds, availableGroupIds())
    .missingIds;
}

function updateGroupSetEditorMeta() {
  if (!modalEl) return;
  const editor = modalEl.querySelector("#vkr-group-set-editor");
  const meta = modalEl.querySelector("#vkr-group-set-meta");
  if (!editor || editor.hidden || !meta) return;
  const count = selectedGroupIds().length;
  const preserved = unavailableIdsFromEditingSet().length;
  if (count || preserved) {
    meta.textContent = preserved
      ? `Выбрано сейчас: ${count}; скрытых или недоступных останется в наборе: ${preserved}`
      : `В набор войдёт пабликов: ${count}`;
  } else {
    meta.textContent = "Сначала отметьте хотя бы один паблик";
  }
  meta.classList.toggle("is-empty", count === 0 && preserved === 0);
}

function syncGroupSetActiveState() {
  if (!modalEl || !groupSetsCore) return;
  const selected = selectedGroupIds();
  const available = availableGroupIds();
  modalEl.querySelectorAll(".vkr-group-set-chip").forEach((chip) => {
    const set = groupSets.find((item) => item.id === chip.dataset.groupSetId);
    const visibleSelection = set
      ? groupSetsCore.resolveAvailableGroups(set.groupIds, available).selectedIds
      : [];
    const active =
      Boolean(set) &&
      visibleSelection.length > 0 &&
      groupSetsCore.sameSelection(visibleSelection, selected);
    chip.classList.toggle("active", active);
    chip.querySelector(".vkr-group-set-apply")?.setAttribute(
      "aria-pressed",
      active ? "true" : "false",
    );
  });
}

function renderGroupSetsUI() {
  if (!modalEl) return;
  const list = modalEl.querySelector("#vkr-group-sets-list");
  if (!list) return;
  list.replaceChildren();

  if (!groupSetsCore) {
    const error = document.createElement("div");
    error.className = "vkr-group-sets-empty is-error";
    error.textContent = "Наборы не загрузились. Обновите расширение и страницу VK.";
    list.appendChild(error);
    return;
  }

  if (!groupSets.length) {
    const empty = document.createElement("div");
    empty.className = "vkr-group-sets-empty";
    empty.textContent = "Наборов пока нет";
    list.appendChild(empty);
    return;
  }

  for (const set of groupSets) {
    const chip = document.createElement("div");
    chip.className = "vkr-group-set-chip";
    chip.dataset.groupSetId = set.id;

    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.className = "vkr-group-set-apply";
    applyButton.dataset.groupSetId = set.id;
    applyButton.title = `Выбрать паблики из набора «${set.name}»`;
    applyButton.setAttribute("aria-pressed", "false");

    const name = document.createElement("span");
    name.className = "vkr-group-set-name";
    name.textContent = set.name;

    const count = document.createElement("span");
    count.className = "vkr-group-set-count";
    count.textContent = String(set.groupIds.length);
    count.title = `Пабликов в наборе: ${set.groupIds.length}`;

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "vkr-group-set-edit";
    editButton.dataset.groupSetId = set.id;
    editButton.title = `Изменить набор «${set.name}»`;
    editButton.setAttribute("aria-label", `Изменить набор ${set.name}`);
    editButton.textContent = "✎";

    applyButton.append(name, count);
    chip.append(applyButton, editButton);
    list.appendChild(chip);
  }
  syncGroupSetActiveState();
}

async function loadGroupSetsUI() {
  if (!groupSetsCore) {
    groupSets = [];
    renderGroupSetsUI();
    return;
  }
  const data = await chrome.storage.local.get(GROUP_SETS_STORAGE_KEY);
  groupSets = groupSetsCore.normalizeGroupSets(data[GROUP_SETS_STORAGE_KEY]);
  renderGroupSetsUI();
}

async function persistGroupSets() {
  await chrome.storage.local.set({ [GROUP_SETS_STORAGE_KEY]: groupSets });
}

async function applyGroupSet(set, { quiet = false } = {}) {
  if (!set || !groupSetsCore || !modalEl) return;
  const inputs = Array.from(
    modalEl.querySelectorAll("#vkr-groups-list input[type='checkbox']"),
  );
  const resolved = groupSetsCore.resolveAvailableGroups(
    set.groupIds,
    inputs.map((input) => input.value),
  );
  const wanted = new Set(resolved.selectedIds);
  inputs.forEach((input) => {
    input.checked = wanted.has(String(input.value));
  });
  updateGroupCount();
  // Старый ключ трактует пустой массив как «первый запуск — выбрать всё».
  // Поэтому полностью недоступный набор очищает текущие флажки, но не затирает
  // последнее непустое сохранённое выделение.
  if (resolved.selectedIds.length) {
    await chrome.storage.local.set({ vkr_groups: resolved.selectedIds });
  }

  if (!quiet) {
    if (!resolved.selectedIds.length) {
      setStatus(`⚠️ В наборе «${set.name}» нет доступных пабликов`, "error");
      return;
    }
    const missingText = resolved.missingIds.length
      ? `, недоступно или скрыто: ${resolved.missingIds.length}`
      : "";
    setStatus(
      `✅ Набор «${set.name}»: выбрано ${resolved.selectedIds.length}${missingText}`,
      "success",
    );
  }
}

async function openGroupSetEditor(set = null) {
  if (!modalEl || !groupSetsCore) {
    showCustomAlert("❌ Наборы не загрузились. Обновите расширение и страницу VK.");
    return;
  }
  if (!set && !selectedGroupIds().length) {
    showCustomAlert("❌ Сначала отметьте паблики для нового набора.");
    return;
  }
  if (set) await applyGroupSet(set, { quiet: true });

  editingGroupSetId = set?.id || null;
  const editor = modalEl.querySelector("#vkr-group-set-editor");
  const input = modalEl.querySelector("#vkr-group-set-name");
  const deleteButton = modalEl.querySelector("#vkr-group-set-delete");
  input.value = set?.name || nextGroupSetName();
  deleteButton.hidden = !set;
  editor.hidden = false;
  updateGroupSetEditorMeta();
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeGroupSetEditor() {
  if (!modalEl) return;
  const editor = modalEl.querySelector("#vkr-group-set-editor");
  if (editor) editor.hidden = true;
  editingGroupSetId = null;
}

async function saveGroupSetFromEditor() {
  if (!modalEl || !groupSetsCore) return;
  const input = modalEl.querySelector("#vkr-group-set-name");
  const name = groupSetsCore.normalizeName(input.value);
  // Недоступные/скрытые паблики нельзя отметить в текущем списке, поэтому при
  // редактировании сохраняем их до тех пор, пока пользователь не вернёт их в
  // список и явно не снимет флажок.
  const groupIds = groupSetsCore.normalizeGroupIds([
    ...selectedGroupIds(),
    ...unavailableIdsFromEditingSet(),
  ]);
  const duplicate = groupSets.some(
    (set) =>
      set.id !== editingGroupSetId &&
      set.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"),
  );
  if (duplicate) {
    showCustomAlert("❌ Набор с таким названием уже существует.");
    input.focus();
    return;
  }

  try {
    let savedSet;
    if (editingGroupSetId) {
      const index = groupSets.findIndex((set) => set.id === editingGroupSetId);
      if (index < 0) throw new Error("Набор не найден.");
      savedSet = groupSetsCore.updateGroupSet(groupSets[index], { name, groupIds });
      groupSets.splice(index, 1, savedSet);
    } else {
      if (groupSets.length >= groupSetsCore.MAX_SETS) {
        throw new Error(`Можно сохранить не больше ${groupSetsCore.MAX_SETS} наборов.`);
      }
      savedSet = groupSetsCore.createGroupSet({
        id: createGroupSetId(),
        name,
        groupIds,
      });
      groupSets.push(savedSet);
    }
    await persistGroupSets();
    closeGroupSetEditor();
    renderGroupSetsUI();
    setStatus(
      `✅ Набор «${savedSet.name}» сохранён (${savedSet.groupIds.length} пабл.)`,
      "success",
    );
  } catch (error) {
    showCustomAlert(`❌ ${error.message}`);
  }
}

async function deleteEditingGroupSet() {
  const set = groupSets.find((item) => item.id === editingGroupSetId);
  if (!set) return;
  const confirmed = await showCustomConfirm(`Удалить набор «${set.name}»?`);
  if (!confirmed) return;
  groupSets = groupSets.filter((item) => item.id !== set.id);
  await persistGroupSets();
  closeGroupSetEditor();
  renderGroupSetsUI();
  setStatus(`🗑️ Набор «${set.name}» удалён`, "info");
}

function bindModalEvents() {
  const $ = (id) => modalEl.querySelector("#" + id);
  let deleteMode = false;

  $("vkr-close").onclick = closeModal;
  $("vkr-cancel").onclick = closeModal;
  modalEl.onclick = (e) => {
    if (e.target === modalEl) {
      closeModal();
    }
  };

  // Minimize Modal
  const minimizeBtn = $("vkr-minimize");
  if (minimizeBtn) {
    minimizeBtn.onclick = () => {
      modalEl.classList.toggle("vkr-minimized");
      if (modalEl.classList.contains("vkr-minimized")) {
        minimizeBtn.textContent = "🗖";
        minimizeBtn.title = "Развернуть";
      } else {
        minimizeBtn.textContent = "🗕";
        minimizeBtn.title = "Свернуть";
      }
    };
  }

  // Minimize Modal from Footer
  const minimizeBtnFooter = $("vkr-minimize-btn-footer");
  if (minimizeBtnFooter) {
    minimizeBtnFooter.onclick = () => {
      modalEl.classList.add("vkr-minimized");
      if (minimizeBtn) {
        minimizeBtn.textContent = "🗖";
        minimizeBtn.title = "Развернуть";
      }
    };
  }

  // Mode toggle
  modalEl.querySelectorAll(".vkr-mode-btn[data-mode]").forEach((btn) => {
    btn.onclick = () => {
      mode = btn.dataset.mode;
      modalEl
        .querySelectorAll(".vkr-mode-btn[data-mode]")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $("vkr-text-section").style.display =
        mode === "repost" ? "none" : "block";
      // Re-uploading edited media is intentionally disabled in safe mode.
      $("vkr-watermark-section").style.display = "none";
    };
  });

  // Tabs
  modalEl.querySelectorAll(".vkr-tab").forEach((tab) => {
    tab.onclick = () => {
      const tabName = tab.dataset.tab;

      modalEl
        .querySelectorAll(".vkr-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      modalEl
        .querySelectorAll(".vkr-tab-content")
        .forEach((c) => c.classList.remove("active"));
      modalEl.querySelector(`#vkr-tab-${tabName}`).classList.add("active");

      if (tabName === "hidden") {
        loadHiddenGroups();
      }
    };
  });

  // Watermark
  $("vkr-watermark-enabled").checked = false;
  $("vkr-watermark-enabled").disabled = true;
  $("vkr-watermark-section").style.display = "none";
  $("vkr-watermark-enabled").onchange = (e) => {
    $("vkr-watermark-settings").style.display = e.target.checked
      ? "block"
      : "none";
    updateWatermarkPreview();
  };

  loadWatermarks();

  $("vkr-watermark-opacity").oninput = (e) => {
    $("vkr-opacity-value").textContent = e.target.value + "%";
    updateWatermarkPreview();
  };

  $("vkr-watermark-size").oninput = (e) => {
    $("vkr-size-value").textContent = e.target.value + "%";
    updateWatermarkPreview();
  };

  $("vkr-watermark-list").onchange = updateWatermarkPreview;
  $("vkr-watermark-position").onchange = updateWatermarkPreview;

  // Autocomment (в основной вкладке)
  $("vkr-autocomment").onchange = (e) => {
    $("vkr-autocomment-settings").style.display = e.target.checked
      ? "block"
      : "none";
  };

  loadAutocommentTemplates();

  $("vkr-autocomment-template").onchange = (e) => {
    const val = e.target.value;
    if (val) {
      $("vkr-autocomment-text").value = val;
    }
  };

  $("vkr-autocomment-save-template").onclick = async () => {
    const text = $("vkr-autocomment-text").value.trim();
    if (!text) {
      showCustomAlert("❌ Введите текст для сохранения!");
      return;
    }
    const data = await chrome.storage.local.get("vkr_comment_templates");
    const templates = data.vkr_comment_templates || [];
    if (!templates.includes(text)) {
      templates.push(text);
      await chrome.storage.local.set({ vkr_comment_templates: templates });
      await loadAutocommentTemplates();
      $("vkr-autocomment-template").value = text;
      showCustomAlert("Заготовка сохранена");
    } else {
      showCustomAlert("Эта заготовка уже существует");
    }
  };

  $("vkr-autocomment-delete-template").onclick = async () => {
    const select = $("vkr-autocomment-template");
    const val = select.value;
    if (!val) {
      showCustomAlert("❌ Выберите заготовку для удаления!");
      return;
    }
    const confirmed = await showCustomConfirm("Удалить выбранную заготовку?");
    if (confirmed) {
      const data = await chrome.storage.local.get("vkr_comment_templates");
      const templates = data.vkr_comment_templates || [];
      const updated = templates.filter(t => t !== val);
      await chrome.storage.local.set({ vkr_comment_templates: updated });
      await loadAutocommentTemplates();
      $("vkr-autocomment-text").value = "";
      showCustomAlert("Заготовка удалена");
    }
  };

  async function updateWatermarkPreview() {
    const previewDiv = modalEl.querySelector("#vkr-watermark-preview");
    const canvas = modalEl.querySelector("#vkr-watermark-canvas");

    if (!$("vkr-watermark-enabled").checked || !post) {
      previewDiv.style.display = "none";
      return;
    }

    const wmId = $("vkr-watermark-list").value;
    if (!wmId) {
      previewDiv.style.display = "none";
      return;
    }

    const data = await chrome.storage.local.get("vkr_watermarks");
    const watermarks = data.vkr_watermarks || [];
    const wm = watermarks.find((w) => w.id === wmId);
    if (!wm) {
      previewDiv.style.display = "none";
      return;
    }

    const photoAttachment = post.attachments?.find((a) => a.type === "photo");
    if (!photoAttachment) {
      previewDiv.style.display = "none";
      return;
    }

    const sizes = photoAttachment.photo.sizes || [];
    const photoSize =
      sizes.find((s) => s.type === "x") || sizes[sizes.length - 1];
    if (!photoSize) {
      previewDiv.style.display = "none";
      return;
    }

    previewDiv.style.display = "block";

    const ctx = canvas.getContext("2d");
    canvas.width = 400;
    canvas.height = 300;
    ctx.fillStyle = "#1a1a25";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#64748b";
    ctx.font = "14px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Фото поста", canvas.width / 2, canvas.height / 2);

    const watermarkImg = new Image();
    watermarkImg.onload = () => {
      const opacity = parseInt($("vkr-watermark-opacity").value) / 100;
      const size = parseInt($("vkr-watermark-size").value) / 100;
      const position = $("vkr-watermark-position").value;

      const wmWidth = canvas.width * size;
      const wmHeight = watermarkImg.height * (wmWidth / watermarkImg.width);

      let x, y;
      const padding = 10;

      switch (position) {
        case "bottom-right":
          x = canvas.width - wmWidth - padding;
          y = canvas.height - wmHeight - padding;
          break;
        case "bottom-left":
          x = padding;
          y = canvas.height - wmHeight - padding;
          break;
        case "top-right":
          x = canvas.width - wmWidth - padding;
          y = padding;
          break;
        case "top-left":
          x = padding;
          y = padding;
          break;
        case "center":
          x = (canvas.width - wmWidth) / 2;
          y = (canvas.height - wmHeight) / 2;
          break;
        default:
          x = canvas.width - wmWidth - padding;
          y = canvas.height - wmHeight - padding;
      }

      ctx.globalAlpha = opacity;
      ctx.drawImage(watermarkImg, x, y, wmWidth, wmHeight);
      ctx.globalAlpha = 1.0;
    };

    watermarkImg.src = wm.dataUrl;
  }

  $("vkr-watermark-upload").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png";
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (!file.type.includes("png")) {
        showCustomAlert("Пожалуйста, выберите PNG файл");
        return;
      }

      const reader = new FileReader();
      reader.onload = async (event) => {
        const dataUrl = event.target.result;
        const name = prompt(
          "Название водяного знака:",
          file.name.replace(".png", ""),
        );
        if (!name) return;

        const data = await chrome.storage.local.get("vkr_watermarks");
        const watermarks = data.vkr_watermarks || [];
        watermarks.push({ id: Date.now().toString(), name, dataUrl });
        await chrome.storage.local.set({ vkr_watermarks: watermarks });

        loadWatermarks();
        showCustomAlert("Водяной знак добавлен!");
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  $("vkr-watermark-manage").onclick = async () => {
    const data = await chrome.storage.local.get("vkr_watermarks");
    const watermarks = data.vkr_watermarks || [];

    if (watermarks.length === 0) {
      showCustomAlert("Нет сохранённых водяных знаков");
      return;
    }

    const names = watermarks.map((w) => w.name).join("\n");
    const confirmed = await showCustomConfirm(
      `Сохранённые водяные знаки:\n\n${names}\n\nУдалить все?`,
    );

    if (confirmed) {
      await chrome.storage.local.set({ vkr_watermarks: [] });
      loadWatermarks();
      showCustomAlert("Все водяные знаки удалены");
    }
  };

  async function loadWatermarks() {
    const data = await chrome.storage.local.get("vkr_watermarks");
    const watermarks = data.vkr_watermarks || [];
    const select = $("vkr-watermark-list");

    select.innerHTML = '<option value="">Выберите водяной знак...</option>';
    watermarks.forEach((w) => {
      const option = document.createElement("option");
      option.value = w.id;
      option.textContent = w.name;
      select.appendChild(option);
    });
  }

  // Date/Time scroll
  $("vkr-date").addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = e.target;

    if (!input.value || input.value.length < 10) {
      const now = new Date();
      const day = String(now.getDate()).padStart(2, "0");
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const year = now.getFullYear();
      input.value = `${day}.${month}.${year}`;
    }

    const cursorPos = input.selectionStart || 0;
    const parts = input.value.split(".");
    let day = parseInt(parts[0]) || 1;
    let month = parseInt(parts[1]) || 1;
    let year = parseInt(parts[2]) || new Date().getFullYear();

    const delta = e.deltaY < 0 ? 1 : -1;

    if (cursorPos <= 2) {
      day += delta;
      const daysInMonth = new Date(year, month, 0).getDate();
      if (day > daysInMonth) day = 1;
      if (day < 1) day = daysInMonth;
    } else if (cursorPos <= 5) {
      month += delta;
      if (month > 12) month = 1;
      if (month < 1) month = 12;
    } else {
      year += delta;
      if (year < 2024) year = 2024;
      if (year > 2026) year = 2026;
    }

    input.value =
      String(day).padStart(2, "0") +
      "." +
      String(month).padStart(2, "0") +
      "." +
      year;
    input.setSelectionRange(cursorPos, cursorPos);
  });

  $("vkr-time").addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = e.target;

    if (!input.value || input.value.length < 5) {
      input.value = "12:00";
    }

    const cursorPos = input.selectionStart || 0;
    const parts = input.value.split(":");
    let hours = parseInt(parts[0]) || 0;
    let minutes = parseInt(parts[1]) || 0;

    const delta = e.deltaY < 0 ? 1 : -1;

    if (cursorPos <= 2) {
      hours += delta;
      if (hours >= 24) hours = 0;
      if (hours < 0) hours = 23;
    } else {
      minutes += delta * 15;
      if (minutes >= 60) minutes = 0;
      if (minutes < 0) minutes = 45;
    }

    input.value =
      String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
    input.setSelectionRange(cursorPos, cursorPos);
  });

  $("vkr-delete-hours").addEventListener("wheel", (e) => {
    e.preventDefault();
    const input = e.target;
    let val = parseInt(input.value) || 0;
    val += e.deltaY < 0 ? 1 : -1;
    if (val < 0) val = 0;
    if (val > 999) val = 999;
    input.value = val;
    modalEl
      .querySelectorAll(".vkr-chip")
      .forEach((c) => c.classList.remove("active"));
  });

  $("vkr-delete-minutes").addEventListener("wheel", (e) => {
    e.preventDefault();
    const input = e.target;
    let val = parseInt(input.value) || 0;
    val += e.deltaY < 0 ? 15 : -15;
    if (val < 0) val = 0;
    if (val > 999) val = 999;
    input.value = val;
    modalEl
      .querySelectorAll(".vkr-chip")
      .forEach((c) => c.classList.remove("active"));
  });

  $("vkr-schedule").onchange = (e) => {
    $("vkr-schedule-inputs").style.display = e.target.checked ? "flex" : "none";
    if (e.target.checked && !$("vkr-date").value) {
      const now = new Date();
      now.setHours(now.getHours() + 1);
      const day = String(now.getDate()).padStart(2, "0");
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const year = now.getFullYear();
      $("vkr-date").value = `${day}.${month}.${year}`;
      $("vkr-time").value = now.toTimeString().slice(0, 5);
    }

    $("vkr-analytics").style.display = e.target.checked ? "block" : "none";
    if (e.target.checked) {
      populateAnalyticsGroupSelect();
    }
  };

  function populateAnalyticsGroupSelect() {
    const select = $("vkr-analytics-group");
    select.innerHTML = "";
    const checked = modalEl.querySelectorAll("#vkr-groups-list input:checked");
    if (checked.length === 0) {
      select.innerHTML = "<option>Сначала выберите группы</option>";
      return;
    }
    checked.forEach((c) => {
      const name =
        c.closest(".vkr-group-item")?.querySelector("span")?.textContent ||
        c.value;
      const opt = document.createElement("option");
      opt.value = c.value;
      opt.textContent = name;
      select.appendChild(opt);
    });
    runAnalytics(select.value);
  }

  $("vkr-analytics-group").onchange = (e) => {
    runAnalytics(e.target.value);
  };

  async function runAnalytics(groupId) {
    if (!groupId || !tok) return;

    $("vkr-analytics-loading").style.display = "block";
    $("vkr-analytics-content").style.display = "none";
    $("vkr-analytics-error").style.display = "none";

    try {
      const res = await sendMessage("analyze_activity", {
        groupId,
        token: tok,
      });
      const data = res.data;

      $("vkr-analytics-loading").style.display = "none";
      $("vkr-analytics-content").style.display = "block";
      $("vkr-analytics-meta").textContent =
        "По " + data.analyzedPosts + " постам";

      const maxEng = Math.max(...data.hourly.map((h) => h.engagement), 1);
      let hmHtml = "";
      for (let h = 0; h < 24; h++) {
        const d = data.hourly[h];
        const level = d.posts < 2 ? 0 : Math.ceil((d.engagement / maxEng) * 7);
        const isBest = data.top3[0] && data.top3[0].hour === h;
        const cls =
          "vkr-heatmap-cell vkr-heat-" +
          Math.min(level, 7) +
          (isBest ? " vkr-heat-best" : "");
        const tip =
          String(h).padStart(2, "0") +
          ":00 — ❤️" +
          d.engagement +
          " 👁" +
          formatK(d.avgViews) +
          " (" +
          d.posts +
          " постов)";
        hmHtml += `<div class="${cls}" data-tooltip="${tip}" data-hour="${h}">${String(h).padStart(2, "0")}</div>`;
      }
      $("vkr-heatmap").innerHTML = hmHtml;

      modalEl.querySelectorAll(".vkr-heatmap-cell").forEach((cell) => {
        cell.onclick = () => applyTime(parseInt(cell.dataset.hour));
      });

      const medals = ["🥇", "🥈", "🥉"];
      let topHtml = "";
      data.top3.forEach((t, i) => {
        topHtml += `<div class="vkr-rec-item${i === 0 ? " gold" : ""}">
          <span class="vkr-rec-medal">${medals[i]}</span>
          <span class="vkr-rec-info"><strong>${String(t.hour).padStart(2, "0")}:00</strong>
          <span class="vkr-rec-stats"> — ❤️${t.engagement}  👁${formatK(t.avgViews)}</span></span>
          <button class="vkr-rec-btn" data-hour="${t.hour}">Применить</button>
          </div>`;
      });
      $("vkr-analytics-top3").innerHTML = topHtml;

      modalEl.querySelectorAll(".vkr-rec-btn").forEach((btn) => {
        btn.onclick = () => applyTime(parseInt(btn.dataset.hour));
      });
    } catch (e) {
      $("vkr-analytics-loading").style.display = "none";
      $("vkr-analytics-error").style.display = "block";
      $("vkr-analytics-error").textContent = "❌ " + e.message;
    }
  }

  function applyTime(hour) {
    $("vkr-time").value = String(hour).padStart(2, "0") + ":00";
    if (!$("vkr-date").value) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const d = String(tomorrow.getDate()).padStart(2, "0");
      const m = String(tomorrow.getMonth() + 1).padStart(2, "0");
      $("vkr-date").value = d + "." + m + "." + tomorrow.getFullYear();
    }
    setStatus(
      "⏰ Установлено: " + String(hour).padStart(2, "0") + ":00",
      "success",
    );
  }

  function formatK(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  }

  $("vkr-autodelete").onchange = (e) => {
    $("vkr-autodelete-settings").style.display = e.target.checked
      ? "block"
      : "none";
  };

  modalEl.querySelectorAll(".vkr-chip").forEach((chip) => {
    chip.onclick = () => {
      $("vkr-delete-hours").value = chip.dataset.hours;
      $("vkr-delete-minutes").value = 0;
      modalEl
        .querySelectorAll(".vkr-chip")
        .forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
    };
  });

  $("vkr-delete-hours").oninput = $("vkr-delete-minutes").oninput = () => {
    modalEl
      .querySelectorAll(".vkr-chip")
      .forEach((c) => c.classList.remove("active"));
  };

  // Сохранённые наборы пабликов: один клик заменяет текущий выбор составом набора.
  $("vkr-group-set-new").onclick = () => openGroupSetEditor();
  $("vkr-group-sets-list").addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const editButton = target.closest(".vkr-group-set-edit");
    const applyButton = target.closest(".vkr-group-set-apply");
    const button = editButton || applyButton;
    if (!button) return;
    const set = groupSets.find((item) => item.id === button.dataset.groupSetId);
    if (!set) return;
    if (editButton) await openGroupSetEditor(set);
    else await applyGroupSet(set);
  });
  $("vkr-group-set-save").onclick = saveGroupSetFromEditor;
  $("vkr-group-set-delete").onclick = deleteEditingGroupSet;
  $("vkr-group-set-cancel").onclick = closeGroupSetEditor;
  $("vkr-group-set-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveGroupSetFromEditor();
    } else if (event.key === "Escape") {
      closeGroupSetEditor();
    }
  });

  const groupsList = $("vkr-groups-list");
  groupsList.addEventListener("change", (e) => {
    if (e.target.type === "checkbox") {
      updateGroupCount();
    }
  });

  groupsList.addEventListener("click", async (e) => {
    const deleteBtn = e.target.closest(".vkr-group-delete");
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const gid = String(deleteBtn.dataset.groupId);

      const confirmed = await showCustomConfirm("Скрыть эту группу из списка?");
      if (confirmed) {
        const data = await chrome.storage.local.get("vkr_hidden_groups");
        const hidden = data.vkr_hidden_groups || [];
        // Храним всегда как строку, чтобы includes(String(g.id)) в loadPost работал корректно
        if (!hidden.includes(gid)) hidden.push(gid);
        await chrome.storage.local.set({ vkr_hidden_groups: hidden });

        // ✅ Ищем через groupsList, а не через modalEl — иначе Shadow DOM блокирует поиск
        const input = groupsList.querySelector(`input[data-gid="${gid}"]`);
        if (input) input.closest(".vkr-group-item").remove();

        updateGroupCount();
      }
    }
  });

  $("vkr-select-all").onclick = () => {
    modalEl
      .querySelectorAll("#vkr-groups-list input")
      .forEach((c) => (c.checked = true));
    updateGroupCount();
  };
  $("vkr-select-none").onclick = () => {
    modalEl
      .querySelectorAll("#vkr-groups-list input")
      .forEach((c) => (c.checked = false));
    updateGroupCount();
  };

  async function loadHiddenGroups() {
    const data = await chrome.storage.local.get("vkr_hidden_groups");
    const hidden = data.vkr_hidden_groups || [];

    const hiddenList = modalEl.querySelector("#vkr-hidden-groups-list");
    const hiddenCount = modalEl.querySelector("#vkr-hidden-count");

    if (hidden.length === 0) {
      hiddenList.innerHTML =
        '<div style="text-align:center;color:#64748b;padding:20px">Нет скрытых групп</div>';
      hiddenCount.textContent = "0 скрыто";
      return;
    }

    hiddenCount.textContent = hidden.length + " скрыто";

    let gh = "";
    hidden.forEach((gid) => {
      const g = grps.find((gr) => String(gr.id) === gid);
      if (!g) return;

      gh += `<label class="vkr-group-item">
        <img src="${g.photo_50}">
        <span>${esc(g.name)}</span>
        <button class="vkr-group-delete" data-group-id="${g.id}" title="Восстановить группу">↩️</button>
      </label>`;
    });

    hiddenList.innerHTML = gh;

    hiddenList.querySelectorAll(".vkr-group-delete").forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const gid = String(btn.dataset.groupId);

        const data = await chrome.storage.local.get("vkr_hidden_groups");
        const hidden = data.vkr_hidden_groups || [];
        const newHidden = hidden.filter((id) => String(id) !== gid);
        await chrome.storage.local.set({ vkr_hidden_groups: newHidden });

        btn.closest(".vkr-group-item").remove();

        // ✅ Ищем через hiddenList, а не через modalEl
        const count = hiddenList.querySelectorAll(".vkr-group-item").length;
        hiddenCount.textContent = count + " скрыто";

        if (count === 0) {
          hiddenList.innerHTML =
            '<div style="text-align:center;color:#64748b;padding:20px">Нет скрытых групп</div>';
        }

        showCustomAlert("Группа восстановлена! Перезагрузите окно.");
      };
    });
  }

  // Delete mode
  $("vkr-delete-mode").onclick = () => {
    deleteMode = !deleteMode;

    if (deleteMode) {
      $("vkr-delete-mode").classList.add("active");
      $("vkr-delete-panel").style.display = "block";
      $("vkr-group-count").style.display = "none";
      groupsList.querySelectorAll("input").forEach((c) => (c.checked = false));
      groupsList.classList.add("delete-mode");
    } else {
      $("vkr-delete-mode").classList.remove("active");
      $("vkr-delete-panel").style.display = "none";
      $("vkr-group-count").style.display = "inline";
      groupsList.querySelectorAll("input").forEach((c) => (c.checked = false));
      groupsList.classList.remove("delete-mode");
      updateGroupCount();
    }
  };

  $("vkr-delete-selected").onclick = async () => {
    const selected = [];
    // ✅ Ищем через groupsList, не через modalEl
    groupsList.querySelectorAll("input:checked").forEach((c) => {
      selected.push(String(c.value));
    });

    if (selected.length === 0) {
      showCustomAlert("Выберите группы для скрытия");
      return;
    }

    const confirmed = await showCustomConfirm(
      `Скрыть ${selected.length} групп(ы)?`,
    );
    if (confirmed) {
      const data = await chrome.storage.local.get("vkr_hidden_groups");
      const hidden = data.vkr_hidden_groups || [];
      // Добавляем только уникальные, как строки
      selected.forEach((gid) => {
        if (!hidden.includes(gid)) hidden.push(gid);
      });
      await chrome.storage.local.set({ vkr_hidden_groups: hidden });

      // ✅ Ищем через groupsList
      selected.forEach((gid) => {
        const input = groupsList.querySelector(`input[value="${gid}"]`);
        if (input) input.closest(".vkr-group-item").remove();
      });

      deleteMode = false;
      $("vkr-delete-mode").classList.remove("active");
      $("vkr-delete-panel").style.display = "none";
      $("vkr-group-count").style.display = "inline";
      groupsList.classList.remove("delete-mode");
      updateGroupCount();
    }
  };

  $("vkr-cancel-delete").onclick = () => {
    deleteMode = false;
    $("vkr-delete-mode").classList.remove("active");
    $("vkr-delete-panel").style.display = "none";
    $("vkr-group-count").style.display = "inline";
    groupsList.querySelectorAll("input").forEach((c) => (c.checked = false));
    groupsList.classList.remove("delete-mode");
    updateGroupCount();
  };

  $("vkr-search").oninput = (e) => {
    const q = e.target.value.toLowerCase();
    // ✅ Ищем через groupsList, чтобы не захватывать hidden-список
    groupsList.querySelectorAll(".vkr-group-item").forEach((el) => {
      el.style.display = el
        .querySelector("span")
        .textContent.toLowerCase()
        .includes(q)
        ? "flex"
        : "none";
    });
  };

  $("vkr-search-hidden").oninput = (e) => {
    const q = e.target.value.toLowerCase();
    modalEl
      .querySelectorAll("#vkr-hidden-groups-list .vkr-group-item")
      .forEach((el) => {
        el.style.display = el
          .querySelector("span")
          .textContent.toLowerCase()
          .includes(q)
          ? "flex"
          : "none";
      });
  };

  $("vkr-restore-all").onclick = async () => {
    const confirmed = await showCustomConfirm(
      "Восстановить все скрытые группы?",
    );
    if (confirmed) {
      await chrome.storage.local.set({ vkr_hidden_groups: [] });
      showCustomAlert("Все группы восстановлены! Перезагрузите окно.");
    }
  };

  $("vkr-submit").onclick = sendToGroups;

  // Draggable
  makeDraggable();
}

function makeDraggable() {
  const header = modalEl.querySelector("#vkr-modal-header");
  const modal = modalEl.querySelector("#vkr-modal");

  if (!header || !modal) return;

  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;

  header.style.cursor = "move";
  header.style.userSelect = "none";

  header.addEventListener("mousedown", dragStart);
  document.addEventListener("mousemove", drag);
  document.addEventListener("mouseup", dragEnd);

  function dragStart(e) {
    if (e.target.closest("button")) return;

    initialX = e.clientX - xOffset;
    initialY = e.clientY - yOffset;

    isDragging = true;
    header.style.cursor = "grabbing";
  }

  function drag(e) {
    if (!isDragging) return;

    e.preventDefault();

    currentX = e.clientX - initialX;
    currentY = e.clientY - initialY;

    xOffset = currentX;
    yOffset = currentY;

    modal.style.transform = `translate(${currentX}px, ${currentY}px)`;
  }

  function dragEnd() {
    if (!isDragging) return;

    isDragging = false;
    header.style.cursor = "move";
  }
}

function closeModal() {
  if (modalEl) {
    modalEl.style.display = "none";
    modalEl.classList.remove("vkr-minimized");
    const minimizeBtn = modalEl.querySelector("#vkr-minimize");
    if (minimizeBtn) {
      minimizeBtn.textContent = "🗕";
      minimizeBtn.title = "Свернуть";
    }
  }
}

async function loadPost(postUrl) {
  const $ = (id) => modalEl.querySelector("#" + id);

  setStatus("⏳ Загрузка поста...", "info");

  try {
    const response = await Promise.race([
      sendMessage("load_post", { postUrl, token: tok }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout 15 сек")), 15000),
      ),
    ]);

    post = response.post;
    grps = response.groups;

    // Preview
    let html = esc(post.text || "[Без текста]");
    if (post.attachments) {
      const ph = post.attachments.filter((a) => a.type === "photo");
      ph.forEach((a, index) => {
        const s = a.photo.sizes || [];
        const b = s.find((x) => x.type === "x") || s[s.length - 1];
        if (b) {
          html += `<div class="vkr-photo-preview" data-photo-index="${index}">
            <img src="${b.url}">
            <button class="vkr-photo-delete" data-photo-index="${index}" title="Удалить это фото">✕</button>
          </div>`;
        }
      });
      const types = post.attachments.map((a) => {
        if (a.type === "photo") return "🖼";
        if (a.type === "video") return "🎥";
        if (a.type === "doc") return "📎";
        return "📁";
      });
      html +=
        '<div style="color:#6366f1;margin-top:8px">' +
        types.join(" ") +
        "</div>";
    }
    $("vkr-post-content").innerHTML = html;
    $("vkr-post-text").value = post.text || "";

    // Photo delete handlers
    modalEl.querySelectorAll(".vkr-photo-delete").forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const photoIndex = parseInt(btn.dataset.photoIndex);

        const photoAttachments = post.attachments.filter(
          (a) => a.type === "photo",
        );
        const photoToRemove = photoAttachments[photoIndex];
        const indexInAll = post.attachments.indexOf(photoToRemove);

        if (indexInAll !== -1) {
          post.attachments.splice(indexInAll, 1);
        }

        const photoPreview = modalEl.querySelector(
          `.vkr-photo-preview[data-photo-index="${photoIndex}"]`,
        );
        if (photoPreview) {
          photoPreview.remove();
        }

        setStatus("🗑️ Фото удалено", "info");
        setTimeout(() => setStatus("", ""), 2000);
      };
    });

    // Groups
    const saved = await chrome.storage.local.get("vkr_groups");
    const sg = saved.vkr_groups || [];
    const autoSelect = sg.length === 0;

    const hiddenData = await chrome.storage.local.get("vkr_hidden_groups");
    const hiddenGroups = hiddenData.vkr_hidden_groups || [];

    let gh = "";
    grps.forEach((g) => {
      if (hiddenGroups.includes(String(g.id))) return;

      const ch = autoSelect || sg.includes(String(g.id)) ? "checked" : "";
      gh += `<label class="vkr-group-item" data-group-id="${g.id}">
        <input type="checkbox" value="${g.id}" ${ch} data-gid="${g.id}">
        <img src="${g.photo_50}">
        <span>${esc(g.name)}</span>
        <button class="vkr-group-delete" data-group-id="${g.id}" title="Скрыть группу">✕</button>
      </label>`;
    });
    $("vkr-groups-list").innerHTML = gh;

    updateGroupCount();
    closeGroupSetEditor();
    await loadGroupSetsUI();

    setStatus("✅ Пост загружен!", "success");
  } catch (e) {
    setStatus("❌ " + e.message, "error");
  }
}

function updateGroupCount() {
  const n = modalEl.querySelectorAll("#vkr-groups-list input:checked").length;
  modalEl.querySelector("#vkr-group-count").textContent = n + " выбрано";
  updateGroupSetEditorMeta();
  syncGroupSetActiveState();
}

function setStatus(text, type) {
  const st = modalEl.querySelector("#vkr-status");
  st.textContent = text;
  st.className = type ? type : "";
}

// Защита от повторных отправок (только для валидации, не блокирует другие посты)
let isPostingInProgress = false;

async function sendToGroups() {
  // Отключаем кнопку сразу — до проверки флага, чтобы закрыть гонку двойного клика
  const btn = modalEl.querySelector("#vkr-submit");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Отправка...";
  }

  // Защита от двойного клика
  if (isPostingInProgress) {
    console.warn("[VKR] Posting already in progress, ignoring click");
    showToast("⚠️ Отправка уже выполняется!", "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📤 Опубликовать";
    }
    return;
  }

  isPostingInProgress = true;

  try {
    const $ = (id) => modalEl.querySelector("#" + id);

    const sel = [];
    modalEl
      .querySelectorAll("#vkr-groups-list input:checked")
      .forEach((c) => sel.push(c.value));
    if (!sel.length) {
      setStatus("❌ Выберите группы!", "error");
      return;
    }
    if (!post) {
      setStatus("❌ Пост не загружен!", "error");
      return;
    }

    chrome.storage.local.set({ vkr_groups: sel });

    const txt = $("vkr-post-text").value;

    // Watermark settings
    let processedPhotos = [];

    if ($("vkr-watermark-enabled").checked && mode === "copy") {
      const wmId = $("vkr-watermark-list").value;
      if (wmId && post.attachments) {
        const data = await chrome.storage.local.get("vkr_watermarks");
        const watermarks = data.vkr_watermarks || [];
        const wm = watermarks.find((w) => w.id === wmId);

        if (wm) {
          setStatus("⏳ Обработка фото с водяными знаками...", "info");

          const photoAttachments = post.attachments.filter(
            (a) => a.type === "photo",
          );

          for (const attachment of photoAttachments) {
            try {
              const sizes = attachment.photo.sizes || [];
              const best =
                sizes.find((s) => s.type === "w") ||
                sizes.find((s) => s.type === "z") ||
                sizes.find((s) => s.type === "y") ||
                sizes.find((s) => s.type === "x") ||
                sizes[sizes.length - 1];

              if (best) {
                const processedDataUrl = await applyWatermarkToPhoto(best.url, {
                  dataUrl: wm.dataUrl,
                  position: $("vkr-watermark-position").value,
                  opacity: parseInt($("vkr-watermark-opacity").value) / 100,
                  size: parseInt($("vkr-watermark-size").value) / 100,
                });

                processedPhotos.push(processedDataUrl);
              }
            } catch (e) {
              console.error("Photo processing error:", e);
            }
          }
        }
      }
    }

    // Schedule
    let pubDate = null;
    let intervalMinutes = 0;
    if ($("vkr-schedule").checked) {
      const d = $("vkr-date").value;
      const t = $("vkr-time").value;
      if (!d || !t || d.length < 10 || t.length < 5) {
        setStatus("❌ Укажите дату и время!", "error");
        return;
      }
      const [day, month, year] = d.split(".").map(Number);
      const [hours, minutes] = t.split(":").map(Number);
      pubDate = new Date(year, month - 1, day, hours, minutes).getTime();
      if (isNaN(pubDate) || pubDate <= Date.now()) {
        setStatus("❌ Дата должна быть в будущем!", "error");
        return;
      }
      intervalMinutes = parseInt($("vkr-interval")?.value || "0") || 0;
    }

    // Autodelete
    let autoDeleteAfter = null;
    if ($("vkr-autodelete").checked) {
      const hours = parseInt($("vkr-delete-hours").value) || 0;
      const minutes = parseInt($("vkr-delete-minutes").value) || 0;

      if (hours === 0 && minutes === 0) {
        setStatus("❌ Укажите время для автоудаления!", "error");
        return;
      }

      autoDeleteAfter = (hours * 60 + minutes) * 60 * 1000;
    }

    // Autocomment
    let autoCommentText = null;
    if ($("vkr-autocomment").checked) {
      const commentText = $("vkr-autocomment-text").value.trim();
      if (!commentText) {
        setStatus("❌ Введите текст комментария!", "error");
        return;
      }
      autoCommentText = commentText;
    }

    // Валидация пройдена — закрываем модалку и ставим в очередь
    if (modalEl) {
      modalEl.style.display = "none";
      modalEl.classList.remove("vkr-minimized");
    }
    isPostingInProgress = false; // сбрасываем сразу — очередь фоновая

    // Сообщение для фоновой очереди
    const label = "Пост" + (post.text ? " \"" + post.text.slice(0, 40) + "\"" : "");

    const messageData = {
      type: "enqueue_publish",
      post: post,
      groups: sel,
      mode: mode,
      text: txt || "",
      pubDate: pubDate,
      processedPhotos: processedPhotos,
      token: tok,
      label: label,
    };

    if (autoCommentText) messageData.autoCommentText = autoCommentText;
    if (autoDeleteAfter) messageData.autoDeleteAfter = autoDeleteAfter;

    // Ставим в очередь — не ждём завершения
    chrome.runtime.sendMessage(messageData, (response) => {
      if (chrome.runtime.lastError) {
        showToast("⚠️ Ошибка постановки в очередь: " + chrome.runtime.lastError.message, "error");
        return;
      }
      if (response && response.queued) {
        showToast("📤 Пост поставлен в очередь публикации!", "success");
      } else if (response && response.ok) {
        showToast("✅ Пост опубликован!", "success");
      } else {
        showToast("⚠️ " + (response?.error || "Ошибка"), "error");
      }
    });
  } catch (e) {
    console.error("[VKR] sendToGroups error:", e);
    showToast("❌ Ошибка: " + e.message, "error");
  } finally {
    isPostingInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📤 Опубликовать";
    }
  }
}

function esc(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

// ========== CUSTOM DIALOGS ==========
function showCustomAlert(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,0.75)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "z-index:2147483647",
      "-webkit-backdrop-filter:blur(6px)",
      "backdrop-filter:blur(6px)",
    ].join(";");

    const dialog = document.createElement("div");
    dialog.style.cssText = [
      "background:linear-gradient(145deg,#1a1a2e,#12121a)",
      "border:1px solid rgba(99,102,241,0.35)",
      "border-radius:16px",
      "padding:28px 24px 20px",
      "max-width:420px",
      "width:92%",
      "box-shadow:0 24px 80px rgba(0,0,0,0.6)",
      "font-family:system-ui,sans-serif",
    ].join(";");

    const msgEl = document.createElement("div");
    msgEl.style.cssText =
      "color:#f1f5f9;font-size:15px;line-height:1.65;margin-bottom:22px;white-space:pre-line;";
    msgEl.textContent = message;

    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = [
      "display:block",
      "margin-left:auto",
      "padding:10px 28px",
      "border-radius:10px",
      "border:none",
      "background:linear-gradient(135deg,#6366f1,#8b5cf6)",
      "color:#fff",
      "font-size:14px",
      "cursor:pointer",
      "font-weight:600",
    ].join(";");

    const finish = () => {
      overlay.remove();
      resolve();
    };
    okBtn.onclick = finish;
    overlay.onclick = (e) => {
      if (e.target === overlay) finish();
    };

    dialog.appendChild(msgEl);
    dialog.appendChild(okBtn);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    setTimeout(() => okBtn.focus(), 50);
  });
}

function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    // Инлайн стили — работает и в Shadow DOM, и в обычном document.body
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,0.75)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "z-index:2147483647",
      "-webkit-backdrop-filter:blur(6px)",
      "backdrop-filter:blur(6px)",
    ].join(";");

    const dialog = document.createElement("div");
    dialog.style.cssText = [
      "background:linear-gradient(145deg,#1a1a2e,#12121a)",
      "border:1px solid rgba(99,102,241,0.35)",
      "border-radius:16px",
      "padding:28px 24px 20px",
      "max-width:420px",
      "width:92%",
      "box-shadow:0 24px 80px rgba(0,0,0,0.6)",
      "font-family:system-ui,sans-serif",
    ].join(";");

    const msgEl = document.createElement("div");
    msgEl.style.cssText =
      "color:#f1f5f9;font-size:15px;line-height:1.65;margin-bottom:22px;white-space:pre-line;";
    msgEl.textContent = message;

    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:10px;justify-content:flex-end;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Отмена";
    cancelBtn.dataset.action = "cancel";
    cancelBtn.style.cssText = [
      "padding:10px 20px",
      "border-radius:10px",
      "border:1px solid rgba(255,255,255,0.12)",
      "background:rgba(255,255,255,0.06)",
      "color:#94a3b8",
      "font-size:14px",
      "cursor:pointer",
    ].join(";");

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Подтвердить";
    confirmBtn.dataset.action = "confirm";
    confirmBtn.style.cssText = [
      "padding:10px 20px",
      "border-radius:10px",
      "border:none",
      "background:linear-gradient(135deg,#6366f1,#8b5cf6)",
      "color:#fff",
      "font-size:14px",
      "cursor:pointer",
      "font-weight:600",
    ].join(";");

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };

    cancelBtn.onclick = () => finish(false);
    confirmBtn.onclick = () => finish(true);
    overlay.onclick = (e) => {
      if (e.target === overlay) finish(false);
    };

    btns.appendChild(cancelBtn);
    btns.appendChild(confirmBtn);
    dialog.appendChild(msgEl);
    dialog.appendChild(btns);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Фокус на кнопку подтверждения для удобства
    setTimeout(() => confirmBtn.focus(), 50);
  });
}

// ========== WATERMARK ==========
async function applyWatermarkToPhoto(photoUrl, settings) {
  return new Promise(async (resolve, reject) => {
    try {
      const photoResponse = await sendMessage("fetch_image", { url: photoUrl });
      const photoDataUrl = photoResponse.dataUrl;

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      const photoImg = new Image();
      const watermarkImg = new Image();

      photoImg.onload = () => {
        canvas.width = photoImg.width;
        canvas.height = photoImg.height;

        ctx.drawImage(photoImg, 0, 0);

        watermarkImg.onload = () => {
          const wmWidth = canvas.width * settings.size;
          const wmHeight = watermarkImg.height * (wmWidth / watermarkImg.width);

          let x, y;
          const padding = 20;

          switch (settings.position) {
            case "bottom-right":
              x = canvas.width - wmWidth - padding;
              y = canvas.height - wmHeight - padding;
              break;
            case "bottom-left":
              x = padding;
              y = canvas.height - wmHeight - padding;
              break;
            case "top-right":
              x = canvas.width - wmWidth - padding;
              y = padding;
              break;
            case "top-left":
              x = padding;
              y = padding;
              break;
            case "center":
              x = (canvas.width - wmWidth) / 2;
              y = (canvas.height - wmHeight) / 2;
              break;
            default:
              x = canvas.width - wmWidth - padding;
              y = canvas.height - wmHeight - padding;
          }

          ctx.globalAlpha = settings.opacity;
          ctx.drawImage(watermarkImg, x, y, wmWidth, wmHeight);
          ctx.globalAlpha = 1.0;

          const format = photoUrl.toLowerCase().includes(".png")
            ? "image/png"
            : "image/jpeg";
          const quality = format === "image/jpeg" ? 0.95 : 1.0;

          const resultDataUrl = canvas.toDataURL(format, quality);
          resolve(resultDataUrl);
        };

        watermarkImg.onerror = () =>
          reject(new Error("Не удалось загрузить водяной знак"));
        watermarkImg.src = settings.dataUrl;
      };

      photoImg.onerror = () => reject(new Error("Не удалось загрузить фото"));
      photoImg.src = photoDataUrl;
    } catch (e) {
      reject(e);
    }
  });
}

// ========== COMMENT MODAL FUNCTIONS ==========
async function openCommentModal(postUrl) {
  const m = postUrl.match(/wall(-?\d+_\d+)/) || postUrl.match(/(-?\d+_\d+)/);
  if (!m) return showCustomAlert("❌ Не удалось получить ID поста");
  currentCommentPostId = m[1];

  await initModals();

  const d = await chrome.storage.local.get([
    "vk_accounts",
    "vkr_comment_templates",
  ]);
  const accounts = d.vk_accounts || [];

  if (accounts.length === 0) {
    showCustomAlert("❌ Сначала добавьте аккаунты!");
    return;
  }

  const select = commentModalEl.querySelector("#vkr-comment-account");
  select.innerHTML = "";
  accounts.forEach((acc, i) => {
    const suffix = i === 0 ? " (Основной)" : " (Бот)";
    select.innerHTML += `<option value="${i}">${acc.name}${suffix}</option>`;
  });

  renderPhrases(d.vkr_comment_templates || []);

  commentModalEl.style.display = "flex";
}

function renderPhrases(phrases) {
  const list = commentModalEl.querySelector("#vkr-phrases-list");
  list.innerHTML = "";

  if (phrases.length === 0) {
    list.innerHTML =
      '<div style="color: #64748b; text-align: center; padding: 10px; font-size: 13px;">Нет заготовленных фраз</div>';
    return;
  }

  phrases.forEach((text, i) => {
    const div = document.createElement("div");
    div.style.cssText =
      "display:flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 6px;";
    div.innerHTML = `
      <span style="flex:1; word-break: break-word;">${esc(text)}</span>
      <button class="vkr-phrase-del" data-idx="${i}" style="background:transparent; border:none; color:#ef5350; cursor:pointer; font-size:16px; margin-left:8px;">✕</button>
    `;
    list.appendChild(div);
  });

  list.querySelectorAll(".vkr-phrase-del").forEach((btn) => {
    btn.onclick = async () => {
      const idx = parseInt(btn.dataset.idx);
      phrases.splice(idx, 1);
      await chrome.storage.local.set({ vkr_comment_templates: phrases });
      renderPhrases(phrases);
    };
  });
}

function bindCommentModalEvents() {
  const $ = (id) => commentModalEl.querySelector("#" + id);

  $("vkr-comment-close").onclick = () =>
    (commentModalEl.style.display = "none");
  commentModalEl.onclick = (e) => {
    if (e.target === commentModalEl) commentModalEl.style.display = "none";
  };

  // Make comment modal draggable
  const header = commentModalEl.querySelector("#vkr-modal-header");
  const modal = commentModalEl.querySelector("#vkr-modal");
  if (header && modal) {
    let isDragging = false;
    let currentX,
      currentY,
      initialX,
      initialY,
      xOffset = 0,
      yOffset = 0;

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;
      isDragging = true;
      header.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;
      xOffset = currentX;
      yOffset = currentY;
      modal.style.transform = `translate(${currentX}px, ${currentY}px)`;
    });

    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        header.style.cursor = "move";
      }
    });
  }

  $("vkr-add-phrase").onclick = async () => {
    const val = $("vkr-new-phrase").value.trim();
    if (!val) return;

    const d = await chrome.storage.local.get("vkr_comment_templates");
    const tpl = d.vkr_comment_templates || [];
    tpl.push(val);
    await chrome.storage.local.set({ vkr_comment_templates: tpl });

    $("vkr-new-phrase").value = "";
    renderPhrases(tpl);
  };

  $("vkr-send-comment-btn").onclick = async () => {
    const d = await chrome.storage.local.get([
      "vk_accounts",
      "vkr_comment_templates",
    ]);
    const tpl = d.vkr_comment_templates || [];
    const accounts = d.vk_accounts || [];

    if (tpl.length === 0)
      return showCustomAlert("❌ Добавьте хотя бы одну фразу!");

    const accIdx = $("vkr-comment-account").value;
    const account = accounts[accIdx];

    const randomText = tpl[Math.floor(Math.random() * tpl.length)];

    const parts = currentCommentPostId.split("_");
    const ownerId = parts[0];
    const postId = parts[1];

    const btn = $("vkr-send-comment-btn");
    btn.disabled = true;
    btn.textContent = "⏳ Отправка...";

    try {
      const res = await sendMessage("create_comment", {
        ownerId,
        postId,
        text: randomText,
        token: account.token,
      });

      if (res.ok) {
        $("vkr-comment-status").innerHTML =
          `<span style="color:#22c55e">✅ Отправлено: "${randomText}"</span>`;
        setTimeout(() => {
          commentModalEl.style.display = "none";
          $("vkr-comment-status").innerHTML = "";
          btn.disabled = false;
          btn.textContent = "🚀 Отправить случайную фразу";
        }, 2000);
      } else {
        throw new Error(res.error);
      }
    } catch (e) {
      $("vkr-comment-status").innerHTML =
        `<span style="color:#ef5350">❌ Ошибка: ${e.message}</span>`;
      btn.disabled = false;
      btn.textContent = "🚀 Повторить";
    }
  };
}

// ========== BEST POSTS FEATURE ==========
function detectCurrentPage() {
  const url = window.location.href;

  // Проверяем различные форматы URL групп (vk.com и vk.ru)
  const clubMatch = url.match(/vk\.(com|ru)\/club(\d+)/);
  const publicMatch = url.match(/vk\.(com|ru)\/public(\d+)/);
  const eventMatch = url.match(/vk\.(com|ru)\/event(\d+)/);
  const wallMatch = url.match(/vk\.(com|ru)\/wall-(\d+)/);

  if (clubMatch) return { type: "group", id: -parseInt(clubMatch[2]) };
  if (publicMatch) return { type: "group", id: -parseInt(publicMatch[2]) };
  if (eventMatch) return { type: "group", id: -parseInt(eventMatch[2]) };
  if (wallMatch) return { type: "group", id: -parseInt(wallMatch[2]) };

  // Проверяем короткое имя (например, vk.com/2dworldanime или vk.ru/2dworldanime)
  const shortNameMatch = url.match(/vk\.(com|ru)\/([a-zA-Z0-9_]+)$/);
  if (
    shortNameMatch &&
    shortNameMatch[2] !== "feed" &&
    shortNameMatch[2] !== "im"
  ) {
    return { type: "shortname", name: shortNameMatch[2] };
  }

  // Пытаемся найти ID в DOM
  const groupIdEl = document.querySelector("[data-group-id]");
  if (groupIdEl) {
    const gid = groupIdEl.getAttribute("data-group-id");
    return { type: "group", id: -parseInt(gid) };
  }

  // Ищем в meta тегах
  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    const ogUrlContent = ogUrl.getAttribute("content");
    const ogClubMatch = ogUrlContent.match(/vk\.(com|ru)\/club(\d+)/);
    const ogPublicMatch = ogUrlContent.match(/vk\.(com|ru)\/public(\d+)/);
    if (ogClubMatch) return { type: "group", id: -parseInt(ogClubMatch[2]) };
    if (ogPublicMatch)
      return { type: "group", id: -parseInt(ogPublicMatch[2]) };
  }

  // Ищем в canonical link
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) {
    const canonicalHref = canonical.getAttribute("href");
    const canClubMatch = canonicalHref.match(/vk\.(com|ru)\/club(\d+)/);
    const canPublicMatch = canonicalHref.match(/vk\.(com|ru)\/public(\d+)/);
    if (canClubMatch) return { type: "group", id: -parseInt(canClubMatch[2]) };
    if (canPublicMatch)
      return { type: "group", id: -parseInt(canPublicMatch[2]) };
  }

  console.log("[VKR] Could not detect page info from URL:", url);
  return null;
}

// Safe replacement for the legacy cleanup dialogs above. It uses a preview ticket
// issued by the background worker; no page script can supply an arbitrary delete list.
function cleanupDateValue(daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function appendCleanupSample(container, sample) {
  container.replaceChildren();
  if (!Array.isArray(sample) || sample.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vkr-safe-cleanup-sample-empty";
    empty.textContent = "В выбранном диапазоне нет примеров для показа.";
    container.appendChild(empty);
    return;
  }
  for (const item of sample || []) {
    const row = document.createElement("div");
    row.className = "vkr-safe-cleanup-sample-row";
    if (item.thumbnail) {
      const image = document.createElement("img");
      image.src = item.thumbnail;
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.className = "vkr-safe-cleanup-sample-image";
      row.appendChild(image);
    }
    const copy = document.createElement("div");
    copy.className = "vkr-safe-cleanup-sample-copy";
    const date = item.date ? new Date(item.date * 1000).toLocaleDateString("ru-RU") : "без даты";
    const title = document.createElement("strong");
    title.textContent = item.kind === "wall" ? `Запись #${item.postId}` : item.albumTitle || "Альбом";
    const description = document.createElement("span");
    description.textContent = item.kind === "wall" ? `${date} · ${item.text}` : `${date} · фотография #${item.photoId}`;
    copy.append(title, description);
    row.appendChild(copy);
    container.appendChild(row);
  }
}

function openSafeCleanupModal(groupId, kind) {
  const isWall = kind === "wall";
  document.querySelector(".vkr-safe-cleanup-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "vkr-safe-cleanup-overlay";
  const modal = document.createElement("section");
  modal.className = "vkr-safe-cleanup-dialog";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "vkr-safe-cleanup-title");
  modal.innerHTML = `
    <header class="vkr-safe-cleanup-header">
      <div class="vkr-safe-cleanup-icon" aria-hidden="true">${isWall ? "⌫" : "▧"}</div>
      <div class="vkr-safe-cleanup-heading">
        <span>VK Reposter Pro · безопасная очистка</span>
        <h2 id="vkr-safe-cleanup-title">${isWall ? "Очистка записей" : "Очистка фотографий"}</h2>
        <p>Сначала расширение покажет точный список. Удаление начнётся только после подтверждения и пойдёт по одному объекту.</p>
      </div>
      <button class="vkr-safe-cleanup-close" data-role="close" type="button" aria-label="Закрыть">×</button>
    </header>
    <div class="vkr-safe-cleanup-steps" aria-label="Этапы очистки">
      <span class="is-current" data-step="1"><b>1</b> Период</span>
      <i></i>
      <span data-step="2"><b>2</b> Проверка</span>
      <i></i>
      <span data-step="3"><b>3</b> Очистка</span>
    </div>
    <div class="vkr-safe-cleanup-body">
      <section class="vkr-safe-cleanup-section">
        <div class="vkr-safe-cleanup-section-head"><div><b>Выберите период</b><span>Обе даты включаются в диапазон</span></div><span class="vkr-safe-cleanup-group">club${Math.abs(Number(groupId))}</span></div>
        <div class="vkr-safe-cleanup-dates">
          <label><span>От</span><input data-role="from" type="date"></label>
          <span class="vkr-safe-cleanup-date-arrow" aria-hidden="true">→</span>
          <label><span>До</span><input data-role="to" type="date"></label>
        </div>
        <div data-role="quick" class="vkr-safe-cleanup-quick"></div>
      </section>
      ${isWall ? '<section class="vkr-safe-cleanup-options"><label><input data-role="photos" type="checkbox"><span><b>Удалить свои прикреплённые фото</b><small>Только фотографии, принадлежащие этому сообществу</small></span></label><label><input data-role="pinned" type="checkbox" checked><span><b>Не трогать закреплённую запись</b><small>Закреп останется на стене независимо от даты</small></span></label></section>' : '<section data-role="albums" class="vkr-safe-cleanup-albums" hidden></section>'}
      <section data-role="preview" class="vkr-safe-cleanup-preview" hidden>
        <div class="vkr-safe-cleanup-preview-head"><div><span>Предварительный список</span><strong data-role="counts">Ничего не выбрано</strong></div><span class="vkr-safe-cleanup-checked">Проверено</span></div>
        <div class="vkr-safe-cleanup-preview-stats">
          <div><span>Записей</span><b data-role="preview-posts">0</b></div>
          <div><span>Фотографий</span><b data-role="preview-photos">0</b></div>
          <div><span>Всего действий</span><b data-role="preview-total">0</b></div>
        </div>
        <div data-role="photo-budget" class="vkr-safe-cleanup-budget" aria-live="polite" hidden>
          <span class="vkr-safe-cleanup-budget-badge">24ч</span>
          <div><strong data-role="photo-budget-title">Лимит фотографий проверен</strong><p data-role="photo-budget-text"></p></div>
        </div>
        <div data-role="sample" class="vkr-safe-cleanup-sample"></div>
      </section>
      <section data-role="progress" class="vkr-safe-cleanup-progress" hidden>
        <div class="vkr-safe-cleanup-progress-head"><div><span data-role="run-state">Очистка запущена</span><strong data-role="progress-text">Обработано 0 из 0</strong></div><b data-role="percent">0%</b></div>
        <div class="vkr-safe-cleanup-track"><div data-role="bar"></div></div>
        <div class="vkr-safe-cleanup-progress-stats">
          <div><span>Записи</span><b data-role="deleted-posts">0</b></div>
          <div><span>Фото</span><b data-role="deleted-photos">0</b></div>
          <div><span>Пропущено</span><b data-role="skipped">0</b></div>
        </div>
        <div data-role="run-errors" class="vkr-safe-cleanup-errors" hidden></div>
      </section>
    </div>
    <footer class="vkr-safe-cleanup-actions"><button class="vkr-safe-cleanup-secondary" data-role="cancel" type="button">Отмена</button><button class="vkr-safe-cleanup-preview-button" data-role="preview-button" type="button">Показать список</button><button class="vkr-safe-cleanup-danger" data-role="start" type="button" disabled>Удалить после подтверждения</button></footer>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const from = modal.querySelector('[data-role="from"]');
  const to = modal.querySelector('[data-role="to"]');
  const quick = modal.querySelector('[data-role="quick"]');
  const previewButton = modal.querySelector('[data-role="preview-button"]');
  const startButton = modal.querySelector('[data-role="start"]');
  const cancelButton = modal.querySelector('[data-role="cancel"]');
  const previewBox = modal.querySelector('[data-role="preview"]');
  const counts = modal.querySelector('[data-role="counts"]');
  const sample = modal.querySelector('[data-role="sample"]');
  const progressBox = modal.querySelector('[data-role="progress"]');
  const progressBar = modal.querySelector('[data-role="bar"]');
  const progressText = modal.querySelector('[data-role="progress-text"]');
  const closeButton = modal.querySelector('[data-role="close"]');
  const percent = modal.querySelector('[data-role="percent"]');
  const runState = modal.querySelector('[data-role="run-state"]');
  const deletedPosts = modal.querySelector('[data-role="deleted-posts"]');
  const deletedPhotos = modal.querySelector('[data-role="deleted-photos"]');
  const skipped = modal.querySelector('[data-role="skipped"]');
  const runErrors = modal.querySelector('[data-role="run-errors"]');
  const previewPosts = modal.querySelector('[data-role="preview-posts"]');
  const previewPhotos = modal.querySelector('[data-role="preview-photos"]');
  const previewTotal = modal.querySelector('[data-role="preview-total"]');
  const photoBudgetBox = modal.querySelector('[data-role="photo-budget"]');
  const photoBudgetTitle = modal.querySelector('[data-role="photo-budget-title"]');
  const photoBudgetText = modal.querySelector('[data-role="photo-budget-text"]');
  const today = cleanupDateValue(0);
  from.max = today;
  to.max = today;
  from.value = cleanupDateValue(isWall ? 30 : 90);
  to.value = today;
  let previewId = "";
  let runId = "";
  let isRunning = false;
  let knownAlbums = [];
  let lastCounts = { posts: 0, photos: 0 };
  let lastMatchedCounts = { posts: 0, photos: 0 };
  let lastProgress = { current: 0, total: 0 };

  function setStep(step) {
    modal.querySelectorAll("[data-step]").forEach((item) => {
      const value = Number(item.dataset.step);
      item.classList.toggle("is-current", value === step);
      item.classList.toggle("is-complete", value < step);
    });
  }

  function lockForm(locked) {
    from.disabled = locked;
    to.disabled = locked;
    quick.querySelectorAll("button").forEach((button) => { button.disabled = locked; });
    modal.querySelectorAll('[data-role="photos"],[data-role="pinned"],[data-role="album-check"]').forEach((input) => { input.disabled = locked; });
    closeButton.disabled = locked;
  }

  const resetPreview = () => {
    if (isRunning) return;
    previewId = "";
    lastCounts = { posts: 0, photos: 0 };
    lastMatchedCounts = { posts: 0, photos: 0 };
    startButton.disabled = true;
    previewBox.hidden = true;
    progressBox.hidden = true;
    photoBudgetBox.hidden = true;
    photoBudgetBox.classList.remove("is-warning", "is-cooldown");
    setStep(1);
  };
  for (const days of (isWall ? [7, 30, 90] : [30, 90, 180, 365])) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${days} дн.`;
    button.className = "vkr-safe-cleanup-quick-button";
    if (days === (isWall ? 30 : 90)) button.classList.add("is-active");
    button.onclick = () => {
      quick.querySelectorAll("button").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      from.value = cleanupDateValue(days);
      to.value = today;
      resetPreview();
    };
    quick.appendChild(button);
  }
  const datesChanged = () => {
    quick.querySelectorAll("button").forEach((item) => item.classList.remove("is-active"));
    resetPreview();
  };
  from.onchange = datesChanged;
  to.onchange = datesChanged;
  modal.querySelector('[data-role="photos"]')?.addEventListener("change", resetPreview);
  modal.querySelector('[data-role="pinned"]')?.addEventListener("change", resetPreview);

  function selectedAlbumIds() {
    return [...modal.querySelectorAll('[data-role="album-check"]:checked')].map((input) => input.value);
  }
  function renderAlbums(albums) {
    const container = modal.querySelector('[data-role="albums"]');
    if (!container || !albums.length) return;
    const selected = new Set(selectedAlbumIds());
    knownAlbums = albums;
    container.replaceChildren();
    for (const album of albums) {
      const label = document.createElement("label");
      label.className = "vkr-safe-cleanup-album";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.role = "album-check";
      input.value = String(album.id);
      input.checked = selected.size ? selected.has(String(album.id)) : true;
      input.onchange = resetPreview;
      const copy = document.createElement("span");
      const title = document.createElement("b");
      title.textContent = album.title;
      const size = document.createElement("small");
      size.textContent = album.size === null ? "Количество уточнит VK" : `${album.size} фото`;
      copy.append(title, size);
      label.append(input, copy);
      container.appendChild(label);
    }
    container.hidden = false;
  }
  function renderRunErrors(errors) {
    const recent = Array.isArray(errors) ? errors.slice(-3) : [];
    runErrors.replaceChildren();
    runErrors.hidden = recent.length === 0;
    for (const error of recent) {
      const row = document.createElement("div");
      row.textContent = `${error.id ? `#${error.id}: ` : ""}${error.message || "Объект пропущен"}`;
      runErrors.appendChild(row);
    }
  }
  function formatCleanupBudgetTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return "после новой проверки VK";
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }
  function renderPhotoBudget(budget, matchedCounts = {}) {
    const matched = Math.max(0, Number(matchedCounts.photos) || 0);
    if (!budget || matched === 0) {
      photoBudgetBox.hidden = true;
      photoBudgetBox.classList.remove("is-warning", "is-cooldown");
      return;
    }
    const scheduled = Math.max(0, Number(budget.scheduled) || 0);
    const deferred = Math.max(0, Number(budget.deferred) || 0);
    const remaining = Math.max(0, Number(budget.remainingAfterRun) || 0);
    const limit = Math.max(1, Number(budget.limit) || 950);
    const isAfterRun = budget.isAfterRun === true;
    photoBudgetBox.classList.toggle("is-warning", deferred > 0 && !budget.cooldownUntil);
    photoBudgetBox.classList.toggle("is-cooldown", Boolean(budget.cooldownUntil));
    if (budget.cooldownUntil) {
      photoBudgetTitle.textContent = "Фотографии этого паблика на защитной паузе";
      photoBudgetText.textContent = isAfterRun
        ? `В этом запуске удалено ${scheduled} фото. Оставшиеся ${deferred} фото из списка не будут отправлены на удаление до ${formatCleanupBudgetTime(budget.cooldownUntil)}.`
        : `Найдено ${matched} фото, но они не будут отправлены на удаление до ${formatCleanupBudgetTime(budget.cooldownUntil)}. Записи стены без удаления фото можно очистить отдельно.`;
    } else if (deferred > 0) {
      const estimate = budget.nextAvailableEstimated ? " ориентировочно" : "";
      photoBudgetTitle.textContent = "Большой список разделён на безопасную пачку";
      if (isAfterRun) {
        const canContinueNow = Number(budget.nextAvailableAt) <= Date.now() + 60_000;
        photoBudgetText.textContent = `В этом запуске удалено ${scheduled} фото, в выбранном списке осталось ${deferred}. ${canContinueNow ? "Новую пачку можно сформировать уже сейчас." : `Новые места начнут освобождаться${estimate} ${formatCleanupBudgetTime(budget.nextAvailableAt)}.`}`;
      } else {
        photoBudgetText.textContent = `Найдено ${matched} фото. Сейчас войдёт ${scheduled}, ещё ${deferred} останутся. Новые места начнут освобождаться${estimate} ${formatCleanupBudgetTime(budget.nextAvailableAt)}.`;
      }
    } else {
      photoBudgetTitle.textContent = "Лимит фотографий проверен";
      photoBudgetText.textContent = isAfterRun
        ? `В этом запуске удалено ${scheduled} фото. Сейчас доступно ещё ${remaining}. Защита расширения — не более ${limit} фото на один паблик за скользящие 24 часа.`
        : `В этот запуск войдёт ${scheduled} фото; после него останется ${remaining} свободных удалений. Защита расширения — не более ${limit} фото на один паблик за скользящие 24 часа.`;
    }
    photoBudgetBox.hidden = false;
  }
  function updateProgress(message) {
    const total = Math.max(0, Number(message.total) || 0);
    const current = Math.min(total || Number(message.current) || 0, Math.max(0, Number(message.current) || 0));
    const value = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    lastProgress = { current, total };
    progressBar.style.width = `${value}%`;
    percent.textContent = `${value}%`;
    progressText.textContent = `Обработано ${current} из ${total}`;
    deletedPosts.textContent = String(message.deletedPosts || 0);
    deletedPhotos.textContent = String(message.deletedPhotos || 0);
    skipped.textContent = String(message.skipped || 0);
    renderRunErrors(message.errors);
  }
  function onCleanupMessage(message) {
    if (message.runId !== runId) return;
    if (message.type === "cleanup_progress") {
      runState.textContent = "Удаление выполняется по одному объекту";
      updateProgress(message);
    }
    if (message.type === "cleanup_finished") {
      isRunning = false;
      lockForm(false);
      cancelButton.disabled = false;
      cancelButton.textContent = "Закрыть";
      startButton.disabled = true;
      previewButton.disabled = message.status === "paused";
      previewButton.textContent = message.status === "paused" ? "Сначала проверьте VK" : "Сформировать новый список";
      const finalTotal = Number(message.total) || lastProgress.total;
      const finalCurrent = message.status === "completed" ? finalTotal : Number(message.completed) || lastProgress.current;
      renderPhotoBudget(message.photoBudget, lastMatchedCounts);
      updateProgress({ ...message, current: finalCurrent, total: finalTotal });
      progressBox.classList.remove("is-success", "is-paused", "is-cancelled");
      progressBox.classList.add(`is-${message.status}`);
      if (message.status === "paused") {
        runState.textContent = "VK остановил очистку для проверки";
        progressText.textContent = message.pausedError?.message || "Операция поставлена на защитную паузу";
      } else if (message.status === "cancelled") {
        runState.textContent = "Очистка остановлена";
        progressText.textContent = `Обработано ${finalCurrent} из ${finalTotal}`;
      } else {
        runState.textContent = "Очистка завершена";
        progressText.textContent = `Обработано ${finalTotal} из ${finalTotal}`;
      }
      showToast(message.status === "completed" ? "✅ Очистка завершена" : "ℹ️ Очистка остановлена", message.status === "completed" ? "success" : "info");
    }
  }
  chrome.runtime.onMessage.addListener(onCleanupMessage);
  function onKeyDown(event) { if (event.key === "Escape" && !isRunning) close(); }
  document.addEventListener("keydown", onKeyDown);
  function close() { chrome.runtime.onMessage.removeListener(onCleanupMessage); document.removeEventListener("keydown", onKeyDown); overlay.remove(); }
  overlay.onclick = (event) => { if (event.target === overlay && !isRunning) close(); };
  closeButton.onclick = () => { if (!isRunning) close(); };
  cancelButton.onclick = async () => {
    if (!isRunning) return close();
    cancelButton.disabled = true;
    cancelButton.textContent = "Останавливаем…";
    try { await sendMessage("cleanup_stop", { runId }); } catch (error) { showToast(`❌ ${error.message}`, "error"); cancelButton.disabled = false; cancelButton.textContent = "Стоп"; }
  };
  previewButton.onclick = async () => {
    if (!from.value || !to.value) return showToast("❌ Укажите обе даты", "error");
    if (new Date(`${from.value}T00:00:00`) > new Date(`${to.value}T23:59:59`)) return showToast("❌ Дата «От» должна быть раньше даты «До»", "error");
    previewButton.disabled = true;
    previewButton.textContent = "Считаю…";
    try {
      const response = await sendMessage("cleanup_preview", {
        kind,
        ownerId: groupId,
        dateFrom: from.value,
        dateTo: to.value,
        includeOwnedPhotos: modal.querySelector('[data-role="photos"]')?.checked === true,
        keepPinned: modal.querySelector('[data-role="pinned"]')?.checked !== false,
        albumIds: knownAlbums.length ? selectedAlbumIds() : undefined,
      });
      previewId = response.previewId;
      const suffix = response.counts.photos ? ` и ${response.counts.photos} фото` : "";
      counts.textContent = response.photoBudget?.deferred
        ? `Безопасная пачка: ${response.counts.posts} записей${suffix}.`
        : `Будет удалено: ${response.counts.posts} записей${suffix}.`;
      lastCounts = { posts: Number(response.counts.posts) || 0, photos: Number(response.counts.photos) || 0 };
      lastMatchedCounts = {
        posts: Number(response.matchedCounts?.posts) || lastCounts.posts,
        photos: Number(response.matchedCounts?.photos) || lastCounts.photos,
      };
      previewPosts.textContent = String(lastCounts.posts);
      previewPhotos.textContent = String(lastCounts.photos);
      previewTotal.textContent = String(lastCounts.posts + lastCounts.photos);
      renderPhotoBudget(response.photoBudget, response.matchedCounts);
      appendCleanupSample(sample, response.sample);
      previewBox.hidden = false;
      startButton.disabled = lastCounts.posts + lastCounts.photos === 0;
      if (!isWall) renderAlbums(response.albums || []);
      setStep(2);
    } catch (error) { showToast(`❌ ${error.message}`, "error"); resetPreview(); }
    finally { previewButton.disabled = false; previewButton.textContent = "Показать список"; }
  };
  startButton.onclick = async () => {
    const totalText = `${lastCounts.posts} записей${lastCounts.photos ? ` и ${lastCounts.photos} фото` : ""}`;
    const confirmation = await showCustomConfirm(`Удалить ${totalText}?\n\nЭто действие необратимо. Расширение будет удалять по одному объекту; процесс можно остановить.`);
    if (!confirmation) return;
    try {
      const response = await sendMessage("cleanup_start", { previewId });
      runId = response.runId;
      if (response.counts) {
        lastCounts = { posts: Number(response.counts.posts) || 0, photos: Number(response.counts.photos) || 0 };
      }
      renderPhotoBudget(response.photoBudget, lastMatchedCounts);
      isRunning = true;
      lastProgress = { current: 0, total: Number(response.total) || 0 };
      lockForm(true);
      startButton.disabled = true;
      previewButton.disabled = true;
      cancelButton.textContent = "Стоп";
      cancelButton.disabled = false;
      runState.textContent = "Подготовка к безопасной очистке";
      updateProgress({ current: 0, total: response.total, deletedPosts: 0, deletedPhotos: 0, skipped: 0, errors: [] });
      progressBox.classList.remove("is-success", "is-paused", "is-cancelled");
      progressBox.hidden = false;
      setStep(3);
    } catch (error) { showToast(`❌ ${error.message}`, "error"); }
  };

  setStep(1);
  requestAnimationFrame(() => from.focus());
}

function openBulkDeleteModal(groupId) { openSafeCleanupModal(groupId, "wall"); }
function openAlbumCleanModal(groupId) { openSafeCleanupModal(groupId, "albums"); }

function createFAB() {
  const pageInfo = detectCurrentPage();
  console.log("[VKR] Detected page info:", pageInfo);

  if (!pageInfo) {
    console.log("[VKR] No page info detected, FAB buttons will not be created");
    return;
  }

  if (document.querySelector(".vkr-fab")) {
    console.log("[VKR] FAB buttons already exist");
    return;
  }

  const fab = document.createElement("button");
  fab.className = "vkr-fab";
  fab.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="url(#vkrFabFire)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="vkrFabFire" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fef3c7"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;
  fab.title = "Лучшие посты";

  // Красивые стили для FAB кнопки
  fab.style.cssText = `
    position: fixed;
    bottom: 80px;
    right: 20px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
    border: none;
    color: white;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(249, 115, 22, 0.5);
    z-index: 9998;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.3s ease;
  `;

  fab.addEventListener("mouseenter", () => {
    fab.style.transform = "scale(1.1) rotate(10deg)";
    fab.style.boxShadow = "0 6px 24px rgba(249, 115, 22, 0.6)";
  });
  fab.addEventListener("mouseleave", () => {
    fab.style.transform = "scale(1) rotate(0deg)";
    fab.style.boxShadow = "0 4px 16px rgba(249, 115, 22, 0.5)";
  });

  fab.onclick = async () => {
    await openBestPostsModal(pageInfo);
  };

  document.body.appendChild(fab);

  // ========== ДОБАВЛЯЕМ КНОПКУ "ОЧИСТИТЬ ГРУППУ" ==========
  // Создаем вторую FAB кнопку для массового удаления
  const deleteFab = document.createElement("button");
  deleteFab.className = "vkr-fab vkr-fab-delete";
  deleteFab.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="url(#vkrFabTrash)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="vkrFabTrash" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fee2e2"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
  deleteFab.title = "Очистить группу";

  deleteFab.style.cssText = `
    position: fixed;
    bottom: 80px;
    right: 90px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
    border: none;
    color: white;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(239, 68, 68, 0.5);
    z-index: 9998;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.3s ease;
  `;

  deleteFab.addEventListener("mouseenter", () => {
    deleteFab.style.transform = "scale(1.1)";
    deleteFab.style.boxShadow = "0 6px 24px rgba(239, 68, 68, 0.6)";
  });
  deleteFab.addEventListener("mouseleave", () => {
    deleteFab.style.transform = "scale(1)";
    deleteFab.style.boxShadow = "0 4px 16px rgba(239, 68, 68, 0.5)";
  });

  deleteFab.onclick = async () => {
    let groupId = null;

    // Пытаемся получить ID из pageInfo
    if (pageInfo && pageInfo.id) {
      groupId = pageInfo.id.toString();
    }

    // Если не получилось, пытаемся определить из URL (vk.com и vk.ru)
    if (!groupId) {
      const url = window.location.href;
      const clubMatch = url.match(/vk\.(com|ru)\/club(\d+)/);
      const publicMatch = url.match(/vk\.(com|ru)\/public(\d+)/);
      const wallMatch = url.match(/vk\.(com|ru)\/wall-(\d+)/);

      if (clubMatch) groupId = "-" + clubMatch[2];
      else if (publicMatch) groupId = "-" + publicMatch[2];
      else if (wallMatch) groupId = "-" + wallMatch[2];
    }

    // Если это короткое имя, пытаемся резолвить через API
    if (!groupId && pageInfo && pageInfo.type === "shortname") {
      showToast("⏳ Определяем ID группы...", "info");
      try {
        const data = await chrome.storage.local.get(["vk_token"]);
        const token = data.vk_token;
        if (token) {
          const response = await sendMessage("resolve_screen_name", {
            screenName: pageInfo.name,
            token: token,
          });
          if (response.ok && response.objectType === "group") {
            groupId = "-" + response.objectId;
          }
        }
      } catch (e) {
        console.error("[VKR] Error resolving screen name:", e);
      }
    }

    if (groupId) {
      console.log("[VKR BULK DELETE] Opening modal for group:", groupId);
      openBulkDeleteModal(groupId);
    } else {
      showToast("❌ Не удалось определить ID группы", "error");
      console.error(
        "[VKR BULK DELETE] Could not determine group ID. URL:",
        window.location.href,
      );
    }
  };

  document.body.appendChild(deleteFab);

  // ========== КНОПКА "ОЧИСТИТЬ АЛЬБОМ" ==========
  const albumFab = document.createElement("button");
  albumFab.className = "vkr-fab vkr-fab-album";
  albumFab.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="url(#vkrFabImage)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="vkrFabImage" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ede9fe"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
  albumFab.title =
    "\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0430\u043B\u044C\u0431\u043E\u043C";

  albumFab.style.cssText = `
    position: fixed;
    bottom: 80px;
    right: 160px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
    border: none;
    color: white;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(139, 92, 246, 0.5);
    z-index: 9998;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.3s ease;
  `;

  albumFab.addEventListener("mouseenter", () => {
    albumFab.style.transform = "scale(1.1)";
    albumFab.style.boxShadow = "0 6px 24px rgba(139, 92, 246, 0.7)";
  });
  albumFab.addEventListener("mouseleave", () => {
    albumFab.style.transform = "scale(1)";
    albumFab.style.boxShadow = "0 4px 16px rgba(139, 92, 246, 0.5)";
  });

  albumFab.onclick = async () => {
    let groupId = null;

    if (pageInfo && pageInfo.id) {
      groupId = pageInfo.id.toString();
    }

    if (!groupId) {
      const url = window.location.href;
      const clubMatch = url.match(/vk\.(com|ru)\/club(\d+)/);
      const publicMatch = url.match(/vk\.(com|ru)\/public(\d+)/);
      const wallMatch = url.match(/vk\.(com|ru)\/wall-(\d+)/);
      if (clubMatch) groupId = "-" + clubMatch[2];
      else if (publicMatch) groupId = "-" + publicMatch[2];
      else if (wallMatch) groupId = "-" + wallMatch[2];
    }

    if (!groupId && pageInfo && pageInfo.type === "shortname") {
      showToast(
        "\u23F3 \u041E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u043C ID \u0433\u0440\u0443\u043F\u043F\u044B...",
        "info",
      );
      try {
        const data = await chrome.storage.local.get(["vk_token"]);
        const token = data.vk_token;
        if (token) {
          const response = await sendMessage("resolve_screen_name", {
            screenName: pageInfo.name,
            token,
          });
          if (response.ok && response.objectType === "group") {
            groupId = "-" + response.objectId;
          }
        }
      } catch (e) {
        console.error("[VKR ALBUM CLEAN] Error resolving screen name:", e);
      }
    }

    if (groupId) {
      openAlbumCleanModal(groupId);
    } else {
      showToast(
        "\u274C \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C ID \u0433\u0440\u0443\u043F\u043F\u044B",
        "error",
      );
    }
  };

  document.body.appendChild(albumFab);
}

async function openBestPostsModal(pageInfo) {
  if (!chrome || !chrome.storage || !chrome.storage.local) {
    return showCustomAlert("❌ Скрипт обновлен. Нажмите F5!");
  }

  const d = await chrome.storage.local.get(["vk_token"]);
  if (!d.vk_token) {
    showCustomAlert("❌ Сначала авторизуйтесь!");
    return;
  }
  tok = d.vk_token;

  if (pageInfo.type === "shortname") {
    try {
      const response = await sendMessage("resolve_screen_name", {
        screenName: pageInfo.name,
        token: tok,
      });
      if (response.objectType === "group") {
        currentOwnerId = -response.objectId;
      } else if (response.objectType === "user") {
        currentOwnerId = response.objectId;
      } else {
        showCustomAlert("❌ Это не группа и не пользователь");
        return;
      }
    } catch (e) {
      showCustomAlert("❌ Не удалось определить ID: " + e.message);
      return;
    }
  } else {
    currentOwnerId = pageInfo.id;
  }

  if (!bestPostsModalEl) {
    createBestPostsModal();
  }

  const settings = await chrome.storage.local.get("vkr_best_posts_settings");
  if (settings.vkr_best_posts_settings) {
    applyBestPostsSettings(settings.vkr_best_posts_settings);
  }

  bestPostsModalEl.style.display = "flex";
  bestPostsModalEl.querySelector("#vkr-bp-search-view").style.display = "block";
  bestPostsModalEl.querySelector("#vkr-bp-results-view").style.display = "none";

  // Play Lottie animation in header
  setTimeout(() => {
    window.postMessage({
      type: "VKR_PLAY_LOTTIE",
      containerId: "vkr-lottie-fire-heart",
      lottieScriptUrl: chrome.runtime.getURL("lottie-player.js"),
      jsonUrl: chrome.runtime.getURL("fire-heart.json"),
    }, "*");
  }, 100);
}

function createBestPostsModal() {
  const html = `
<div id="vkr-best-posts-overlay" style="display:none;">
  <div id="vkr-modal">
    <div id="vkr-bp-search-view">
      <div class="vkr-bp-header">
        <div style="display:flex;align-items:center;gap:8px"><div id="vkr-lottie-fire-heart" style="width:36px;height:36px;display:flex;align-items:center;justify-content:center"></div><span>Лучшие посты</span></div>
        <button class="vkr-bp-close">✕</button>
      </div>
      <div class="vkr-bp-body">
        <div class="vkr-bp-section">
          <div class="vkr-bp-label">📌 Паблик</div>
          <div class="vkr-bp-owner-info">ID: <span id="vkr-bp-owner-id">-</span></div>
        </div>
        <div class="vkr-bp-section">
          <div class="vkr-bp-label">📅 Период</div>
          <div style="display: flex; gap: 12px; margin-bottom: 12px;">
            <div style="flex: 1; display: flex; align-items: center; gap: 8px;"><label>С:</label><input type="text" id="vkr-bp-date-from" class="vkr-bp-input" placeholder="ДД.ММ.ГГГГ" maxlength="10" style="flex:1;"></div>
            <div style="flex: 1; display: flex; align-items: center; gap: 8px;"><label>По:</label><input type="text" id="vkr-bp-date-to" class="vkr-bp-input" placeholder="ДД.ММ.ГГГГ" maxlength="10" style="flex:1;"></div>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button class="vkr-chip" data-days="7">Неделя</button>
            <button class="vkr-chip" data-days="30">Месяц</button>
            <button class="vkr-chip" data-days="90">3 месяца</button>
            <button class="vkr-chip" data-days="180">6 месяцев</button>
            <button class="vkr-chip" data-days="365">Год</button>
            <button class="vkr-chip" data-days="3650">Всё время</button>
          </div>
        </div>
        <div class="vkr-bp-section">
          <div class="vkr-bp-label">📊 Сортировка</div>
          <div style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
            <button class="vkr-chip active" data-metric="likes">❤️ Лайки</button>
            <button class="vkr-chip" data-metric="views">👁 Просмотры</button>
            <button class="vkr-chip" data-metric="reposts">🔄 Репосты</button>
            <button class="vkr-chip" data-metric="comments">💬 Комменты</button>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;"><label>Мин. значение:</label><input type="number" id="vkr-bp-min-value" class="vkr-bp-input" placeholder="0" min="0" style="flex: 1;"></div>
        </div>
        <div class="vkr-bp-section">
          <div class="vkr-bp-label">📦 Загрузить постов</div>
          <input type="number" id="vkr-bp-count" class="vkr-bp-input" value="50" min="10" max="300" step="10" style="width: 100%; box-sizing: border-box;">
        </div>
        <div class="vkr-bp-section vkr-bp-filters">
          <label><input type="checkbox" id="vkr-bp-only-photo"> Только с фото</label>
          <label><input type="checkbox" id="vkr-bp-only-video"> Только с видео</label>
          <label><input type="checkbox" id="vkr-bp-no-reposts"> Без репостов</label>
        </div>
      </div>
      <div class="vkr-bp-footer">
        <button id="vkr-bp-search" class="vkr-mode-btn active" style="padding: 12px 24px; font-size: 14px;">🔍 Найти лучшие посты</button>
      </div>
    </div>

    <div id="vkr-bp-results-view" style="display:none;">
      <div class="vkr-bp-header">
        <span>🔥 Результаты</span>
        <button class="vkr-bp-close">✕</button>
      </div>
      <div class="vkr-bp-results-subheader">
        <button id="vkr-bp-back" class="vkr-mode-btn" style="padding: 8px 16px;">← Назад</button>
        <div id="vkr-bp-results-count">Найдено: 0</div>
      </div>
      <div id="vkr-bp-progress" style="display:none; padding: 24px 20px; text-align: center; background: var(--vkr-bg-secondary);">
        <div class="vkr-bp-progress-text">⏳ Загрузка постов...</div>
        <div class="vkr-bp-progress-container"><div id="vkr-bp-progress-bar"></div></div>
        <div id="vkr-bp-progress-info" style="margin-bottom: 16px; color: var(--vkr-text-muted);">Загружено: 0</div>
        <button id="vkr-bp-stop">⏹ Остановить</button>
      </div>
      <div id="vkr-bp-results-list"></div>
    </div>
  </div>
</div>`;
  const container = document.createElement("div");
  container.innerHTML = html;
  bestPostsModalEl = container.firstElementChild;
  document.body.appendChild(bestPostsModalEl);

  bindBestPostsEvents();
}

function bindBestPostsEvents() {
  const $ = (id) => bestPostsModalEl.querySelector("#" + id);

  bestPostsModalEl.querySelectorAll(".vkr-bp-close").forEach((btn) => {
    btn.onclick = () => {
      bestPostsModalEl.style.display = "none";
      isLoadingPosts = false;
      window.postMessage({ type: "VKR_DESTROY_LOTTIE" }, "*");
    };
  });

  bestPostsModalEl.querySelectorAll("[data-days]").forEach((chip) => {
    chip.onclick = () => {
      const days = parseInt(chip.dataset.days);
      const now = new Date();
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      $("vkr-bp-date-from").value = formatDate(from);
      $("vkr-bp-date-to").value = formatDate(now);
    };
  });

  bestPostsModalEl.querySelectorAll("[data-metric]").forEach((btn) => {
    btn.onclick = () => {
      bestPostsModalEl
        .querySelectorAll("[data-metric]")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    };
  });

  $("vkr-bp-search").onclick = () => searchBestPosts();
  $("vkr-bp-back").onclick = () => {
    $("vkr-bp-search-view").style.display = "block";
    $("vkr-bp-results-view").style.display = "none";
  };
  $("vkr-bp-stop").onclick = () => {
    isLoadingPosts = false;
  };

  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  $("vkr-bp-date-from").value = formatDate(monthAgo);
  $("vkr-bp-date-to").value = formatDate(now);
  $("vkr-bp-owner-id").textContent = currentOwnerId || "-";
}

async function searchBestPosts() {
  const $ = (id) => bestPostsModalEl.querySelector("#" + id);
  const settings = {
    dateFrom: $("vkr-bp-date-from").value,
    dateTo: $("vkr-bp-date-to").value,
    metric:
      bestPostsModalEl.querySelector("[data-metric].active")?.dataset.metric ||
      "likes",
    minValue: parseInt($("vkr-bp-min-value").value) || 0,
    count: parseInt($("vkr-bp-count").value) || 50,
    onlyPhoto: $("vkr-bp-only-photo").checked,
    onlyVideo: $("vkr-bp-only-video").checked,
    noReposts: $("vkr-bp-no-reposts").checked,
  };

  await chrome.storage.local.set({ vkr_best_posts_settings: settings });

  const dateFrom = parseDate($("vkr-bp-date-from").value);
  const dateTo = parseDate($("vkr-bp-date-to").value);

  if (!dateFrom || !dateTo)
    return showCustomAlert("❌ Укажите корректные даты");
  if (dateFrom > dateTo)
    return showCustomAlert('❌ Дата "С" должна быть раньше даты "По"');

  $("vkr-bp-search-view").style.display = "none";
  $("vkr-bp-results-view").style.display = "block";
  $("vkr-bp-progress").style.display = "block";
  $("vkr-bp-results-list").innerHTML = "";

  loadedPosts = [];
  isLoadingPosts = true;
  const maxCount = settings.count;
  let offset = 0;
  let totalRequests = 0;
  const dateFromUnix = Math.floor(dateFrom / 1000);
  const dateToUnix = Math.floor(dateTo / 1000);

  try {
    while (isLoadingPosts) {
      const response = await sendMessage("search_best_posts", {
        ownerId: currentOwnerId,
        dateFrom: dateFromUnix,
        dateTo: dateToUnix,
        count: 100,
        offset,
        token: tok,
      });

      totalRequests++;
      if (!response.posts || response.posts.length === 0) break;

      loadedPosts.push(...response.posts);

      const lastPostDate = response.posts[response.posts.length - 1].date;
      const progress = Math.min(
        100,
        Math.round((loadedPosts.length / maxCount) * 100),
      );
      bestPostsModalEl.querySelector(
        "#vkr-bp-progress #vkr-bp-progress-bar",
      ).style.width = progress + "%";
      $("vkr-bp-progress-info").textContent =
        `Загружено: ${loadedPosts.length} постов`;

      if (
        lastPostDate < dateFromUnix ||
        !response.hasMore ||
        totalRequests >= 30
      )
        break;
      offset += 100;
      await sleep(400);
    }

    isLoadingPosts = false;
    $("vkr-bp-progress").style.display = "none";

    let filtered = filterPosts(loadedPosts, settings, dateFromUnix, dateToUnix);
    filtered = sortPosts(filtered, settings.metric).slice(0, maxCount);
    renderResults(filtered, settings.metric);
    if (filtered.length > 0) {
      triggerConfetti();
    }
  } catch (e) {
    showCustomAlert("❌ Ошибка: " + e.message);
    $("vkr-bp-progress").style.display = "none";
  }
}

function filterPosts(posts, settings, dateFrom, dateTo) {
  return posts.filter((post) => {
    if (dateFrom && dateTo && (post.date < dateFrom || post.date > dateTo))
      return false;
    let value = 0;
    if (settings.metric === "likes") value = post.likes?.count || 0;
    else if (settings.metric === "views") value = post.views?.count || 0;
    else if (settings.metric === "reposts") value = post.reposts?.count || 0;
    else if (settings.metric === "comments") value = post.comments?.count || 0;

    if (value < settings.minValue) return false;
    if (
      settings.onlyPhoto &&
      (!post.attachments || !post.attachments.some((a) => a.type === "photo"))
    )
      return false;
    if (
      settings.onlyVideo &&
      (!post.attachments || !post.attachments.some((a) => a.type === "video"))
    )
      return false;
    if (settings.noReposts && post.copy_history) return false;
    return true;
  });
}

function sortPosts(posts, metric) {
  return posts.sort((a, b) => {
    let aVal = 0,
      bVal = 0;
    if (metric === "likes") {
      aVal = a.likes?.count || 0;
      bVal = b.likes?.count || 0;
    } else if (metric === "views") {
      aVal = a.views?.count || 0;
      bVal = b.views?.count || 0;
    } else if (metric === "reposts") {
      aVal = a.reposts?.count || 0;
      bVal = b.reposts?.count || 0;
    } else if (metric === "comments") {
      aVal = a.comments?.count || 0;
      bVal = b.comments?.count || 0;
    }
    return bVal - aVal;
  });
}

function renderResults(posts, metric) {
  const list = bestPostsModalEl.querySelector("#vkr-bp-results-list");
  bestPostsModalEl.querySelector("#vkr-bp-results-count").textContent =
    `Найдено: ${posts.length} постов`;

  if (posts.length === 0) {
    list.innerHTML =
      '<div style="text-align:center;color:#64748b;padding:48px 0;font-size:15px;">Постов не найдено</div>';
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const metricColor = {
    likes: "#f43f5e",
    views: "#38bdf8",
    reposts: "#34d399",
    comments: "#fb923c",
  };

  let html = "";
  posts.forEach((post, index) => {
    const postUrl = `https://vk.com/wall${post.owner_id}_${post.id}`;
    const date = new Date(post.date * 1000);
    const rawText = post.text || "";
    const text = rawText.substring(0, 400);
    const badge = medals[index] || `#${index + 1}`;
    const isTop3 = index < 3;

    // ── Собираем фото (до 4 штук) ──────────────────
    const photoUrls = [];
    if (post.attachments) {
      for (const a of post.attachments) {
        if (a.type === "photo" && a.photo) {
          const sizes = a.photo.sizes || [];
          const best = ["x", "y", "z", "w", "r", "q", "p", "o", "m", "s"]
            .map((t) => sizes.find((s) => s.type === t))
            .find(Boolean);
          if (best) photoUrls.push(best.url);
        }
        if (photoUrls.length >= 4) break;
      }
    }

    // ── Фото-полоска ───────────────────────────────────────────────────
    let photoStrip = "";
    if (photoUrls.length === 1) {
      photoStrip = `
        <div style="margin:0 0 12px;border-radius:10px;overflow:hidden;max-height:300px;">
          <img src="${photoUrls[0]}" class="vkr-bp-result-image-collage" data-full-url="${photoUrls[0]}" style="width:100%;height:300px;object-fit:cover;display:block;cursor:zoom-in;transition:transform 0.2s;">
        </div>`;
    } else if (photoUrls.length === 2) {
      photoStrip = `
        <div style="display:flex;gap:3px;border-radius:10px;overflow:hidden;height:220px;margin:0 0 12px;">
          <img src="${photoUrls[0]}" class="vkr-bp-result-image-collage" data-full-url="${photoUrls[0]}" style="flex:1;object-fit:cover;min-width:0;cursor:zoom-in;transition:transform 0.2s;">
          <img src="${photoUrls[1]}" class="vkr-bp-result-image-collage" data-full-url="${photoUrls[1]}" style="flex:1;object-fit:cover;min-width:0;cursor:zoom-in;transition:transform 0.2s;">
        </div>`;
    } else if (photoUrls.length >= 3) {
      const right = photoUrls
        .slice(1, 4)
        .map(
          (u) =>
            `<img src="${u}" class="vkr-bp-result-image-collage" data-full-url="${u}" style="flex:1;object-fit:cover;width:100%;min-height:0;cursor:zoom-in;transition:transform 0.2s;">`,
        )
        .join("");
      photoStrip = `
        <div style="display:flex;gap:3px;border-radius:10px;overflow:hidden;height:240px;margin:0 0 12px;">
          <img src="${photoUrls[0]}" class="vkr-bp-result-image-collage" data-full-url="${photoUrls[0]}" style="flex:2;object-fit:cover;min-width:0;cursor:zoom-in;transition:transform 0.2s;">
          <div style="flex:1;display:flex;flex-direction:column;gap:3px;min-width:0;">${right}</div>
        </div>`;
    }

    // ── Статы с подсветкой текущей метрики ────────────────────────────
    const mk = metricColor[metric] || "#94a3b8";
    const statsHtml = [
      { key: "likes", icon: "❤️", val: post.likes?.count || 0 },
      { key: "views", icon: "👁", val: post.views?.count || 0 },
      { key: "reposts", icon: "🔄", val: post.reposts?.count || 0 },
      { key: "comments", icon: "💬", val: post.comments?.count || 0 },
    ]
      .map(({ key, icon, val }) => {
        const active = key === metric;
        return `<span style="${active ? `color:${mk};font-weight:700;font-size:14px;` : "color:#64748b;font-size:13px;"}"
        >${icon} ${formatNumber(val)}</span>`;
      })
      .join("");

    html += `
      <div class="vkr-bp-result-item ${isTop3 ? "top-three" : ""}">
        <!-- Шапка -->
        <div class="vkr-bp-result-meta">
          <span class="vkr-bp-result-rank">${badge}</span>
          <span class="vkr-bp-result-date">📅 ${formatDate(date)}</span>
        </div>

        <!-- Фото -->
        ${photoStrip ? `<div style="margin-bottom:12px;">${photoStrip}</div>` : ""}

        <!-- Текст -->
        ${text
        ? `
        <div class="vkr-bp-result-text" style="white-space: pre-wrap; word-break: break-word; margin-bottom:12px;">${esc(text)}${rawText.length > 400 ? "<span style='color:#475569'> …</span>" : ""}</div>`
        : ""
      }

        <!-- Статы -->
        <div class="vkr-bp-result-stats">${statsHtml}</div>

        <!-- Кнопки -->
        <div class="vkr-bp-result-actions">
          <button class="vkr-bp-post-repost" data-post-url="${postUrl}" style="flex:1;">📋 Репостнуть</button>
          <button class="vkr-bp-post-pending" data-post-url="${postUrl}" style="flex:1;">⏳ В очередь</button>
          <a href="${postUrl}" target="_blank" class="vkr-mode-btn" style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 16px;">🔗 Открыть</a>
        </div>
      </div>`;
  });

  list.innerHTML = html;

  list.querySelectorAll(".vkr-bp-post-repost").forEach((btn) => {
    btn.onclick = async () => {
      bestPostsModalEl.style.display = "none";
      await openModal(btn.dataset.postUrl);
    };
  });

  list.querySelectorAll(".vkr-bp-post-pending").forEach((btn) => {
    btn.onclick = async () => {
      await addPostToPending(btn.dataset.postUrl);
    };
  });

  list.querySelectorAll(".vkr-bp-result-image-collage").forEach((img) => {
    img.onclick = () => {
      showLightbox(img.dataset.fullUrl);
    };
  });
}

function showLightbox(url) {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(5, 5, 10, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000000;
    cursor: zoom-out;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    animation: vkr-lightbox-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
  `;

  const style = document.createElement("style");
  style.textContent = `
    @keyframes vkr-lightbox-in {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
  `;
  overlay.appendChild(style);

  const img = document.createElement("img");
  img.src = url;
  img.style.cssText = `
    max-width: 95%;
    max-height: 95%;
    object-fit: contain;
    border-radius: var(--vkr-radius-md, 12px);
    box-shadow: 0 16px 48px rgba(0,0,0,0.8), 0 0 32px rgba(124,58,237,0.25);
    border: 2px solid rgba(124, 58, 237, 0.35);
  `;

  overlay.appendChild(img);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

function triggerConfetti() {
  const container = document.createElement("div");
  container.style.cssText = "position: fixed; inset: 0; pointer-events: none; z-index: 9999999; overflow: hidden;";
  document.body.appendChild(container);

  const colors = ["#7c3aed", "#a855f7", "#c084fc", "#10b981", "#3b82f6", "#f59e0b"];
  const count = 80;

  for (let i = 0; i < count; i++) {
    const confetti = document.createElement("div");
    const size = Math.random() * 8 + 6;
    const color = colors[Math.floor(Math.random() * colors.length)];

    confetti.style.cssText = `
      position: absolute;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${Math.random() > 0.5 ? "50%" : "2px"};
      top: -20px;
      left: ${Math.random() * 100}vw;
      opacity: ${Math.random() * 0.6 + 0.4};
      transform: rotate(${Math.random() * 360}deg);
      animation: vkr-fall-${i} ${Math.random() * 2 + 1.5}s linear forwards;
    `;

    const style = document.createElement("style");
    const drift = Math.random() * 200 - 100;
    style.textContent = `
      @keyframes vkr-fall-${i} {
        0% { transform: translateY(0) rotate(0deg); }
        100% { transform: translateY(105vh) translateX(${drift}px) rotate(${Math.random() * 720}deg); }
      }
    `;
    container.appendChild(style);
    container.appendChild(confetti);
  }

  setTimeout(() => container.remove(), 3500);
}

function applyBestPostsSettings(settings) {
  const $ = (id) => bestPostsModalEl.querySelector("#" + id);
  if (settings.dateFrom) $("vkr-bp-date-from").value = settings.dateFrom;
  if (settings.dateTo) $("vkr-bp-date-to").value = settings.dateTo;
  if (settings.minValue) $("vkr-bp-min-value").value = settings.minValue;
  if (settings.count) $("vkr-bp-count").value = settings.count;
  if (settings.onlyPhoto) $("vkr-bp-only-photo").checked = true;
  if (settings.onlyVideo) $("vkr-bp-only-video").checked = true;
  if (settings.noReposts) $("vkr-bp-no-reposts").checked = true;
  if (settings.metric) {
    bestPostsModalEl.querySelectorAll("[data-metric]").forEach((btn) => {
      if (btn.dataset.metric === settings.metric) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }
}

function formatNumber(n) {
  return n >= 1000000
    ? (n / 1000000).toFixed(1) + "M"
    : n >= 1000
      ? (n / 1000).toFixed(1) + "K"
      : n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}
function parseDate(str) {
  const parts = str.split(".");
  if (parts.length !== 3) return null;
  const date = new Date(
    parseInt(parts[2]),
    parseInt(parts[1]) - 1,
    parseInt(parts[0]),
  );
  return isNaN(date.getTime()) ? null : date.getTime();
}

// Init FAB — на странице клипов не нужна
// Init FAB и URL-обозреватель для SPA-переходов — на странице клипов и в автоматизационной вкладке не нужны
if (!isAutomationTab && !isClipsPage()) {
  setTimeout(() => {
    createFAB();
  }, 2000);

  let lastUrl = window.location.href;
  const handleUrlChange = () => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      const timer = setTimeout(() => {
        eventHandlers.timers.delete(timer);
        if (isClipsPage()) {
          // При переходе на /clips — убираем постовые кнопки, если были
          document.querySelectorAll('.vkr-buttons-container, .vkr-fab, .vkr-boost-btn, .vkr-twiboost-btn')
            .forEach(el => el.remove());
        } else {
          createFAB();
          processPosts(document);
          processComments(document);
        }
      }, 1000);
      eventHandlers.timers.add(timer);
    }
  };

  window.addEventListener('popstate', handleUrlChange);
  window.addEventListener('locationchange', handleUrlChange);
}

// ========== BOOST MODAL (SOC-ROCKET API) ==========
let boostModalEl = null;
let boostServices = [];
let boostBalance = 0;
async function openBoostModal(postUrl, postEl, filterType = null) {
  if (!boostModalEl) {
    createBoostModal();
  }

  boostModalEl.style.display = "flex";
  boostModalEl.querySelector("#vkr-boost-link").value = postUrl;
  boostModalEl.querySelector("#vkr-boost-status").textContent = "";

  // Сохраняем тип фильтра для использования в других функциях
  boostModalEl.dataset.filterType = filterType || "";

  // Update modal title based on type
  const modalTitle = boostModalEl.querySelector(".vkr-modal-title");
  if (modalTitle) {
    modalTitle.textContent =
      filterType === "comment"
        ? "🚀 Накрутка лайков на комментарий"
        : "🚀 Накрутка лайков";
  }

  // Load services and balance via background script
  await loadBoostServices(filterType);
  await loadBoostBalance();
}

function createBoostModal() {
  const modal = document.createElement("div");
  modal.id = "vkr-boost-modal-overlay";
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 99999999;
    backdrop-filter: blur(10px);
  `;

  modal.innerHTML = `
    <div id="vkr-boost-modal" style="
      background: linear-gradient(145deg, #12121a 0%, #0a0a0f 100%);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 20px;
      padding: 24px;
      width: 450px;
      max-width: 95vw;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 25px 60px rgba(0,0,0,0.7), 0 0 40px rgba(99, 102, 241, 0.2);
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h3 style="color: #f8fafc; font-size: 18px; margin: 0; font-weight: 700;">🚀 Накрутка Soc-Rocket</h3>
        <button id="vkr-boost-close" style="
          background: rgba(239, 68, 68, 0.2);
          border: 1px solid rgba(239, 68, 68, 0.3);
          color: #ef4444;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 18px;
          transition: all 0.2s;
        ">✕</button>
      </div>

      <div style="margin-bottom: 16px; padding: 12px; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.2); border-radius: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="color: #94a3b8; font-size: 13px;">💰 Баланс:</span>
          <span id="vkr-boost-balance" style="color: #22c55e; font-weight: 700; font-size: 16px;">Загрузка...</span>
        </div>
      </div>

      <div style="margin-bottom: 16px;">
        <label style="color: #94a3b8; font-size: 13px; display: block; margin-bottom: 6px;">🔗 Ссылка на пост</label>
        <input type="text" id="vkr-boost-link" readonly style="
          width: 100%;
          padding: 12px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px;
          color: #f8fafc;
          font-size: 13px;
          box-sizing: border-box;
        ">
      </div>

      <div style="margin-bottom: 16px; position: relative;">
        <label style="color: #94a3b8; font-size: 13px; display: block; margin-bottom: 6px;">📦 Услуга</label>
        <div id="vkr-boost-service-trigger" style="
          width: 100%;
          padding: 12px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px;
          color: #f8fafc;
          font-size: 14px;
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          align-items: center;
          box-sizing: border-box;
          transition: all 0.2s;
        ">
          <span id="vkr-boost-service-text">Загрузка услуг...</span>
          <span style="color: #64748b;">▼</span>
        </div>
        <div id="vkr-boost-service-dropdown" style="
          display: none;
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          margin-top: 4px;
          background: #12121a;
          border: 1px solid rgba(99, 102, 241, 0.3);
          border-radius: 10px;
          max-height: 300px;
          overflow-y: auto;
          z-index: 1000;
          box-shadow: 0 10px 40px rgba(0,0,0,0.5);
        "></div>
        <input type="hidden" id="vkr-boost-service" value="">
      </div>

      <div style="margin-bottom: 16px;">
        <label style="color: #94a3b8; font-size: 13px; display: block; margin-bottom: 6px;">🔢 Количество</label>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="number" id="vkr-boost-quantity" value="100" min="10" style="
            flex: 1;
            padding: 12px;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 10px;
            color: #f8fafc;
            font-size: 14px;
          ">
          <div id="vkr-boost-price" style="color: #f59e0b; font-weight: 700; font-size: 16px; min-width: 90px; text-align: right; padding: 12px; background: rgba(245, 158, 11, 0.1); border-radius: 10px;">0.00 ₽</div>
        </div>
        <div id="vkr-boost-limits" style="color: #64748b; font-size: 12px; margin-top: 6px; padding-left: 4px;"></div>
      </div>

      <div id="vkr-boost-status" style="
        padding: 12px;
        border-radius: 10px;
        margin-bottom: 16px;
        font-size: 14px;
        display: none;
      "></div>

      <button id="vkr-boost-submit" style="
        width: 100%;
        padding: 16px;
        background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
        border: none;
        border-radius: 12px;
        color: white;
        font-size: 16px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.2s;
        box-shadow: 0 4px 20px rgba(245, 158, 11, 0.3);
      ">🚀 Заказать накрутку</button>
    </div>
  `;

  document.body.appendChild(modal);
  boostModalEl = modal;

  // Bind events
  const closeBtn = modal.querySelector("#vkr-boost-close");
  closeBtn.onmouseenter = () => {
    closeBtn.style.background = "rgba(239, 68, 68, 0.3)";
  };
  closeBtn.onmouseleave = () => {
    closeBtn.style.background = "rgba(239, 68, 68, 0.2)";
  };
  closeBtn.onclick = () => {
    modal.style.display = "none";
  };

  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.style.display = "none";
    }
  };

  // Custom dropdown toggle
  const trigger = modal.querySelector("#vkr-boost-service-trigger");
  const dropdown = modal.querySelector("#vkr-boost-service-dropdown");

  trigger.onclick = (e) => {
    e.stopPropagation();
    const isOpen = dropdown.style.display === "block";
    dropdown.style.display = isOpen ? "none" : "block";
    trigger.style.borderColor = isOpen
      ? "rgba(255,255,255,0.1)"
      : "rgba(99, 102, 241, 0.5)";
  };

  // Close dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (!trigger.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = "none";
      trigger.style.borderColor = "rgba(255,255,255,0.1)";
    }
  });

  // Hover effect for trigger
  trigger.onmouseenter = () => {
    if (dropdown.style.display !== "block") {
      trigger.style.borderColor = "rgba(255,255,255,0.2)";
    }
  };
  trigger.onmouseleave = () => {
    if (dropdown.style.display !== "block") {
      trigger.style.borderColor = "rgba(255,255,255,0.1)";
    }
  };

  modal.querySelector("#vkr-boost-quantity").oninput = updateBoostPrice;

  // Prevent page scroll when using mouse wheel on quantity input
  const quantityInput = modal.querySelector("#vkr-boost-quantity");
  quantityInput.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Change value with mouse wheel
      const delta = e.deltaY > 0 ? -1 : 1;
      const currentValue = parseInt(quantityInput.value) || 0;
      const newValue = Math.max(
        parseInt(quantityInput.min) || 10,
        currentValue + delta,
      );
      quantityInput.value = newValue;

      // Trigger input event to update price
      quantityInput.dispatchEvent(new Event("input"));
    },
    { passive: false },
  );

  modal.querySelector("#vkr-boost-submit").onclick = submitBoostOrder;

  // Submit button hover
  const submitBtn = modal.querySelector("#vkr-boost-submit");
  submitBtn.onmouseenter = () => {
    submitBtn.style.transform = "translateY(-2px)";
    submitBtn.style.boxShadow = "0 6px 30px rgba(245, 158, 11, 0.4)";
  };
  submitBtn.onmouseleave = () => {
    submitBtn.style.transform = "translateY(0)";
    submitBtn.style.boxShadow = "0 4px 20px rgba(245, 158, 11, 0.3)";
  };
}

async function loadBoostServices(filterType = null) {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "twiboost_services" }, resolve);
    });

    if (!response.ok) {
      throw new Error(response.error || "Failed to load services");
    }

    // Filter services based on type
    let filteredServices = response.services || [];

    if (filterType === "comment") {
      // Для комментариев показываем только лайки на комментарии, исключаем кастомные комментарии
      filteredServices = filteredServices.filter(
        (s) =>
          s.category &&
          s.category.includes("VK Комментарии / Лайки на Комментарий") &&
          s.name &&
          s.name.includes("Лайки на Комментарий") &&
          !s.name.includes("Кастомные") &&
          !s.name.includes("Положительные") &&
          !s.name.includes("Мужской") &&
          !s.name.includes("Женский"),
      );
    } else {
      // Для постов показываем "VK Лайки" и "VK Репосты"
      filteredServices = filteredServices.filter(
        (s) =>
          s.category &&
          (s.category.includes("VK Лайки") ||
            s.category.includes("VK Репосты")),
      );
    }

    boostServices = filteredServices;

    const dropdown = boostModalEl.querySelector("#vkr-boost-service-dropdown");
    const serviceText = boostModalEl.querySelector("#vkr-boost-service-text");
    const serviceInput = boostModalEl.querySelector("#vkr-boost-service");

    dropdown.innerHTML = "";
    serviceText.textContent = "Выберите услугу...";
    serviceInput.value = "";

    if (boostServices.length === 0) {
      serviceText.textContent =
        filterType === "comment"
          ? "Нет услуг для комментариев"
          : "Нет доступных услуг";
      return;
    }

    // Group by category
    const categories = {};
    boostServices.forEach((s) => {
      if (!categories[s.category]) {
        categories[s.category] = [];
      }
      categories[s.category].push(s);
    });

    for (const [cat, items] of Object.entries(categories)) {
      // Category header
      const catHeader = document.createElement("div");
      catHeader.style.cssText = `
        padding: 8px 12px;
        color: #6366f1;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        background: rgba(99, 102, 241, 0.1);
        border-bottom: 1px solid rgba(99, 102, 241, 0.2);
        position: sticky;
        top: 0;
        z-index: 1;
      `;
      catHeader.textContent = cat;
      dropdown.appendChild(catHeader);

      // Service items
      items.forEach((s) => {
        const item = document.createElement("div");
        item.style.cssText = `
          padding: 10px 12px;
          color: #f8fafc;
          font-size: 13px;
          cursor: pointer;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          transition: all 0.15s ease;
          display: flex;
          justify-content: space-between;
          align-items: center;
        `;
        item.innerHTML = `
          <span style="flex: 1;">${s.name}</span>
          <span style="color: #f59e0b; font-size: 12px; font-weight: 600; background: rgba(245, 158, 11, 0.1); padding: 2px 8px; border-radius: 4px; margin-left: 8px;">${s.rate}₽/1K</span>
        `;
        item.dataset.service = s.service;
        item.dataset.min = s.min;
        item.dataset.max = s.max;
        item.dataset.rate = s.rate;
        item.dataset.name = s.name;

        item.onmouseenter = () => {
          item.style.background = "rgba(99, 102, 241, 0.2)";
        };
        item.onmouseleave = () => {
          item.style.background = "transparent";
        };

        item.onclick = () => {
          serviceText.textContent = `${s.name} (${s.rate}₽/1000)`;
          serviceInput.value = s.service;
          serviceInput.dataset.min = s.min;
          serviceInput.dataset.max = s.max;
          serviceInput.dataset.rate = s.rate;
          dropdown.style.display = "none";
          boostModalEl.querySelector(
            "#vkr-boost-service-trigger",
          ).style.borderColor = "rgba(255,255,255,0.1)";

          // Для комментариев устанавливаем минимальное значение, для постов - оставляем текущее
          const quantityInput = boostModalEl.querySelector(
            "#vkr-boost-quantity",
          );
          const isCommentMode = boostModalEl.dataset.filterType === "comment";

          if (isCommentMode) {
            quantityInput.value = s.min; // Минимальное значение для комментариев
          }

          updateBoostPrice();
        };

        dropdown.appendChild(item);
      });
    }

    // Custom scrollbar for dropdown
    dropdown.style.setProperty("scrollbar-width", "thin");
    dropdown.style.setProperty(
      "scrollbar-color",
      "rgba(99, 102, 241, 0.5) transparent",
    );
  } catch (e) {
    console.error("[Boost] Failed to load services:", e);
    const serviceText = boostModalEl.querySelector("#vkr-boost-service-text");
    serviceText.textContent = "❌ Ошибка загрузки";
    serviceText.style.color = "#ef4444";
  }
}

async function loadBoostBalance() {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "twiboost_balance" }, resolve);
    });

    if (!response.ok) {
      throw new Error(response.error || "Failed to load balance");
    }

    boostBalance = parseFloat(response.balance) || 0;
    boostModalEl.querySelector("#vkr-boost-balance").textContent =
      `${boostBalance.toFixed(2)} ${response.currency || "RUB"}`;
  } catch (e) {
    console.error("[Boost] Failed to load balance:", e);
    boostModalEl.querySelector("#vkr-boost-balance").textContent = "Ошибка";
  }
}

function updateBoostPrice() {
  const serviceInput = boostModalEl.querySelector("#vkr-boost-service");
  const quantityInput = boostModalEl.querySelector("#vkr-boost-quantity");
  const priceEl = boostModalEl.querySelector("#vkr-boost-price");
  const limitsEl = boostModalEl.querySelector("#vkr-boost-limits");

  if (!serviceInput.value) {
    priceEl.textContent = "0.00 ₽";
    limitsEl.textContent = "";
    return;
  }

  const rate = parseFloat(serviceInput.dataset.rate) || 0;
  const min = parseInt(serviceInput.dataset.min) || 10;
  const max = parseInt(serviceInput.dataset.max) || 10000;

  let quantity = parseInt(quantityInput.value) || min;
  quantity = Math.max(min, Math.min(max, quantity));
  quantityInput.value = quantity;
  quantityInput.min = min;
  quantityInput.max = max;

  const price = (quantity / 1000) * rate;
  priceEl.textContent = `${price.toFixed(2)} ₽`;
  limitsEl.textContent = `Мин: ${min}, Макс: ${max}`;
}

async function submitBoostOrder() {
  const statusEl = boostModalEl.querySelector("#vkr-boost-status");
  const submitBtn = boostModalEl.querySelector("#vkr-boost-submit");
  const link = boostModalEl.querySelector("#vkr-boost-link").value;
  const service = boostModalEl.querySelector("#vkr-boost-service").value;
  const quantity = boostModalEl.querySelector("#vkr-boost-quantity").value;

  if (!service) {
    showBoostStatus("Выберите услугу", "error");
    return;
  }

  if (!link) {
    showBoostStatus("Нет ссылки на пост", "error");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "⏳ Отправка...";
  showBoostStatus("Создаём заказ...", "info");

  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "twiboost_order",
          service,
          link,
          quantity,
        },
        resolve,
      );
    });

    if (!response.ok) {
      showBoostStatus(`❌ Ошибка: ${translateError(response.error)}`, "error");
    } else if (response.order) {
      showBoostStatus(`✅ Заказ #${response.order} создан!`, "success");
      showToast(`Заказ #${response.order} создан!`, "success");

      // Update balance
      await loadBoostBalance();
    }
  } catch (e) {
    showBoostStatus(`❌ Ошибка: ${e.message}`, "error");
  }

  submitBtn.disabled = false;
  submitBtn.textContent = "🚀 Заказать накрутку";
}

function showBoostStatus(message, type) {
  const statusEl = boostModalEl.querySelector("#vkr-boost-status");

  const colors = {
    success:
      "background: rgba(34, 197, 94, 0.2); border: 1px solid #22c55e; color: #22c55e;",
    error:
      "background: rgba(239, 68, 68, 0.2); border: 1px solid #ef4444; color: #ef4444;",
    info: "background: rgba(99, 102, 241, 0.2); border: 1px solid #6366f1; color: #6366f1;",
  };

  statusEl.style.cssText = `
    padding: 12px;
    border-radius: 10px;
    margin-bottom: 16px;
    font-size: 14px;
    display: block;
    ${colors[type] || colors.info}
  `;
  statusEl.textContent = message;
}

function translateError(error) {
  const translations = {
    "auth error": "Ошибка авторизации API",
    "no money": "Недостаточно средств на балансе",
    "not found": "Заказ не найден",
    "service null": "Не указана услуга",
    "link null": "Не указана ссылка",
    "qnt null": "Не указано количество",
    "limit min": "Количество меньше минимального",
    "limit max": "Количество больше максимального",
    "is already running": "Заказ уже выполняется",
    "is not link to the post": "Ссылка не на пост",
    "account is private": "Аккаунт закрытый",
  };

  return translations[error] || error;
}

// ==========================================
// VK Reposter Pro - DOM Clip Uploader Automation
// ==========================================
(function () {
  // Legacy clip DOM automation is intentionally disabled in safe mode.
  return;

  if (window.self !== window.top) return;

  const isAutomation = Boolean(clipAutomationJobId);
  if (isAutomation) {
    // Инжектируем стиль, чтобы скрыть фид клипов и разгрузить React/браузер
    const style = document.createElement('style');
    style.id = 'vkr-hide-clips-feed';
    style.textContent = `
      [class*="ShortsPage"], #clips_feed, .ShortsPage { display: none !important; }
      .vkuiPopoutRoot, .vkuiModalRoot, .vkuiAppRoot__portal, #modal, [class*="Popout"], [class*="ModalRoot"], body > div:not([class]), [data-testid*="clips-upload"] { display: block !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function disableBeforeUnload() {
    console.log("[VKR Automation] Disabling beforeunload handlers");
    window.onbeforeunload = null;
    window.addEventListener('beforeunload', (e) => {
      e.stopImmediatePropagation();
    }, true);
    try {
      window.postMessage({ type: 'VKR_DISABLE_BEFOREUNLOAD_MAIN' }, '*');
    } catch (e) { }
  }

  // Обработка сообщений от background.js / clips.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DISABLE_BEFOREUNLOAD') {
      disableBeforeUnload();
      if (sendResponse) sendResponse({ ok: true });
    }
    if (message.type === 'CLEAR_AUTOMATION_FLAG') {
      sessionStorage.removeItem('vkr_automation_tab');
      if (sendResponse) sendResponse({ ok: true });
    }
  });

  // ── Подавитель фоновых video на странице клипов ──
  let _videoPauserTimer = null;
  function startVideoPauser() {
    stopVideoPauser(); // на всякий случай

    _videoPauserTimer = setInterval(() => {
      const videos = document.querySelectorAll('video');
      for (const v of videos) {
        // Пропускаем видео внутри формы загрузки/редактора
        if (v.closest('.vkuiModalRoot, [data-testid*="clips-upload"]')) continue;
        if (!v.paused) {
          try {
            v.pause();
            v.muted = true;
            v.preload = 'none';
          } catch (e) { }
        }
      }
    }, 3000); // 3000мс для снижения нагрузки на CPU
  }
  function stopVideoPauser() {
    if (_videoPauserTimer) {
      clearInterval(_videoPauserTimer);
      _videoPauserTimer = null;
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "vk_clip_upload") return;

    console.log("[VKR Automation] Connected to extension port");

    // Флаг отключения — onDisconnect срабатывает при закрытии порта (popup закрыт, обновление вкладки и т.д.)
    port._vkrDisconnected = false;
    port.onDisconnect.addListener(() => {
      port._vkrDisconnected = true;
      stopVideoPauser(); // не глушить видео, если автоматизация завершилась
    });

    let receivedChunks = [];
    let receivedChunksCount = 0;
    let metadata = null;

    let hashUploadId = null;
    if (location.hash) {
      hashUploadId = location.hash.replace('#', '');
    }

    const safePort = {
      postMessage(msg) {
        // При закрытом порте молча выходим — никаких "Attempting to use a disconnected port object"
        if (port._vkrDisconnected) return;
        const uId = (metadata && metadata.uploadId) || hashUploadId;
        if (uId) {
          msg.uploadId = uId;
        }
        try {
          port.postMessage(msg);
        } catch (e) {
          // Если флаг по какой-то причине не сработал — тоже молча
        }
      },
      onMessage: port.onMessage,
      disconnect: () => port.disconnect()
    };

    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'DISABLE_BEFOREUNLOAD') {
        disableBeforeUnload();
      }
      else if (msg.type === 'METADATA') {
        metadata = msg;
        receivedChunks = [];
        receivedChunksCount = 0;
        startVideoPauser(); // глушим автоплей видео на время загрузки
        if (metadata.uploadId) {
          sessionStorage.setItem('vkr_active_upload_id', metadata.uploadId);
        }
        console.log("[VKR Automation] Metadata received:", metadata);
      }
      else if (msg.type === 'CHUNK') {
        const chunkIndex = msg.chunkIndex;
        // Декодируем Base64 в ArrayBuffer нативно и неблокирующе
        const buffer = await fetch('data:application/octet-stream;base64,' + msg.chunkData)
          .then(r => r.arrayBuffer());

        // Освобождаем ссылку на base64 данные
        msg.chunkData = null;

        receivedChunks[chunkIndex] = buffer;
        receivedChunksCount++;

        // Backpressure: подтверждаем приём чанка, чтобы отправитель слал следующий
        safePort.postMessage({ type: 'CHUNK_ACK', chunkIndex: chunkIndex });

        const progress = Math.round((receivedChunksCount / metadata.totalChunks) * 100);
        safePort.postMessage({ type: 'TRANSFER_PROGRESS', percent: progress });

        if (receivedChunksCount === metadata.totalChunks) {
          console.log("[VKR Automation] File transfer complete. Reassembling Blob...");
          const fileBlob = new Blob(receivedChunks, { type: metadata.fileType });
          receivedChunks = null; // освобождаем память сразу после сборки

          console.log("[VKR Automation] Original size:", metadata.fileSize, "Reassembled size:", fileBlob.size);
          if (metadata.fileSize && fileBlob.size !== metadata.fileSize) {
            const errStr = `Ошибка передачи файла во вкладку (получено: ${fileBlob.size} байт, ожидалось: ${metadata.fileSize} байт)`;
            console.error("[VKR Automation]", errStr);
            safePort.postMessage({ type: 'ERROR', message: errStr });
            return;
          }

          safePort.postMessage({ type: 'STATUS_UPDATE', message: 'Сборка файла во вкладке...', percent: 30, statusText: 'Сборка файла...' });

          try {
            await startClipUploadAutomation(fileBlob, metadata, safePort);
            stopVideoPauser();
          } catch (err) {
            console.error("[VKR Automation] Error:", err);
            safePort.postMessage({
              type: 'ERROR',
              message: err.message,
              needsReload: !!err.needsReload
            });
            stopVideoPauser();
          }
        }
      }
    });

    safePort.postMessage({ type: 'READY' });
  });

  let workerTimer = null;
  try {
    const blob = new Blob([
      "self.onmessage = function(e) { setTimeout(function() { self.postMessage(e.data.id); }, e.data.ms); };"
    ], { type: "application/javascript" });
    workerTimer = new Worker(URL.createObjectURL(blob));
  } catch (e) {
    console.warn("[VKR Automation] Failed to create Worker for background timers (CSP?):", e);
  }

  let timerIdCounter = 0;
  const activeTimers = new Map();

  if (workerTimer) {
    workerTimer.onmessage = function (e) {
      const resolve = activeTimers.get(e.data);
      if (resolve) {
        activeTimers.delete(e.data);
        resolve();
      }
    };
  }

  function delay(ms) {
    if (workerTimer) {
      return new Promise(resolve => {
        const id = ++timerIdCounter;
        activeTimers.set(id, resolve);
        workerTimer.postMessage({ id, ms });
      });
    }
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function detectBlockedStates() {
    const text = (document.body.innerText || '').toLowerCase();

    // 1. Требуется вход / авторизация
    if (document.querySelector('input[name="email"]') ||
      document.querySelector('#login_form') ||
      text.includes('войти вконтакте') ||
      text.includes('авторизоваться') ||
      location.href.includes('login') ||
      location.href.includes('oauth.vk.com') ||
      location.href.includes('oauth.vk.ru')) {
      throw new Error("Необходимо авторизоваться в аккаунте ВКонтакте во вкладке (требуется вход)");
    }

    // 2. Капча
    if (document.querySelector('input[name="captcha_key"]') ||
      document.querySelector('.Captcha') ||
      text.includes('введите код с картинки') ||
      text.includes('captcha')) {
      throw new Error("ВКонтакте требует ввести капчу во вкладке (обнаружена капча)");
    }

    // 3. Клипы недоступны
    if (text.includes('клипы недоступны') ||
      text.includes('раздел клипов отключен') ||
      text.includes('доступ ограничен') ||
      text.includes('ошибка доступа')) {
      throw new Error("Раздел клипов недоступен в сообществе или для вашего аккаунта (клипы недоступны)");
    }
  }

  function waitForElement(selector, timeout = 15000) {
    return new Promise((resolve, reject) => {
      try {
        detectBlockedStates();
      } catch (err) {
        return reject(err);
      }

      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        try {
          detectBlockedStates();
          const el = document.querySelector(selector);
          if (el) {
            observer.disconnect();
            resolve(el);
          }
        } catch (err) {
          observer.disconnect();
          reject(err);
        }
      });

      observer.observe(document.documentElement, { childList: true, subtree: true });

      delay(timeout).then(() => {
        observer.disconnect();
        reject(new Error(`Превышено время ожидания элемента: ${selector}`));
      });
    });
  }

  function waitForUploadButton(timeout = 30000) {
    return new Promise((resolve, reject) => {
      try {
        detectBlockedStates();
      } catch (err) {
        return reject(err);
      }

      const findButton = () => {
        // 1. Точный data-testid
        const testBtn = document.querySelector('[data-testid="clips-publish-button"]');
        if (testBtn) return testBtn;
        // 2. Текстовый fallback
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const txt = (btn.textContent || '').trim();
          if (txt === 'Опубликовать' || txt === 'Создать клип' || txt === 'Добавить клип') {
            return btn;
          }
        }
        return null;
      };

      const btn = findButton();
      if (btn) return resolve(btn);

      const observer = new MutationObserver(() => {
        try {
          detectBlockedStates();
          const btn = findButton();
          if (btn) {
            observer.disconnect();
            resolve(btn);
          }
        } catch (err) {
          observer.disconnect();
          reject(err);
        }
      });

      observer.observe(document.documentElement, { childList: true, subtree: true });

      delay(timeout).then(() => {
        observer.disconnect();
        reject(new Error('Не удалось найти кнопку "Опубликовать" на странице (таймаут)'));
      });
    });
  }

  function findElementByText(selectors, textList) {
    const elements = document.querySelectorAll(selectors);
    for (const el of elements) {
      const text = (el.textContent || '').trim().toLowerCase();
      if (textList.some(t => text === t || text.includes(t))) {
        return el;
      }
    }
    return null;
  }

  function findVideoFileInput() {
    const inputs = document.querySelectorAll('input[type="file"]');
    for (const input of inputs) {
      const accept = input.getAttribute('accept') || '';
      if (!accept.includes('image')) {
        return input;
      }
    }
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  /** Опрашивает DOM каждые 500ms до 15 секунд, пока не появится
   *  (а) видимая кнопка "Выбрать файл" → { type: 'modal', button }
   *  (б) видимое textarea описания → { type: 'direct', textarea }
   *  Если ничего не появилось — бросает ошибку. */
  let _communityDialogClicked = false;
  async function waitForUploadForm(timeoutMs = 15000) {
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeoutMs) {
      // Детект модалки по контейнеру
      const modalBox = document.querySelector('[class*="vkitInternalModalBox"]');
      if (modalBox && isVisible(modalBox)) {
        return { type: 'modal', container: modalBox };
      }

      // Единый проход по кнопкам: ищем и "Выбрать файл", и диалог сообщества
      const allBtns = document.querySelectorAll('button, [role="button"]');
      let foundForm = null;
      for (const btn of allBtns) {
        if (!isVisible(btn)) continue;
        const txt = (btn.textContent || '').trim();
        // (а) Кнопка "Выбрать файл" → модалка
        if (txt === 'Выбрать файл' || txt.includes('Выбрать файл')) {
          foundForm = { type: 'modal', button: btn };
          break;
        }
        // (б) Диалог сообщества (только пока не кликнули и только внутри видимого попапа)
        if (!_communityDialogClicked) {
          const inDialog = btn.closest(
            '[role="dialog"], [class*="vkuiPopover"], [class*="vkuiActionSheet"], ' +
            '[class*="vkuiModal"], [class*="Modal"], [class*="modal"], ' +
            '[class*="Popout"], [class*="popout"], [data-testid*="modal"]'
          );
          if (inDialog && isVisible(inDialog)) {
            const txtExact = (btn.textContent || '').trim();
            const txtLow = txtExact.toLowerCase();
            const isCommunityMatch =
              txtLow === 'сообщество' ||
              txtLow.includes('от имени сообщества') ||
              txtLow.includes('продолжить как сообщество');
            if (isCommunityMatch) {
              console.log("[VKR Automation] Choosing community posting context:", txtExact);
              btn.click();
              _communityDialogClicked = true;
              break;
            }
          }
        }
      }
      if (foundForm) return foundForm;

      // Текстовое поле описания → прямой редактор
      const ta = document.querySelector(
        'textarea[data-testid="clips-upload-description"], textarea[id^="clipDescription_"]'
      );
      if (ta && isVisible(ta)) {
        return { type: 'direct', textarea: ta };
      }

      await delay(pollInterval);
    }

    // Финальная проверка перед ошибкой
    const modalBoxFinal = document.querySelector('[class*="vkitInternalModalBox"]');
    if (modalBoxFinal && isVisible(modalBoxFinal)) {
      return { type: 'modal', container: modalBoxFinal };
    }

    const allBtnsFinal = document.querySelectorAll('button, [role="button"]');
    for (const btn of allBtnsFinal) {
      if (!isVisible(btn)) continue;
      const txt = (btn.textContent || '').trim();
      if (txt === 'Выбрать файл' || txt.includes('Выбрать файл')) {
        return { type: 'modal', button: btn };
      }
    }
    const taFinal = document.querySelector(
      'textarea[data-testid="clips-upload-description"], textarea[id^="clipDescription_"]'
    );
    if (taFinal && isVisible(taFinal)) {
      return { type: 'direct', textarea: taFinal };
    }

    throw new Error('Не дождались формы загрузки');
  }

  function cleanName(name) {
    if (!name) return '';
    return name.toLowerCase()
      .replace(/[^a-zа-яё0-9]/g, '');
  }

  /** Возвращает имя текущего автора из модалки, переключает на целевую группу если нужно.
   *  Выбрасывает ошибку если селектор автора не найден в модалке. */
  async function resolveAuthorName(authorSelector, metadata, isTargetGroup, targetRealId) {
    let authorName = (authorSelector.innerText || authorSelector.textContent || "").trim();
    if (authorName.includes('\n')) {
      authorName = authorName.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    }
    if (isTargetGroup && targetRealId) {
      const cleanTarget = cleanName(metadata.targetName);
      const cleanCurrent = cleanName(authorName);
      if (cleanCurrent !== cleanTarget) {
        console.log(`[VKR Automation] Author mismatch. Expected: "${metadata.targetName}", got: "${authorName}". Switching...`);
        authorSelector.click();

        // Ожидаем пункты [data-testid="clips-upload-modal-option-owner"] до 5 сек
        const menuStart = Date.now();
        let options = [];
        while (Date.now() - menuStart < 5000) {
          options = [...document.querySelectorAll('[data-testid="clips-upload-modal-option-owner"]')];
          if (options.length > 0 && options.some(opt => isVisible(opt))) {
            break;
          }
          await delay(300);
        }

        const groupItem = options.find(item => cleanName(item.textContent || '') === cleanTarget);
        if (!groupItem) {
          const availableNames = options.map(opt => (opt.textContent || '').trim()).filter(Boolean);
          const err = new Error(`Группа ${metadata.targetName} не найдена в списке авторов. Доступные авторы: [${availableNames.join(', ')}]`);
          err.needsReload = true;
          throw err;
        }

        console.log(`[VKR Automation] Found target group item in dropdown. Clicking...`);
        groupItem.click();
        await delay(1500);

        // Проверяем обновление
        let selectorUpdated = false;
        const checkStart = Date.now();
        while (Date.now() - checkStart < 5000) {
          const updatedSelector = findAuthorSelector();
          if (updatedSelector) {
            let updatedName = (updatedSelector.innerText || updatedSelector.textContent || "").trim();
            if (updatedName.includes('\n')) {
              updatedName = updatedName.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
            }
            if (cleanName(updatedName) === cleanTarget) {
              selectorUpdated = true;
              authorName = updatedName;
              break;
            }
          }
          await delay(300);
        }
        if (!selectorUpdated) {
          const err = new Error(`Не удалось верифицировать переключение автора на "${metadata.targetName}"`);
          err.needsReload = true;
          throw err;
        } else {
          console.log(`[VKR Automation] Author successfully switched to "${authorName}"`);
        }
      } else {
        console.log(`[VKR Automation] Author already matches target group.`);
      }
    }
    return authorName;
  }

  function findAuthorSelector() {
    // 1. Быстрый путь: data-testid-селекторы (были и раньше)
    const testIdSelectors = [
      '[data-testid="clips-upload-author"]',
      '[data-testid="clips-upload-author-selector"]',
      '[data-testid="clips-upload-owner-selector"]',
      '[data-testid="author-selector"]',
      '[data-testid="owner-selector"]'
    ];
    for (const sel of testIdSelectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }

    // 2. Точный селектор: кнопка внутри vkitInternalModalBox, 
    //    чей текст не «Закрыть», не «Выбрать файл» и не «Рекомендации для авторов»
    const modalBox = document.querySelector('[class*="vkitInternalModalBox"]');
    if (modalBox && isVisible(modalBox)) {
      const candidateBtns = modalBox.querySelectorAll('button');
      for (const btn of candidateBtns) {
        if (!isVisible(btn)) continue;
        const txt = (btn.textContent || '').trim();
        if (txt === 'Закрыть') continue;
        if (txt === 'Выбрать файл' || txt.includes('Выбрать файл')) continue;
        if (txt.includes('Рекомендации для авторов')) continue;
        return btn; // первая подходящая кнопка = селектор автора
      }
    }

    // 3. Эвристический fallback (старый код)
    const selectFileBtn = [...document.querySelectorAll('button, [role="button"]')].find(b => {
      const txt = (b.textContent || '').trim();
      return txt === 'Выбрать файл' || txt.includes('Выбрать файл');
    });

    if (selectFileBtn) {
      let container = selectFileBtn.parentElement;
      while (container) {
        const text = container.textContent || '';
        if (text.includes('Новый клип') || text.includes('Загрузка клипа')) {
          break;
        }
        container = container.parentElement;
        if (container && container.tagName === 'BODY') {
          container = null;
          break;
        }
      }

      if (container) {
        const candidates = [...container.querySelectorAll('div, [role="button"], [role="combobox"], span, a')].filter(el => {
          if (!isVisible(el)) return false;
          if (el.contains(selectFileBtn) || selectFileBtn.contains(el)) return false;
          const hasChevron = !!el.querySelector('svg[class*="chevron" i], [class*="Chevron" i]');
          const hasAvatar = !!el.querySelector('img, [style*="background-image"]');
          return hasChevron && hasAvatar;
        });
        if (candidates.length > 0) return candidates[0];
      }

      let prevSibling = selectFileBtn.previousElementSibling;
      while (prevSibling) {
        if (isVisible(prevSibling)) {
          const hasChevron = !!prevSibling.querySelector('svg[class*="chevron" i], [class*="Chevron" i]') ||
            prevSibling.tagName === 'SVG' ||
            (prevSibling.className && typeof prevSibling.className === 'string' && prevSibling.className.toLowerCase().includes('chevron'));
          const hasAvatar = !!prevSibling.querySelector('img, [style*="background-image"]') ||
            prevSibling.tagName === 'IMG' ||
            (prevSibling.style && prevSibling.style.backgroundImage);
          if (hasChevron && hasAvatar) return prevSibling;
        }
        prevSibling = prevSibling.previousElementSibling;
      }

      let sibling = selectFileBtn.parentElement;
      while (sibling) {
        let prev = sibling.previousElementSibling;
        while (prev) {
          if (isVisible(prev)) {
            const hasChevron = !!prev.querySelector('svg[class*="chevron" i], [class*="Chevron" i]');
            const hasAvatar = !!prev.querySelector('img, [style*="background-image"]');
            if (hasChevron && hasAvatar) return prev;
          }
          prev = prev.previousElementSibling;
        }
        sibling = sibling.parentElement;
        if (sibling && (sibling.tagName === 'BODY' || sibling.textContent.includes('Новый клип') || sibling.textContent.includes('Загрузка клипа'))) break;
      }
    }
    return null;
  }

  function findGroupItemInDropdown(targetRealId, screenName, targetName) {
    const cleanTargetName = cleanName(targetName);

    // 1. Точный data-testid-селектор
    const testidItems = document.querySelectorAll('[data-testid="clips-upload-modal-option-owner"]');
    for (const item of testidItems) {
      if (!isVisible(item)) continue;
      const itemText = cleanName(item.textContent || '');
      if (itemText === cleanTargetName) {
        return item;
      }
    }

    // 2. Эвристический fallback (старый код)
    const dropdownContainers = document.querySelectorAll(
      '[role="listbox"], [role="menu"], [class*="Dropdown"], [class*="Popover"], [class*="vkuiCustomSelect__options"], [class*="vkuiPopover"], [class*="vkuiActionSheet"], .vkuiCustomSelect__options, .vkuiPopover__content, .vkuiActionSheet'
    );

    const searchScopes = dropdownContainers.length > 0 ? Array.from(dropdownContainers) : [document.body];

    const targetClubStr = `club${targetRealId}`;
    const targetScreenName = screenName ? screenName.toLowerCase() : null;

    for (const scope of searchScopes) {
      const items = scope.querySelectorAll('a, button, [role="button"], [role="option"], [class*="option" i], [class*="item" i], div');

      for (const el of items) {
        if (!isVisible(el)) continue;

        let attrMatch = false;
        for (const attr of el.attributes) {
          const val = (attr.value || '').toLowerCase();
          if (val.includes(targetClubStr)) {
            attrMatch = true;
            break;
          }
          if (targetScreenName && val.includes(targetScreenName)) {
            attrMatch = true;
            break;
          }
        }

        const text = cleanName(el.textContent || '');
        const textMatch = text === cleanTargetName || text.includes(cleanTargetName);

        if (attrMatch || textMatch) {
          return el.closest('a, button, [role="button"], [role="option"]') || el;
        }
      }
    }

    return null;
  }

  /** Удалить загружаемый клип (при несовпадении владельца). Использует data-testid, текстовый fallback. */
  async function handleDeleteClip() {
    // data-testid кнопки удаления
    const deleteBtn = document.querySelector('[data-testid="clips-uploadForm-delete-button"]')
      || [...document.querySelectorAll('button, .FlatButton')].find(b => {
        const txt = (b.textContent || '').trim().toLowerCase();
        return txt.includes('удалить клип') || txt === 'удалить';
      });
    if (deleteBtn) {
      console.log("[VKR Automation] Clicking delete button...");
      deleteBtn.click();
      await delay(2000);
      const confirmBtn = document.querySelector('[data-testid="clips-uploadForm-delete-confirm"]')
        || [...document.querySelectorAll('button, .FlatButton')].find(b => {
          const txt = (b.textContent || '').trim().toLowerCase();
          return txt === 'удалить' || txt.includes('да, удалить') || txt.includes('подтвердить');
        });
      if (confirmBtn) {
        console.log("[VKR Automation] Clicking confirm delete button...");
        confirmBtn.click();
        await delay(3000);
      }
    }
  }

  async function startClipUploadAutomation(fileBlob, metadata, port) {
    console.log("[VKR Automation] Starting DOM Automation...");
    _communityDialogClicked = false;

    // Если мы открылись прямо в редакторе черновика (черновик остался незакрытым от предыдущих сессий)
    if (location.href.includes('/clips/upload')) {
      console.log("[VKR Automation] Detected unfinished draft on page load. Cleaning up...");
      const deleteBtn = document.querySelector('[data-testid="clips-uploadForm-delete-button"]') ||
                        [...document.querySelectorAll('button, .FlatButton')].find(b => {
                          const txt = (b.textContent || '').trim().toLowerCase();
                          return txt.includes('удалить клип') || txt === 'удалить';
                        });
      if (deleteBtn && isVisible(deleteBtn)) {
        port.postMessage({ type: 'STATUS_UPDATE', message: 'Сброс незавершенного черновика...', percent: 31, statusText: 'Сброс черновика...' });
        await handleDeleteClip();
        // Даем время на редирект обратно на страницу клипов
        await delay(3000);
      }
    }

    let descInput = null;
    let attempts = 0;
    let lastErrorMsg = '';
    let fileInput = null;
    let ownerVerifiedByUrl = false;

    const isTargetGroup = metadata.targetVal?.startsWith("group_");
    const targetRealId = isTargetGroup ? parseInt(metadata.targetVal.split("_")[1], 10) : null;

    function getDiagnosticInfo() {
      const visibility = document.visibilityState || 'unknown';
      const href = location.href;
      const testIds = [...document.querySelectorAll('[data-testid]')].map(el => el.getAttribute('data-testid')).filter(Boolean);
      const uniqueTestIds = [...new Set(testIds)];
      
      let inputsCount = document.querySelectorAll('input[type="file"]').length;
      let buttons = [...document.querySelectorAll('button')]
        .filter(b => isVisible(b))
        .map(b => (b.textContent || '').trim())
        .filter(t => t.length > 0)
        .slice(0, 10);

      let modals = [...document.querySelectorAll('[class*="Modal"], [role="dialog"]')]
        .filter(m => isVisible(m))
        .map(m => m.className || '')
        .filter(c => c.length > 0)
        .slice(0, 5);

      let pageText = (document.body.innerText || '').toLowerCase();
      let flags = [];
      if (pageText.includes('капч')) flags.push('капча');
      if (pageText.includes('ограничен')) flags.push('ограничен');
      if (pageText.includes('недоступ')) flags.push('недоступен');

      return `location=${href}, visibilityState=${visibility}, data-testids=[${uniqueTestIds.join(', ')}], inputs=${inputsCount}, кнопки=[${buttons.join(', ')}], модалки=[${modals.join(', ')}], флаги=[${flags.join(', ')}]`;
    }

    while (!descInput && attempts < 3) {
      const attemptNum = attempts + 1;
      console.log(`[VKR Automation] Injection attempt #${attemptNum}...`);
      ownerVerifiedByUrl = false;

      // Проверяем — может мы уже на странице загрузки
      fileInput = findVideoFileInput();

      if (!fileInput) {
        port.postMessage({ type: 'STATUS_UPDATE', message: 'Поиск кнопки Опубликовать...', percent: 33, statusText: 'Поиск кнопки...' });

        let uploadBtn = null;
        try {
          uploadBtn = await waitForUploadButton(30000);
        } catch (err) {
          throw new Error(`Не удалось найти кнопку "Опубликовать" на странице сообщества (30 сек). Убедитесь, что вы авторизованы в ВК и являетесь его руководителем. Детали: ${err.message}`);
        }

        console.log("[VKR Automation] Found button:", uploadBtn.textContent.trim(), "waiting before click...");
        await delay(1500); // Даем время React-у повесить обработчики событий
        
        console.log("[VKR Automation] Clicking button...");
        port.postMessage({ type: 'STATUS_UPDATE', message: 'Нажимаем кнопку Опубликовать (группа)...', percent: 36, statusText: 'Клик по кнопке...' });
        uploadBtn.click();

        port.postMessage({ type: 'STATUS_UPDATE', message: 'Ожидание формы загрузки клика...', percent: 38, statusText: 'Ожидание формы...' });

        try {
          fileInput = await waitForElement('input[type="file"]', 30000);
        } catch (e) {
          throw new Error('Форма загрузки клипа не открылась после клика. Возможно, у вас нет прав публикации в этом сообществе.');
        }
      } else {
        port.postMessage({ type: 'STATUS_UPDATE', message: 'Форма загрузки уже открыта...', percent: 38, statusText: 'Форма готова...' });
      }

      // Даем форме загрузки и инпуту время (2.0 сек) на стабилизацию в React
      await delay(2000);

      console.log("[VKR Automation] Performing file injection. Target input diagnostics: accept=\"" + (fileInput.getAttribute('accept') || 'none') + "\", isConnected=" + fileInput.isConnected);
      
      port.postMessage({
        type: 'STATUS_UPDATE',
        message: `Вставка файла видео (попытка ${attemptNum}/3)...`,
        percent: 42,
        statusText: 'Вставка файла...'
      });

      const responsePromise = new Promise((resolve, reject) => {
        let active = true;
        const handler = (event) => {
          if (event.data && event.data.type === 'VKR_INJECTION_RESPONSE') {
            active = false;
            window.removeEventListener('message', handler);
            if (event.data.success) {
              resolve();
            } else {
              reject(new Error(event.data.error || 'Ошибка вставки файла'));
            }
          }
        };
        window.addEventListener('message', handler);
        delay(25000).then(() => {
          if (active) {
            window.removeEventListener('message', handler);
            reject(new Error('Превышено время ожидания ответа от страницы (25 сек)'));
          }
        });
      });

      window.postMessage({
        type: 'VKR_PERFORM_INJECTION',
        fileBlob: fileBlob,
        fileName: metadata.fileName,
        fileType: metadata.fileType
      }, '*');

      try {
        await responsePromise;

        // в) дождаться формы загрузки по [data-testid="clips-upload-publish-date"] или [data-testid="clips-upload-audio"]
        console.log("[VKR Automation] Injection message received, waiting for edit form by data-testid...");
        port.postMessage({
          type: 'STATUS_UPDATE',
          message: 'Ожидание появления формы редактирования...',
          percent: 43,
          statusText: 'Ожидание формы...'
        });

        const formStart = Date.now();
        const formTimeout = 45000;
        let formAppeared = false;
        let foundDesc = null;
        while (Date.now() - formStart < formTimeout) {
          if (document.visibilityState === 'hidden') {
            console.log("[VKR Automation] Visibility is hidden, requesting focus...");
            port.postMessage({ type: 'NEED_FOCUS' });
          }
          
          foundDesc = document.querySelector('div[contenteditable="true"], textarea[placeholder*="описание"], textarea[placeholder*="клип"], [data-testid="clips-upload-description"]');
          const hasForm = document.querySelector('[data-testid="clips-upload-publish-date"]') || 
                          document.querySelector('[data-testid="clips-upload-audio"]') ||
                          foundDesc;
          if (hasForm && foundDesc && isVisible(foundDesc)) {
            formAppeared = true;
            break;
          }
          await delay(500);
        }

        if (!formAppeared || !foundDesc) {
          throw new Error('Форма редактирования не появилась или поле описания не видимо за 45 секунд после вставки файла');
        }

        descInput = foundDesc;

        // Ранняя проверка владельца по URL
        if (isTargetGroup && targetRealId && !ownerVerifiedByUrl) {
          const urlM = location.href.match(/\/clips\/upload(-?\d+)/);
          if (urlM) {
            const urlOwnerId = parseInt(urlM[1], 10);
            console.log(`[VKR Automation] URL owner check: got ${urlOwnerId}, expected group -${targetRealId}`);
            if (urlOwnerId !== -targetRealId) {
              console.warn(`[VKR Automation] URL owner mismatch: ${urlOwnerId} !== -${targetRealId}. Initiating immediate deletion...`);
              await handleDeleteClip();
              const err = new Error(`Владелец по URL: ${urlOwnerId}, ожидалась группа -${targetRealId}. Загрузка отменена`);
              err.needsReload = true;
              throw err;
            }
            ownerVerifiedByUrl = true;
            console.log(`[VKR Automation] URL owner verified: -${targetRealId}`);
          }
        }

        // г) выбор автора
        let currentAuthorName = "Личная страница";
        if (isTargetGroup && targetRealId) {
          currentAuthorName = metadata.targetName || `Группа ID: ${targetRealId}`;
        }

        const authorSelector = findAuthorSelector();
        if (authorSelector) {
          const authorName = await resolveAuthorName(authorSelector, metadata, isTargetGroup, targetRealId);
          currentAuthorName = authorName;
        } else {
          console.log("[VKR Automation] Селектор автора не найден на странице. Считаем автора корректным.");
        }

      } catch (err) {
        if (err.needsReload) {
          throw err;
        }
        attempts++;
        lastErrorMsg = err.message;
        console.warn(`[VKR Automation] Attempt ${attempts} failed: ${err.message}. Retrying...`);

        port.postMessage({
          type: 'STATUS_UPDATE',
          message: `Попытка ${attempts} не удалась: ${err.message}. Повторяем...`,
          percent: 42,
          statusText: 'Повторная попытка...'
        });

        fileInput = null;
        await delay(2000);
      }
    }

    if (!descInput) {
      const diagData = getDiagnosticInfo();
      throw new Error(`Не удалось загрузить видеофайл в форму VK (превышено число попыток). Детали последней ошибки: ${lastErrorMsg || 'Неизвестная ошибка вставки'}. Диагностика: ${diagData}`);
    }

    console.log("[VKR Automation] Main World injection completed successfully!");

    // ПРОВЕРКА ВЛАДЕЛЬЦА КЛИПА (вторая линия, если URL не дал ответа)
    if (isTargetGroup && targetRealId && !ownerVerifiedByUrl) {
      let ownerId = null;
      let videoIdOnly = null;

      if (descInput && descInput.id) {
        const m = descInput.id.match(/clipDescription_(-?\d+)_(\d+)/);
        if (m) {
          ownerId = parseInt(m[1], 10);
          videoIdOnly = m[2];
        }
      }

      if (ownerId === null) {
        const clipLinks = document.querySelectorAll('a[href*="clip"]');
        for (const link of clipLinks) {
          const href = link.getAttribute('href') || '';
          const m = href.match(/clip(-?\d+)_(\d+)/);
          if (m) {
            ownerId = parseInt(m[1], 10);
            videoIdOnly = m[2];
            break;
          }
        }
      }

      console.log(`[VKR Automation] Owner verification (clipDescription): expected group -${targetRealId}, got ownerId ${ownerId}`);

      if (ownerId !== null && ownerId !== -targetRealId) {
        console.warn(`[VKR Automation] Mismatched owner: got ${ownerId}, expected group -${targetRealId}. Initiating deletion...`);
        await handleDeleteClip();
        const err = new Error(`Редактор открылся от имени ${ownerId}, ожидалась группа -${targetRealId}. Загрузка отменена`);
        err.needsReload = true;
        throw err;
      }
    }

    console.log("[VKR Automation] Waiting for video processing/upload to complete...");
    port.postMessage({ type: 'STATUS_UPDATE', message: 'Загрузка файла на сервера ВКонтакте (это может занять время)...', percent: 45, statusText: 'Загрузка...' });

    let progressTimerActive = true;
    (async () => {
      while (progressTimerActive) {
        await delay(1000);
        if (!progressTimerActive) break;
        const progressEl = document.querySelector('.Upload__bar, [class*="progress"], [style*="width"]');
        if (progressEl) {
          let pct = 0;
          const width = progressEl.style.width || '';
          if (width.includes('%')) {
            pct = parseInt(width);
          } else {
            const match = progressEl.textContent.match(/(\d+)%/);
            if (match) pct = parseInt(match[1]);
          }
          if (pct > 0 && pct < 100) {
            port.postMessage({ type: 'UPLOAD_PROGRESS', percent: pct });
          }
        }
      }
    })();

    // Ждем окончания загрузки
    let isUploadingFinished = false;
    const maxUploadWait = 180000; // 3 минуты
    const uploadStart = Date.now();

    // Сначала дадим до 5 секунд на появление индикатора загрузки
    let hasSeenUploadBar = false;
    for (let sec = 0; sec < 5; sec++) {
      const uploadBar = document.querySelector('.Upload__bar, [class*="progress"]');
      if (uploadBar) {
        hasSeenUploadBar = true;
        break;
      }
      await delay(1000);
    }

    while (!isUploadingFinished && (Date.now() - uploadStart < maxUploadWait)) {
      if (document.visibilityState === 'hidden') {
        port.postMessage({ type: 'NEED_FOCUS' });
      }
      const uploadBar = document.querySelector('.Upload__bar, [class*="progress"]');
      const textUploaded = document.body.innerText.includes('Клип загружен') || document.body.innerText.includes('Загрузка клипа завершена');
      if ((hasSeenUploadBar && !uploadBar) || textUploaded) {
        isUploadingFinished = true;
        break;
      }
      await delay(1000);
    }

    progressTimerActive = false;

    // Убеждаемся, что поле описания всё ещё в DOM
    if (!document.body.contains(descInput)) {
      descInput = document.querySelector('textarea[data-testid="clips-upload-description"]') ||
        document.querySelector('textarea[id^="clipDescription_"]') ||
        document.querySelector('div[contenteditable="true"]');
      if (!descInput) {
        const textareas = document.querySelectorAll('textarea, input[type="text"]');
        for (const ta of textareas) {
          if (!isVisible(ta)) continue;
          const accept = ta.getAttribute('accept') || '';
          if (accept.includes('image')) continue;
          const ph = (ta.getAttribute('placeholder') || '').toLowerCase();
          if (ph.includes('опис') || ph.includes('клип') || ta.tagName.toLowerCase() === 'textarea') {
            descInput = ta;
            break;
          }
        }
      }
    }

    if (!descInput) {
      throw new Error("Поле описания исчезло из формы загрузки клипа");
    }

    port.postMessage({ type: 'UPLOAD_PROGRESS', percent: 100 });
    port.postMessage({ type: 'STATUS_UPDATE', message: 'Файл загружен. Заполнение описания...', percent: 85, statusText: 'Заполнение полей...' });

    console.log("[VKR Automation] Entering clip description...");

    const tagName = descInput.tagName.toUpperCase();
    const isEditableDiv = tagName === 'DIV' && descInput.getAttribute('contenteditable') === 'true';

    if (tagName !== 'TEXTAREA' && tagName !== 'INPUT' && !isEditableDiv) {
      console.warn(`[VKR Automation] descInput is not a text input field: ${descInput.tagName}, skipping description entry.`);
    } else {
      descInput.focus();
      if (tagName === 'DIV') {
        descInput.textContent = metadata.description;
        descInput.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const prototype = tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) {
          descriptor.set.call(descInput, metadata.description);
        } else {
          descInput.value = metadata.description;
        }
        descInput.dispatchEvent(new Event('input', { bubbles: true }));
        descInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // Управление параметром "Показать на главной сообщества" (wallpost)
    const wallpostSwitch = document.querySelector('input[data-testid="clips-upload-wallpost"]');
    if (wallpostSwitch) {
      const targetVal = metadata.wallpost !== false;
      console.log("[VKR Automation] Found wallpost switch, current checked state:", wallpostSwitch.checked, "target:", targetVal);
      if (wallpostSwitch.checked !== targetVal) {
        port.postMessage({ type: 'STATUS_UPDATE', message: 'Настройка отображения на главной сообщества...', percent: 86, statusText: 'Настройка параметров...' });
        try {
          const prototype = window.HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, 'checked');
          if (descriptor && descriptor.set) {
            descriptor.set.call(wallpostSwitch, targetVal);
          } else {
            wallpostSwitch.checked = targetVal;
          }
          wallpostSwitch.dispatchEvent(new Event('click', { bubbles: true }));
          wallpostSwitch.dispatchEvent(new Event('change', { bubbles: true }));
          console.log("[VKR Automation] Wallpost switch checked state set to:", wallpostSwitch.checked);
        } catch (switchErr) {
          console.error("[VKR Automation] Error toggling wallpost switch:", switchErr);
        }
        await delay(500);
      }
    }

    await delay(1000);

    console.log("[VKR Automation] Trying to extract video ID from page...");
    port.postMessage({ type: 'STATUS_UPDATE', message: 'Получение идентификатора клипа...', percent: 88, statusText: 'Получение ID...' });

    let videoId = null;

    if (descInput && descInput.id) {
      const m = descInput.id.match(/clipDescription_(-?\d+_\d+)/);
      if (m) {
        videoId = "video" + m[1];
        console.log("[VKR Automation] Extracted videoId from descInput.id:", videoId);
      }
    }

    if (!videoId) {
      const pageHtml = document.body.innerHTML;
      const videoIdMatch = pageHtml.match(/(video|clip)(-?\d+_\d+)/);
      if (videoIdMatch) {
        videoId = "video" + videoIdMatch[2];
        console.log("[VKR Automation] Extracted videoId from regex:", videoId);
      }
    }

    if (!videoId) {
      const videoEl = document.querySelector('[data-video], [data-id*="video"], [id*="video_"]');
      if (videoEl) {
        const val = videoEl.getAttribute('data-video') || videoEl.getAttribute('data-id') || videoEl.id;
        const m = val.match(/(video|clip)?(-?\d+_\d+)/);
        if (m) {
          videoId = "video" + m[2];
          console.log("[VKR Automation] Extracted videoId from attributes:", videoId);
        }
      }
    }

    if (!videoId) {
      throw new Error('Не удалось получить идентификатор загруженного клипа из разметки ВК.');
    }

    console.log("[VKR Automation] Automation success, ID:", videoId);

    // ПЛАНИРОВАНИЕ И ПУБЛИКАЦИЯ
    const targetDate = metadata.publishDate && metadata.publishDate > Date.now() + 60000 ? new Date(metadata.publishDate) : null;

    if (targetDate) {
      console.log("[VKR Automation] Scheduling publication for:", targetDate.toLocaleString());
      port.postMessage({ type: 'STATUS_UPDATE', message: `Планирование времени: ${targetDate.toLocaleString()}...`, percent: 90, statusText: 'Планирование времени...' });

      const publishDateBtn = document.querySelector('[data-testid="clips-upload-publish-date"]');
      if (publishDateBtn) {
        publishDateBtn.click();
        await delay(1000);

        // Настройка месяца
        const currentMonthInput = document.querySelector('[data-testid="clips-upload-calendar-month"]');
        if (currentMonthInput) {
          const targetMonthName = targetDate.toLocaleString('ru', { month: 'long' });
          let safety = 0;
          while (currentMonthInput.value.toLowerCase() !== targetMonthName.toLowerCase() && safety < 12) {
            const nextMonthBtn = document.querySelector('[data-testid="clips-upload-calendar-next-month"]');
            if (nextMonthBtn) {
              nextMonthBtn.click();
              await delay(500);
            }
            safety++;
          }
        }

        // Настройка времени
        const hoursInput = document.querySelector('[data-testid="clips-upload-calendar-hours"]');
        const minutesInput = document.querySelector('[data-testid="clips-upload-calendar-minutes"]');

        const setInputValue = (input, val) => {
          const prototype = input.tagName.toLowerCase() === 'textarea'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
          if (descriptor && descriptor.set) {
            descriptor.set.call(input, val);
          } else {
            input.value = val;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };

        if (hoursInput && minutesInput) {
          setInputValue(hoursInput, String(targetDate.getHours()).padStart(2, '0'));
          setInputValue(minutesInput, String(targetDate.getMinutes()).padStart(2, '0'));
        }

        // Настройка дня
        const dayCells = [...document.querySelectorAll('[data-testid="clips-upload-calendar-day"]')].filter(el => {
          const span = el.querySelector('span[aria-hidden="true"]');
          return span && span.textContent.trim() === String(targetDate.getDate());
        });

        if (dayCells.length > 0) {
          const cell = dayCells[0];
          const inner = cell.querySelector('.vkuiCalendarDay__inner, .vkuiCalendarDay__dayNumber') || cell;
          inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          inner.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          inner.click();
        }

        await delay(1000);
        publishDateBtn.click();
        await delay(1000);
      }
    }

    // Ожидание готовности финальной кнопки (максимум 60 секунд)
    console.log("[VKR Automation] Waiting for publish button to become active...");
    port.postMessage({ type: 'STATUS_UPDATE', message: 'Ожидание готовности кнопки публикации...', percent: 93, statusText: 'Ожидание готовности...' });

    let buttonReady = false;
    let finalBtn = null;
    
    for (let i = 0; i < 60; i++) {
      if (document.visibilityState === 'hidden') {
        port.postMessage({ type: 'NEED_FOCUS' });
      }

      finalBtn = document.querySelector('[data-testid="clips-publish-button"]') ||
                 document.querySelector('[data-testid="clips-uploadForm-publish-button"]');
      
      if (!finalBtn) {
        finalBtn = [...document.querySelectorAll('form button, button')].find(b => {
          const txt = (b.textContent || '').trim().toLowerCase();
          return txt === 'опубликовать' || txt === 'вперед' || txt.includes('запланировать');
        });
      }

      if (finalBtn) {
        const isNotDisabled = !finalBtn.disabled && !finalBtn.getAttribute('disabled');
        const isUploaded = document.body.innerText.includes('Клип загружен') || document.body.innerText.includes('Загрузка клипа завершена');

        if (isNotDisabled && isUploaded) {
          buttonReady = true;
          break;
        }
      }
      await delay(1000);
    }

    if (!buttonReady || !finalBtn) {
      const diagData = getDiagnosticInfo();
      throw new Error(`Превышено время ожидания готовности кнопки публикации (60 секунд). Возможно, видео обрабатывается слишком долго или произошел сбой сети. Диагностика: ${diagData}`);
    }

    console.log("[VKR Automation] Clicking final button:", finalBtn.textContent.trim());
    port.postMessage({ type: 'STATUS_UPDATE', message: 'Публикация клипа...', percent: 96, statusText: 'Публикация...' });
    finalBtn.click();

    // Ожидание перехода страницы
    console.log("[VKR Automation] Waiting for page transition...");
    let navigated = false;
    for (let i = 0; i < 20; i++) {
      if (document.visibilityState === 'hidden') {
        port.postMessage({ type: 'NEED_FOCUS' });
      }
      await delay(1000);
      if (!document.querySelector('[data-testid="clips-upload-description"]') || !location.href.includes('upload')) {
        navigated = true;
        break;
      }
    }

    if (!navigated) {
      console.warn("[VKR Automation] Navigation timeout. Proceeding anyway.");
    }

    port.postMessage({ type: 'SUCCESS', videoId: videoId });
  }
})();

// Старый загрузчик больше не используется. Safe-загрузчик общается с фоновым
// процессом через vkr_clip_upload_tab в clip-upload-content.js.
(function () {
  sessionStorage.removeItem("vkr_active_upload_id");
})();
