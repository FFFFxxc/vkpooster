"use strict";

const fileRegistry = new Map();
const selectedGroups = new Set();
const sourceId = `source_${crypto.randomUUID()}`;
let allGroups = [];
let sourcePort = null;
let toastTimer = null;
let lockedFileIds = new Set();

const $ = (id) => document.getElementById(id);

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || "Неизвестная ошибка"));
      else resolve(response);
    });
  });
}

function toast(message, type = "info") {
  clearTimeout(toastTimer);
  const element = $("toast");
  element.textContent = message;
  element.className = `toast ${type}`;
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 4500);
}

function bytesLabel(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function formatScheduleTime(timestamp) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(timestamp)).replace(",", " ·");
}

function selectedFilesAreLocked() {
  return [...fileRegistry.keys()].some((id) => lockedFileIds.has(id));
}

function syncFileControls() {
  for (const button of document.querySelectorAll(".icon-button[data-file-id]")) {
    const locked = lockedFileIds.has(button.dataset.fileId);
    button.disabled = locked;
    button.title = locked ? "Файл используется текущей очередью" : "Убрать файл";
  }
  const clearButton = $("clear-files");
  clearButton.disabled = fileRegistry.size === 0 || selectedFilesAreLocked();
  clearButton.title = selectedFilesAreLocked()
    ? "Дождитесь завершения текущей очереди: видео ещё передаются в VK"
    : "Убрать все выбранные видео из формы";
}

function clearSelectedFiles() {
  if (selectedFilesAreLocked()) {
    toast("Эти видео ещё используются текущей очередью. Дождитесь её завершения, затем очистите список.", "error");
    return;
  }
  for (const entry of fileRegistry.values()) URL.revokeObjectURL(entry.url);
  fileRegistry.clear();
  $("file-input").value = "";
  renderFiles();
  updateReady();
}

