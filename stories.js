"use strict";

const $ = (id) => document.getElementById(id);
let selectedFile = null;
let selectedFileNonce = "";
let previewDataUrl = "";
let groupEntries = [];
let userToken = "";
let toastTimer = null;

function toast(message, type = "info") {
  clearTimeout(toastTimer); const box = $("toast"); box.textContent = message; box.className = `toast ${type}`; box.hidden = false;
  toastTimer = setTimeout(() => { box.hidden = true; }, 5000);
}

function defaultSchedule() {
  const date = new Date(Date.now() + 10 * 60_000); date.setSeconds(0, 0);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

async function makePreview(file) {
  const url = URL.createObjectURL(file);
  try {
    let source;
    if (file.type.startsWith("image/")) {
      source = new Image(); source.src = url; await source.decode();
    } else {
      source = document.createElement("video"); source.src = url; source.muted = true; source.preload = "metadata";
      await new Promise((resolve, reject) => { source.onloadeddata = resolve; source.onerror = reject; });
      try { source.currentTime = Math.min(0.2, source.duration || 0); } catch { /* first frame is enough */ }
    }
    const width = 240; const height = 426; const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); context.fillStyle = "#080812"; context.fillRect(0, 0, width, height);
    const sourceWidth = source.videoWidth || source.naturalWidth; const sourceHeight = source.videoHeight || source.naturalHeight;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    context.drawImage(source, (width - sourceWidth * scale) / 2, (height - sourceHeight * scale) / 2, sourceWidth * scale, sourceHeight * scale);
    return canvas.toDataURL("image/jpeg", .55);
  } finally { URL.revokeObjectURL(url); }
}

function updateReady() { $("schedule").disabled = !selectedFile || !userToken || !$("group").value || !$("publish-at").value; }

async function chooseFile(file) {
  const allowed = new Set(["image/jpeg","image/png","video/mp4","video/webm","video/quicktime"]);
  if (!file || !allowed.has(file.type) || file.size <= 0 || file.size > 25 * 1024 * 1024) return toast("Поддерживаются JPG, PNG, MP4, WebM и MOV до 25 МБ.", "error");
  selectedFile = file;
  selectedFileNonce = crypto.randomUUID();
  try { previewDataUrl = await makePreview(file); }
  catch { previewDataUrl = ""; }
  const preview = $("preview");
  if (previewDataUrl) { preview.src = previewDataUrl; preview.style.display = "block"; $("file-label").style.display = "none"; }
  else { preview.style.display = "none"; $("file-label").textContent = file.name; }
  updateReady();
}

function statusName(status) {
  return ({ uploading:"Принимаю файл",queued:"Запланировано",processing:"Публикуется",completed:"Опубликовано",failed:"Ошибка",paused:"Остановлено",cancelled:"Отменено" })[status] || status;
}

function renderJobs(jobs) {
  const root = $("jobs"); root.replaceChildren();
  if (!jobs.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "Историй в очереди пока нет"; root.appendChild(empty); return; }
  for (const job of jobs) {
    const card = document.createElement("article"); card.className = "job";
    const image = document.createElement("img"); if (job.previewDataUrl) image.src = job.previewDataUrl; image.alt = "";
    const body = document.createElement("div"); const title = document.createElement("h3"); title.textContent = job.groupName || `club${job.groupId}`;
    const date = document.createElement("p"); date.textContent = new Date(job.publishAt).toLocaleString("ru-RU");
    const pill = document.createElement("span"); pill.className = "pill"; pill.textContent = statusName(job.status);
    body.append(title, date, pill);
    if (job.lastError) { const error = document.createElement("p"); error.className = "error"; error.textContent = job.lastError; body.appendChild(error); }
    if (["uploading","queued","failed","paused"].includes(job.status)) {
      const actions = document.createElement("div"); actions.className = "job-actions";
      if (["failed","paused"].includes(job.status)) { const retry = document.createElement("button"); retry.textContent = "Повторить"; retry.onclick = async () => { try { await VkrServerClient.request(`/scheduled-stories/${encodeURIComponent(job.id)}/retry`, { method:"POST" }); await loadJobs(); } catch(error) { toast(error.message,"error"); } }; actions.appendChild(retry); }
      const cancel = document.createElement("button"); cancel.textContent = "Отменить"; cancel.onclick = async () => { if (!confirm("Отменить эту историю и удалить её файл?")) return; try { await VkrServerClient.request(`/scheduled-stories/${encodeURIComponent(job.id)}`, { method:"DELETE" }); await loadJobs(); } catch(error) { toast(error.message,"error"); } }; actions.appendChild(cancel); body.appendChild(actions);
    }
    card.append(image, body); root.appendChild(card);
  }
}

