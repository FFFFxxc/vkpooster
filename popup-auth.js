"use strict";

const $ = (id) => document.getElementById(id);
let currentUserToken = "";
let currentUserProfile = null;

function notify(text, type = "info") {
  const existing = document.querySelector(".vkr-safe-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "vkr-safe-toast";
  toast.textContent = text;
  const colors = {
    info: "#2563eb",
    success: "#059669",
    warning: "#d97706",
    error: "#dc2626",
  };
  toast.style.cssText = [
    "position:fixed",
    "top:16px",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:999999",
    `background:${colors[type] || colors.info}`,
    "color:white",
    "padding:10px 16px",
    "border-radius:10px",
    "box-shadow:0 8px 30px rgba(0,0,0,.3)",
    "max-width:380px",
    "font:500 13px/1.4 system-ui,sans-serif",
    "text-align:center",
  ].join(";");
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function maskToken(token) {
  if (!token) return "";
  if (token.length < 12) return "••••••";
  return `${token.slice(0, 5)}…${token.slice(-4)}`;
}

function renderUserAccount(profile, token) {
  currentUserProfile = profile || null;
  currentUserToken = token || "";
  const connected = Boolean(currentUserToken && currentUserProfile?.id);
  $("user-profile").hidden = !connected;
  $("user-token-form").hidden = connected;
  $("cancel-user-token").hidden = !connected;
  if (!connected) {
    $("user-token").value = "";
    $("user-token").placeholder = "Вставьте пользовательский access_token";
    $("user-token-status").textContent = "Не настроен";
    $("user-token-status").className = "server-status";
    return;
  }

  $("user-profile-name").textContent = currentUserProfile.name || `Пользователь ${currentUserProfile.id}`;
  $("user-profile-link").textContent = `vk.ru/id${currentUserProfile.id}`;
  $("user-profile-link").dataset.userId = String(currentUserProfile.id);
  const avatar = $("user-profile-avatar");
  const fallback = $("user-profile-fallback");
  fallback.textContent = String(currentUserProfile.name || "VK").trim().slice(0, 1).toUpperCase() || "VK";
  if (currentUserProfile.photo) {
    avatar.hidden = false;
    fallback.hidden = true;
    avatar.src = currentUserProfile.photo;
    avatar.alt = currentUserProfile.name || "Аккаунт VK";
    avatar.onerror = () => { avatar.hidden = true; fallback.hidden = false; };
  } else {
    avatar.removeAttribute("src");
    avatar.hidden = true;
    fallback.hidden = false;
  }
  $("user-token-status").textContent = "Подключён";
  $("user-token-status").className = "server-status server-status--connected";
}

function showUserTokenEditor() {
  $("user-profile").hidden = true;
  $("user-token-form").hidden = false;
  $("cancel-user-token").hidden = !currentUserToken;
  $("user-token").value = "";
  $("user-token").placeholder = currentUserToken
    ? `Новый токен вместо ${maskToken(currentUserToken)}`
    : "Вставьте пользовательский access_token";
  $("user-token").focus();
}

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response?.ok) {
        reject(new Error(response?.error || "Неизвестная ошибка"));
      } else {
        resolve(response);
      }
    });
  });
}

async function readSettings() {
  return chrome.storage.local.get([
    "vk_token",
    "vkr_user_profile",
    "vkr_group_tokens",
    "vkr_server_url",
    "vkr_server_api_secret",
    "vkr_comment_delay_seconds",
  ]);
}