function connectSource() {
  sourcePort = chrome.runtime.connect({ name: "vkr_clips_source" });
  sourcePort.postMessage({ type: "register_source", sourceId });
  sourcePort.onMessage.addListener((message) => {
    if (message.type === "read_chunk") void sendChunk(message);
  });
  sourcePort.onDisconnect.addListener(() => {
    sourcePort = null;
    setTimeout(connectSource, 750);
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function sendChunk(message) {
  const entry = fileRegistry.get(message.fileId);
  if (!entry || !sourcePort) {
    toast("Исходный видеофайл больше недоступен. Выберите его заново.", "error");
    return;
  }
  const offset = Math.max(0, Number(message.offset) || 0);
  const size = Math.min(128 * 1024, Math.max(1, Number(message.size) || 128 * 1024));
  const part = entry.file.slice(offset, Math.min(entry.file.size, offset + size));
  const buffer = await part.arrayBuffer();
  sourcePort.postMessage({
    type: "clip_chunk", jobId: message.jobId, offset, byteLength: buffer.byteLength,
    data: arrayBufferToBase64(buffer), done: offset + buffer.byteLength >= entry.file.size,
  });
}

function renderGroups() {
  const query = $("group-search").value.trim().toLowerCase();
  const container = $("groups");
  container.replaceChildren();
  const filtered = allGroups.filter((group) => !query || group.name.toLowerCase().includes(query) || String(group.id).includes(query));
  if (!filtered.length) {
    const empty = document.createElement("div"); empty.className = "empty";
    empty.textContent = allGroups.length ? "Ничего не найдено" : "Добавьте токен или локальный пользовательский токен в настройках расширения.";
    container.appendChild(empty);
  }
  for (const group of filtered) {
    const label = document.createElement("label");
    label.className = `group${selectedGroups.has(group.id) ? " selected" : ""}`;
    const avatar = document.createElement("span"); avatar.className = "group-avatar"; avatar.textContent = group.name.slice(0, 1).toUpperCase();
    const copy = document.createElement("span"); copy.className = "group-copy";
    const name = document.createElement("strong"); name.textContent = group.name;
    const id = document.createElement("span"); id.textContent = `club${group.id}`;
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = selectedGroups.has(group.id);
    check.onchange = () => {
      if (check.checked) selectedGroups.add(group.id); else selectedGroups.delete(group.id);
      chrome.storage.local.set({ vkr_clip_group_selection: [...selectedGroups] });
      renderGroups(); updateReady();
    };
    copy.append(name, id); label.append(avatar, copy, check); container.appendChild(label);
  }
  $("selected-count").textContent = String(selectedGroups.size);
}

function addFiles(fileList) {
  const allowed = new Set(["video/mp4", "video/webm", "video/quicktime"]);
  for (const file of fileList) {
    if (!allowed.has(file.type) || file.size <= 0 || file.size > 2 * 1024 * 1024 * 1024) {
      toast(`Файл «${file.name}» пропущен: нужен MP4, WebM или MOV до 2 ГБ.`, "error");
      continue;
    }
    const id = `file_${crypto.randomUUID()}`;
    fileRegistry.set(id, { file, url: URL.createObjectURL(file) });
  }
  renderFiles(); updateReady();
}

function renderFiles() {
  const container = $("files"); container.replaceChildren();
  for (const [id, entry] of fileRegistry) {
    const card = document.createElement("article"); card.className = "file-card";
    const video = document.createElement("video"); video.src = entry.url; video.muted = true; video.preload = "metadata";
    const copy = document.createElement("div"); copy.className = "file-copy";
    const name = document.createElement("strong"); name.textContent = entry.file.name; name.title = entry.file.name;
    const size = document.createElement("span"); size.textContent = bytesLabel(entry.file.size);
    const remove = document.createElement("button"); remove.className = "icon-button"; remove.dataset.fileId = id; remove.title = "Убрать файл"; remove.textContent = "×";
    remove.onclick = () => {
      if (lockedFileIds.has(id)) return toast("Этот файл ещё используется текущей очередью.", "error");
      URL.revokeObjectURL(entry.url); fileRegistry.delete(id); renderFiles(); updateReady();
    };
    copy.append(name, size); card.append(video, copy, remove); container.appendChild(card);
  }
  $("file-count").textContent = String(fileRegistry.size);
  syncFileControls();
}

function renderSchedulePreview() {
  const preview = $("schedule-preview");
  const container = $("schedule-list");
  container.replaceChildren();
  if (!fileRegistry.size) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;
  const publishValue = $("publish-at").value;
  const firstPublishAt = publishValue ? new Date(publishValue).getTime() : null;
  const intervalMinutes = Number($("interval-minutes").value);
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 10080) {
    $("schedule-caption").textContent = "Исправьте интервал";
    const error = document.createElement("div"); error.className = "job-error"; error.textContent = "Интервал должен быть целым числом от 0 до 10080 минут.";
    container.appendChild(error);
    return;
  }
  const timeline = VkrClipQueueCore.createClipTimeline({
    count: fileRegistry.size, publishAt: firstPublishAt, intervalMinutes, now: Date.now(),
  });
  $("schedule-caption").textContent = selectedGroups.size
    ? `Каждый клип выйдет в ${selectedGroups.size} ${selectedGroups.size === 1 ? "сообщество" : "сообществ(а)"}`
    : "Время одинаково для всех выбранных сообществ";
  [...fileRegistry.values()].forEach((entry, index) => {
    const row = document.createElement("div"); row.className = "schedule-row";
    const number = document.createElement("span"); number.className = "schedule-number"; number.textContent = String(index + 1);
    const name = document.createElement("span"); name.className = "schedule-file"; name.textContent = entry.file.name; name.title = entry.file.name;
    const time = document.createElement("time"); time.className = "schedule-time";
    if (firstPublishAt) {
      time.dateTime = new Date(timeline[index]).toISOString();
      time.textContent = formatScheduleTime(timeline[index]);
    } else if (index === 0) {
      time.textContent = "Сразу после запуска";
    } else if (intervalMinutes > 0) {
      time.textContent = `Через ${index * intervalMinutes} мин после запуска`;
    } else {
      time.textContent = "Сразу после предыдущего";
    }
    row.append(number, name, time); container.appendChild(row);
  });
}

function updateReady() {
  const total = fileRegistry.size * selectedGroups.size;
  const interval = Number($("interval-minutes").value);
  const validInterval = Number.isSafeInteger(interval) && interval >= 0 && interval <= 10080;
  const publishValue = $("publish-at").value;
  const publishAt = publishValue ? new Date(publishValue).getTime() : null;
  const validTime = !publishAt || publishAt > Date.now();
  $("start").disabled = total === 0 || !validInterval || !validTime;
  $("ready-summary").textContent = !validInterval
    ? "Исправьте интервал между видео"
    : !validTime
      ? "Время первого клипа уже прошло"
      : total
    ? `${fileRegistry.size} видео × ${selectedGroups.size} сообществ = ${total} публикаций${fileRegistry.size > 1 && interval ? ` · интервал ${interval} мин` : ""}`
    : "Выберите видео и сообщества";
  renderSchedulePreview();
  syncFileControls();
}

function statusLabel(status) {
  return ({ queued:"Ожидает", opening_tab:"Открываю VK", transferring:"Передаю файл", uploading:"Загрузка VK", completed:"Готово", paused:"Остановлено", failed:"Ошибка", cancelled:"Отменено" })[status] || status;
}

function renderJobs(container, jobs, interactive) {
  container.replaceChildren();
  if (!jobs.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "Здесь пока пусто"; container.appendChild(empty); return; }
  for (const job of jobs) {
    const card = document.createElement("article"); card.className = "job";
    const head = document.createElement("div"); head.className = "job-head";
    const title = document.createElement("span"); title.className = "job-title"; title.textContent = job.fileName || "Клип"; title.title = job.fileName || "Клип";
    const status = document.createElement("span"); status.className = `status ${job.status}`; status.textContent = statusLabel(job.status);
    const sub = document.createElement("div"); sub.className = "job-sub"; sub.textContent = `${job.groupName || `club${job.groupId}`} · ${job.publishAt ? new Date(job.publishAt).toLocaleString("ru-RU") : "сразу"}`;
    head.append(title, status); card.append(head, sub);
    if (job.error) { const error = document.createElement("div"); error.className = "job-error"; error.textContent = job.error; card.appendChild(error); }
    if (["opening_tab","transferring","uploading"].includes(job.status)) { const progress = document.createElement("div"); progress.className = "progress"; const bar = document.createElement("span"); bar.style.width = `${job.progress || 0}%`; progress.appendChild(bar); card.appendChild(progress); }
    if (interactive && ["queued","opening_tab","transferring","uploading","paused"].includes(job.status)) {
      const actions = document.createElement("div"); actions.className = "job-actions";
      if (job.status === "paused") { const resume = document.createElement("button"); resume.textContent = "Продолжить"; resume.onclick = async () => { try { await runtimeMessage({ type:"clips_resume", jobId:job.id }); await refreshQueue(); } catch(error) { toast(error.message,"error"); } }; actions.appendChild(resume); }
      const cancel = document.createElement("button"); cancel.textContent = "Отменить"; cancel.onclick = async () => { if (!confirm("Отменить это задание?")) return; try { await runtimeMessage({ type:"clips_cancel", jobId:job.id }); await refreshQueue(); } catch(error) { toast(error.message,"error"); } }; actions.appendChild(cancel); card.appendChild(actions);
    }
    container.appendChild(card);
  }
}

async function refreshQueue() {
  try {
    const response = await runtimeMessage({ type: "clips_list" });
    const queue = (response.queue || []).filter((job) => !["completed","failed","cancelled"].includes(job.status));
    lockedFileIds = new Set(queue.map((job) => job.fileId).filter(Boolean));
    const history = response.history || [];
    $("queue-count").textContent = String(queue.length); $("history-count").textContent = String(history.length);
    $("clear-history").disabled = history.length === 0;
    renderJobs($("queue-list"), queue, true); renderJobs($("history-list"), history, false);
    syncFileControls();
  } catch (error) { /* service worker can restart between polling ticks */ }
}

async function clearHistory() {
  if (!confirm("Очистить все последние результаты загрузки клипов?")) return;
  try {
    await runtimeMessage({ type: "clips_clear_history" });
    await refreshQueue();
    toast("Последние результаты очищены.");
  } catch (error) { toast(error.message, "error"); }
}

async function startQueue() {
  const publishValue = $("publish-at").value;
  const publishAt = publishValue ? new Date(publishValue).getTime() : null;
  const intervalMinutes = Number($("interval-minutes").value);
  if (publishAt && publishAt <= Date.now()) return toast("Укажите будущее время публикации.", "error");
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 10080) return toast("Интервал должен быть целым числом от 0 до 10080 минут.", "error");
  const files = [...fileRegistry].map(([id, entry]) => ({ id, name: entry.file.name, size: entry.file.size, type: entry.file.type }));
  const groups = allGroups.filter((group) => selectedGroups.has(group.id));
  $("start").disabled = true;
  try {
    const response = await runtimeMessage({ type:"clips_start", sourceId, files, groups, defaults:{ description:$("description").value, wallPost:$("wall-post").checked, publishAt, intervalMinutes } });
    for (const job of response.jobs || []) if (job.fileId) lockedFileIds.add(job.fileId);
    syncFileControls();
    toast(`В очередь добавлено ${response.queued} публикаций.`);
    await refreshQueue();
    $("queue-tab").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { toast(error.message, "error"); }
  finally { updateReady(); }
}

async function init() {
  connectSource();
  try {
    const [groupsResponse, settings] = await Promise.all([runtimeMessage({ type:"list_clip_groups" }), chrome.storage.local.get("vkr_clip_group_selection")]);
    allGroups = groupsResponse.groups || [];
    const allowed = new Set(allGroups.map((group) => group.id));
    for (const id of settings.vkr_clip_group_selection || []) if (allowed.has(Number(id))) selectedGroups.add(Number(id));
    renderGroups(); updateReady();
  } catch (error) { toast(error.message, "error"); }
  $("group-search").oninput = renderGroups;
  $("select-all").onclick = () => { for (const group of allGroups) selectedGroups.add(group.id); renderGroups(); updateReady(); };
  $("clear-groups").onclick = () => { selectedGroups.clear(); renderGroups(); updateReady(); };
  $("file-input").onchange = (event) => { addFiles(event.target.files); event.target.value = ""; };
  $("clear-files").onclick = clearSelectedFiles;
  $("interval-minutes").oninput = updateReady;
  $("publish-at").oninput = updateReady;
  const dropzone = $("dropzone");
  dropzone.ondragover = (event) => { event.preventDefault(); dropzone.classList.add("drag"); };
  dropzone.ondragleave = () => dropzone.classList.remove("drag");
  dropzone.ondrop = (event) => { event.preventDefault(); dropzone.classList.remove("drag"); addFiles(event.dataTransfer.files); };
  $("start").onclick = startQueue;
  $("clear-history").onclick = clearHistory;
  $("open-scheduled").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("scheduled.html") });
  await refreshQueue(); setInterval(refreshQueue, 1500);
}

window.addEventListener("beforeunload", () => { for (const entry of fileRegistry.values()) URL.revokeObjectURL(entry.url); });
document.addEventListener("DOMContentLoaded", init);
