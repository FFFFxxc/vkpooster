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
    "vkr_user_groups",
    "vkr_server_url",
    "vkr_server_api_secret",
    "vkr_comment_delay_seconds",
    "vkr_comment_group_interval_seconds",
  ]);
}

function backupFileName(createdAt = new Date()) {
  const stamp = createdAt.toISOString().replace(/[:.]/g, "-");
  return `vk-reposter-backup-${stamp}.json`;
}

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function setBackupStatus(text, kind = "") {
  const status = $("backup-status");
  status.textContent = text;
  status.className = `server-status${kind ? ` server-status--${kind}` : ""}`;
}

async function exportBackup() {
  const button = $("export-backup");
  button.disabled = true;
  setBackupStatus("Создаю…");
  try {
    const storage = await chrome.storage.local.get(null);
    const backup = VkrBackupCore.createBackup(storage, {
      scope: $("backup-scope").value,
      includeSecrets: $("backup-include-secrets").checked,
      extensionVersion: chrome.runtime.getManifest().version,
    });
    downloadJson(backup, backupFileName(new Date(backup.createdAt)));
    const count = Object.keys(backup.data).length;
    setBackupStatus("Сохранено", "connected");
    $("backup-note").textContent = `Файл создан: ${count} разделов данных. На другом компьютере выберите его кнопкой «Импорт».`;
    notify("Резервная копия сохранена в загрузки.", "success");
  } catch (error) {
    setBackupStatus("Ошибка", "error");
    notify(`Экспорт не выполнен: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function importBackupFile(file) {
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) {
    throw new Error("Файл больше 50 МБ. Выберите корректную резервную копию.");
  }
  const parsed = JSON.parse(await file.text());
  const data = VkrBackupCore.prepareImport(parsed, {
    importSecrets: $("backup-include-secrets").checked,
  });
  const count = Object.keys(data).length;
  if (!confirm(`Восстановить ${count} разделов данных из резервной копии? Совпадающие настройки будут заменены.`)) {
    return;
  }
  await chrome.storage.local.set(data);
  setBackupStatus("Восстановлено", "connected");
  $("backup-note").textContent = `Импорт завершён: восстановлено ${count} разделов. Расширение перезапускается.`;
  notify("Данные восстановлены. Расширение перезапускается.", "success");
  setTimeout(() => chrome.runtime.reload(), 900);
}

async function handleBackupFileChange(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  setBackupStatus("Проверяю…");
  try {
    await importBackupFile(file);
  } catch (error) {
    setBackupStatus("Ошибка", "error");
    notify(`Импорт не выполнен: ${error.message}`, "error");
  }
}

function renderManagedGroups(groups) {
  const list = $("managed-group-list");
  const normalized = Array.isArray(groups) ? groups : [];
  $("managed-group-count").textContent = String(normalized.length);
  list.replaceChildren();
  if (!normalized.length) {
    const empty = document.createElement("div");
    empty.className = "status-line";
    empty.textContent = currentUserToken
      ? "Нажмите «Обновить список из VK»."
      : "Сначала подключите пользовательский токен.";
    list.appendChild(empty);
    return;
  }
  for (const group of normalized) {
    const row = document.createElement("div");
    row.className = "token-row";
    const avatar = document.createElement(group.photoUrl ? "img" : "strong");
    if (group.photoUrl) {
      avatar.className = "account-avatar";
      avatar.src = group.photoUrl;
      avatar.alt = "";
    } else {
      avatar.textContent = String(group.name || "VK").slice(0, 1).toUpperCase();
    }
    const name = document.createElement("div");
    name.className = "token-row__name";
    const title = document.createElement("strong");
    title.textContent = group.name || `Сообщество ${group.id}`;
    const id = document.createElement("span");
    id.textContent = `club${group.id}`;
    name.append(title, id);
    const ready = document.createElement("span");
    ready.className = "server-status server-status--connected";
    ready.textContent = "Готово";
    row.append(avatar, name, ready);
    list.appendChild(row);
  }
}

async function refreshManagedGroups({ quiet = false } = {}) {
  if (!currentUserToken) {
    renderManagedGroups([]);
    if (!quiet) notify("Сначала подключите пользовательский токен.", "warning");
    return [];
  }
  try {
    const response = await runtimeMessage({ type: "list_managed_communities", refresh: true });
    renderManagedGroups(response.groups || []);
    if (!quiet) notify(`Найдено сообществ: ${(response.groups || []).length}.`, "success");
    return response.groups || [];
  } catch (error) {
    if (!quiet) notify(`Список сообществ не обновлён: ${error.message}`, "error");
    throw error;
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
    await refreshManagedGroups({ quiet: true });
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
    "vkr_user_groups",
  ]);
  renderUserAccount(null, "");
  renderManagedGroups([]);
  notify("Аккаунт отключён от расширения.", "success");
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function persistCommentSettings() {
  await chrome.storage.local.set({
    vkr_comment_delay_seconds: Math.max(15, Number($("comment-delay").value) || 60),
    vkr_comment_group_interval_seconds: Math.max(
      15,
      Number($("comment-group-interval").value) || 30,
    ),
  });
}

async function saveServer() {
  const url = $("server-url").value.trim().replace(/\/+$/, "");
  const secret = $("server-secret").value.trim();
  const delaySeconds = Math.max(15, Number($("comment-delay").value) || 60);
  const groupIntervalSeconds = Math.max(15, Number($("comment-group-interval").value) || 30);

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
    vkr_comment_group_interval_seconds: groupIntervalSeconds,
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
  renderManagedGroups(settings.vkr_user_groups || []);

  $("server-url").value = settings.vkr_server_url || "";
  $("server-secret").value = settings.vkr_server_api_secret || "";
  $("comment-delay").value =
    settings.vkr_comment_delay_seconds || 60;
  $("comment-group-interval").value = settings.vkr_comment_group_interval_seconds || 30;
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
  $("refresh-managed-groups").addEventListener("click", () => void refreshManagedGroups());
  $("comment-delay").addEventListener("change", () => void persistCommentSettings());
  $("comment-group-interval").addEventListener("change", () => void persistCommentSettings());
  $("save-server").addEventListener("click", saveServer);
  $("export-backup").addEventListener("click", () => void exportBackup());
  $("import-backup").addEventListener("click", () => $("backup-file").click());
  $("backup-file").addEventListener("change", (event) => void handleBackupFileChange(event));
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