async function renderGroupTokens(tokens) {
  const list = $("group-token-list");
  const entries = Object.entries(tokens || {}).sort(
    ([first], [second]) => Number(first) - Number(second),
  );
  $("group-token-count").textContent = String(entries.length);
  list.replaceChildren();

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "status-line";
    empty.textContent = "Токены сообществ пока не добавлены.";
    list.appendChild(empty);
    return;
  }

  for (const [groupId, entryValue] of entries) {
    const entry =
      typeof entryValue === "string" ? { token: entryValue } : entryValue;
    const row = document.createElement("div");
    row.className = "token-row";

    const id = document.createElement("strong");
    id.textContent = `club${groupId}`;

    const name = document.createElement("div");
    name.className = "token-row__name";
    const label = document.createElement("strong");
    label.textContent = entry.label || `Сообщество ${groupId}`;
    const masked = document.createElement("span");
    masked.textContent = maskToken(entry.token);
    name.append(label, masked);

    const remove = document.createElement("button");
    remove.className = "btn btn--secondary btn--compact";
    remove.textContent = "Удалить";
    remove.addEventListener("click", async () => {
      const data = await chrome.storage.local.get("vkr_group_tokens");
      const updated = { ...(data.vkr_group_tokens || {}) };
      delete updated[groupId];
      await chrome.storage.local.set({ vkr_group_tokens: updated });
      await renderGroupTokens(updated);
      notify(`Токен club${groupId} удалён.`, "success");
    });

    const mode = document.createElement("button");
    mode.className = "btn btn--secondary btn--compact";
    mode.textContent =
      entry.publishAs === "user" ? "Пост: user" : "Пост: группа";
    mode.title =
      "Переключите на user, только если VK не разрешает этому токену сообщества выполнить wall.post. Фотографии всегда загружает локальный user token.";
    mode.addEventListener("click", async () => {
      const data = await chrome.storage.local.get("vkr_group_tokens");
      const updated = { ...(data.vkr_group_tokens || {}) };
      const current =
        typeof updated[groupId] === "string"
          ? { token: updated[groupId] }
          : { ...updated[groupId] };
      current.publishAs =
        current.publishAs === "user" ? "group" : "user";
      updated[groupId] = current;
      await chrome.storage.local.set({ vkr_group_tokens: updated });
      await renderGroupTokens(updated);
      notify(
        current.publishAs === "user"
          ? `club${groupId}: публикация локальным user token.`
          : `club${groupId}: публикация токеном сообщества.`,
        "info",
      );
    });

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;justify-content:flex-end";
    actions.append(mode, remove);
    row.append(id, name, actions);
    list.appendChild(row);
  }
}

async function refreshQueue() {
  try {
    const response = await runtimeMessage({ type: "get_queue_status" });
    const queue = response.queue || [];
    const active = queue.filter((job) =>
      ["queued", "processing", "paused"].includes(job.status),
    );
    if (response.pause) {
      $("queue-status").textContent = "Остановлена";
      $("queue-status").className =
        "server-status server-status--error";
      $("queue-message").textContent =
        response.pause.message ||
        "VK запросил проверку. Очередь остановлена.";
      $("resume-queue").hidden = false;
    } else {
      $("queue-status").textContent = active.length
        ? `В работе: ${active.length}`
        : "Пусто";
      $("queue-status").className = "server-status";
      $("queue-message").textContent = active.length
        ? "Публикации выполняются строго последовательно."
        : "Нет ожидающих публикаций.";
      $("resume-queue").hidden = true;
    }
  } catch (error) {
    $("queue-message").textContent = error.message;
  }
}