async function loadJobs() {
  try { const response = await VkrServerClient.request("/scheduled-stories?limit=100"); renderJobs(response.jobs || []); }
  catch (error) { renderJobs([]); toast(error.message, "error"); }
}

async function scheduleStory() {
  const group = groupEntries.find((entry) => String(entry.id) === $("group").value);
  const publishAt = new Date($("publish-at").value);
  const linkUrl = $("link-url").value.trim();
  const linkText = $("link-text").value;
  if (!group || !selectedFile) return;
  if (publishAt.getTime() < Date.now() + 60_000) return toast("Время должно быть минимум на минуту позже текущего.", "error");
  if (linkUrl && !linkText) return toast("Для ссылки выберите текст кнопки.", "error");
  const button = $("schedule"); button.disabled = true; const progress = $("progress"); progress.hidden = false;
  try {
    const fingerprintInput = `${group.id}:${publishAt.toISOString()}:${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}:${selectedFileNonce}`;
    const fingerprintBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintInput));
    const fingerprint = [...new Uint8Array(fingerprintBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
    progress.querySelector("span").style.width = "20%"; progress.querySelector("b").textContent = "Создаю защищённое задание…";
    const draft = await VkrServerClient.request("/scheduled-stories", { method:"POST", json:{
      idempotencyKey:`story_${group.id}:${fingerprint}`, groupId:group.id, groupName:group.name,
      publishAt:publishAt.toISOString(), userToken: userToken, linkUrl, linkText, previewDataUrl,
    } });
    progress.querySelector("span").style.width = "55%"; progress.querySelector("b").textContent = "Загружаю файл на ваш сервер…";
    if (draft.job.status === "uploading") {
      try {
        await VkrServerClient.request(`/scheduled-stories/${encodeURIComponent(draft.job.id)}/media`, { method:"PUT", raw:selectedFile, contentType:selectedFile.type, fileName:selectedFile.name });
      } catch (error) {
        const current = await VkrServerClient.request("/scheduled-stories?limit=200").catch(() => ({ jobs: [] }));
        const recovered = (current.jobs || []).find((job) => job.id === draft.job.id && job.status !== "uploading");
        if (!recovered) {
          await VkrServerClient.request(`/scheduled-stories/${encodeURIComponent(draft.job.id)}`, { method:"DELETE" }).catch(() => {});
          throw error;
        }
      }
    }
    progress.querySelector("span").style.width = "100%"; progress.querySelector("b").textContent = "История запланирована";
    toast("История добавлена в отложку."); selectedFile = null; selectedFileNonce = ""; previewDataUrl = ""; $("file").value = ""; $("preview").style.display = "none"; $("file-label").style.display = "block"; $("file-label").innerHTML = "Выберите фото или видео<br><small>Лучший формат — 9:16</small>";
    await loadJobs(); setTimeout(() => { progress.hidden = true; }, 1400);
  } catch (error) { progress.hidden = true; toast(error.message, "error"); }
  finally { updateReady(); }
}

async function init() {
  $("publish-at").value = defaultSchedule();
  const data = await chrome.storage.local.get(["vk_token", "vkr_user_groups"]);
  userToken = String(data.vk_token || "").trim();
  groupEntries = (Array.isArray(data.vkr_user_groups) ? data.vkr_user_groups : []).map((group) => ({ id:Number(group.id), name:String(group.name || `Сообщество ${group.id}`) })).filter((entry) => Number.isSafeInteger(entry.id) && entry.id > 0);
  $("group").replaceChildren();
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = !userToken ? "Подключите пользовательский токен" : groupEntries.length ? "Выберите сообщество" : "Обновите сообщества в настройках"; $("group").appendChild(placeholder);
  for (const group of groupEntries) { const option = document.createElement("option"); option.value = String(group.id); option.textContent = `${group.name} · club${group.id}`; $("group").appendChild(option); }
  $("file").onchange = (event) => void chooseFile(event.target.files[0]); $("group").onchange = updateReady; $("publish-at").onchange = updateReady; $("schedule").onclick = scheduleStory; $("refresh").onclick = loadJobs;
  $("open-scheduled").onclick = () => chrome.tabs.create({ url:chrome.runtime.getURL("scheduled.html") }); $("open-clips").onclick = () => chrome.tabs.create({ url:chrome.runtime.getURL("clips.html") });
  updateReady(); await loadJobs(); setInterval(loadJobs, 15_000);
}

document.addEventListener("DOMContentLoaded", () => void init());