async function saveUserToken() {
  const token = $("user-token").value.trim();
  if (!token) {
    notify("Вставьте пользовательский токен.", "warning");
    return;
  }

  const button = $("save-user-token");
  button.disabled = true;
  try {
    const response = await runtimeMessage({
      type: "validate_local_user_token",
      token,
    });
    const user = response.user;
    const profile = {
      id: user.id,
      name: `${user.first_name} ${user.last_name}`,
      photo: user.photo_100 || user.photo_50 || "",
      screenName: user.screen_name || "",
      status: "active",
      localOnly: true,
    };
    await chrome.storage.local.set({
      vk_token: token,
      vkr_user_profile: profile,
    });
    await chrome.storage.local.remove([
      "vk_accounts",
      "vk_publisher_account_id",
    ]);
    renderUserAccount(profile, token);
    notify(`Аккаунт ${profile.name} подключён.`, "success");
  } catch (error) {
    notify(`Токен не сохранён: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function clearUserToken() {
  await chrome.storage.local.remove([
    "vk_token",
    "vk_accounts",
    "vk_publisher_account_id",
    "vkr_user_profile",
    "vkr_token_health",
  ]);
  renderUserAccount(null, "");
  notify("Аккаунт отключён от расширения.", "success");
}

async function saveGroupToken() {
  const groupId = Math.abs(Number($("group-id").value));
  const label = $("group-label").value.trim();
  const token = $("group-token").value.trim();
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    notify("Укажите числовой ID сообщества.", "warning");
    return;
  }
  if (token.length < 20) {
    notify("Токен сообщества выглядит слишком коротким.", "warning");
    return;
  }

  const data = await chrome.storage.local.get("vkr_group_tokens");
  const tokens = { ...(data.vkr_group_tokens || {}) };
  tokens[String(groupId)] = {
    token,
    label: label || `Сообщество ${groupId}`,
    publishAs: "group",
    savedAt: Date.now(),
  };
  await chrome.storage.local.set({ vkr_group_tokens: tokens });
  $("group-id").value = "";
  $("group-label").value = "";
  $("group-token").value = "";
  await renderGroupTokens(tokens);
  notify(`Токен club${groupId} сохранён локально.`, "success");
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function saveServer() {
  const url = $("server-url").value.trim().replace(/\/+$/, "");
  const secret = $("server-secret").value.trim();
  const delaySeconds = Math.max(15, Number($("comment-delay").value) || 60);

  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url)) {
    notify("Укажите корректный HTTPS URL сервера.", "warning");
    return;
  }
  if (secret.length < 32) {
    notify("API_SECRET должен быть не короче 32 символов.", "warning");
    return;
  }

  await chrome.storage.local.set({
    vkr_server_url: url,
    vkr_server_api_secret: secret,
    vkr_comment_delay_seconds: delaySeconds,
  });
  try {
    await runtimeMessage({ type: "check_server" });
    $("server-status").textContent = "Подключён";
    $("server-status").className =
      "server-status server-status--connected";
    notify("Сервер подключён и авторизация работает.", "success");
  } catch (error) {
    $("server-status").textContent = "Ошибка";
    $("server-status").className = "server-status server-status--error";
    notify(`Настройки сохранены, но проверка не прошла: ${error.message}`, "error");
  }
}

async function init() {
  const settings = await readSettings();
  const token = settings.vk_token || "";
  let profile = settings.vkr_user_profile || null;
  if (token && (!profile?.id || !profile?.photo)) {
    try {
      const response = await runtimeMessage({ type: "validate_local_user_token", token });
      const user = response.user;
      profile = {
        id: user.id,
        name: `${user.first_name} ${user.last_name}`,
        photo: user.photo_100 || user.photo_50 || "",
        screenName: user.screen_name || "",
        status: "active",
        localOnly: true,
      };
      await chrome.storage.local.set({ vkr_user_profile: profile });
    } catch {
      // Existing token stays untouched; the editor remains available to replace it.
    }
  }
  renderUserAccount(profile, token);

  $("server-url").value = settings.vkr_server_url || "";
  $("server-secret").value = settings.vkr_server_api_secret || "";
  $("comment-delay").value =
    settings.vkr_comment_delay_seconds || 60;
  await renderGroupTokens(settings.vkr_group_tokens || {});
  await refreshQueue();

  if (settings.vkr_server_url && settings.vkr_server_api_secret) {
    runtimeMessage({ type: "check_server" })
      .then(() => {
        $("server-status").textContent = "Подключён";
        $("server-status").className =
          "server-status server-status--connected";
      })
      .catch(() => {
        $("server-status").textContent = "Недоступен";
        $("server-status").className =
          "server-status server-status--error";
      });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof lottie !== "undefined") {
    try {
      lottie.loadAnimation({
        container: $("logo-lottie"),
        renderer: "svg",
        loop: true,
        autoplay: true,
        path: "VK REPOSTER LOGO.json",
      });
    } catch {
      // The logo is decorative.
    }
  }

  $("save-user-token").addEventListener("click", saveUserToken);
  $("clear-user-token").addEventListener("click", clearUserToken);
  $("replace-user-token").addEventListener("click", showUserTokenEditor);
  $("cancel-user-token").addEventListener("click", () => renderUserAccount(currentUserProfile, currentUserToken));
  $("user-profile-link").addEventListener("click", () => {
    const userId = Number($("user-profile-link").dataset.userId);
    if (Number.isSafeInteger(userId) && userId > 0) chrome.tabs.create({ url: `https://vk.ru/id${userId}` });
  });
  $("save-group-token").addEventListener("click", saveGroupToken);
  $("save-server").addEventListener("click", saveServer);
  $("generate-secret").addEventListener("click", () => {
    $("server-secret").value = randomSecret();
    $("server-secret").type = "text";
    notify("Секрет создан. Скопируйте его в API_SECRET на Render.", "info");
  });
  $("resume-queue").addEventListener("click", async () => {
    const response = await runtimeMessage({ type: "resume_publish_queue" });
    if (response.requiresDecision) {
      notify(response.message, "warning");
      chrome.tabs.create({ url: chrome.runtime.getURL("scheduled.html") });
    } else {
      notify("Очередь продолжена.", "success");
    }
    await refreshQueue();
  });
  $("open-scheduled").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("scheduled.html") });
  });
  $("open-clips").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("clips.html") });
  });
  $("open-stories").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("stories.html") });
  });
  $("open-vk").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://vk.ru/" });
  });

  void init();
});
