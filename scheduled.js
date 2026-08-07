"use strict";

const $ = (id) => document.getElementById(id);
let selectedWaitingId = null;

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

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(status) {
  return {
    queued: "В очереди",
    processing: "Публикуется",
    paused: "Пауза",
    done: "Готово",
    completed: "Готово",
    failed: "Ошибка",
    cancelled: "Отменено",
  }[status] || status;
}

function empty(text) {
  const node = document.createElement("div");
  node.className = "safe-empty";
  node.textContent = text;
  return node;
}

function button(text, className = "btn btn--secondary btn--small") {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  return node;
}

function firstPhotoUrl(post) {
  const photo = (post?.attachments || []).find(
    (attachment) => attachment.type === "photo" && attachment.photo,
  )?.photo;
  if (!photo?.sizes?.length) return "";
  return [...photo.sizes].sort(
    (first, second) =>
      Number(second.width || 0) * Number(second.height || 0) -
      Number(first.width || 0) * Number(first.height || 0),
  )[0]?.url;
}

async function renderWaiting() {
  const data = await chrome.storage.local.get("vkr_waiting_posts");
  const items = Array.isArray(data.vkr_waiting_posts)
    ? data.vkr_waiting_posts
    : [];
  $("waiting-count").textContent = String(items.length);
  const list = $("waiting-list");
  list.replaceChildren();
  if (!items.length) {
    list.appendChild(
      empty("Добавляйте посты из VK кнопкой «⏳ В ожидания»."),
    );
    return;
  }

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "safe-card";
    const imageUrl = firstPhotoUrl(item.post);
    if (imageUrl) {
      const image = document.createElement("img");
      image.className = "safe-card__image";
      image.src = imageUrl;
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      card.appendChild(image);
    }

    const text = document.createElement("div");
    text.className = "safe-card__text";
    text.textContent = item.post?.text || "Пост без текста";
    card.appendChild(text);

    const meta = document.createElement("div");
    meta.className = "safe-card__meta";
    meta.textContent = `Добавлен ${formatDate(item.addedAt)} · wall${item.post?.owner_id}_${item.post?.id}`;
    card.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "safe-actions";
    const publish = button("Опубликовать", "btn btn--primary btn--small");
    publish.addEventListener("click", () => openPublishDialog(item));
    const source = button("Открыть источник");
    source.addEventListener("click", () =>
      chrome.tabs.create({ url: item.url }),
    );
    const remove = button("Удалить", "btn btn--danger btn--small");
    remove.addEventListener("click", async () => {
      const current = await chrome.storage.local.get("vkr_waiting_posts");
      await chrome.storage.local.set({
        vkr_waiting_posts: (current.vkr_waiting_posts || []).filter(
          (candidate) => candidate.id !== item.id,
        ),
      });
      await renderWaiting();
    });
    actions.append(publish, source, remove);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

async function renderQueue() {
  const response = await runtimeMessage({ type: "get_queue_status" });
  const queue = Array.isArray(response.queue) ? response.queue : [];
  $("queue-count").textContent = String(queue.length);
  $("pause-alert").hidden = !response.pause;
  if (response.pause) {
    $("pause-message").textContent = ` ${response.pause.message || ""}`;
  }

  const list = $("queue-list");
  list.replaceChildren();
  if (!queue.length) {
    list.appendChild(empty("Очередь пуста."));
    return;
  }

  for (const job of [...queue].reverse()) {
    const card = document.createElement("article");
    card.className = "safe-card";
    const head = document.createElement("div");
    head.className = "safe-panel__head";
    const title = document.createElement("strong");
    title.textContent = job.label || `Пост #${job.post?.id || "?"}`;
    const status = document.createElement("span");
    status.className = `safe-status safe-status--${job.status}`;
    status.textContent = statusLabel(job.status);
    head.append(title, status);
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "safe-card__meta";
    const progress = job.progress || {};
    meta.textContent =
      `${formatDate(job.createdAt)} · групп ${job.groups?.length || 0} · ` +
      `успешно ${progress.ok || 0}, ошибок ${progress.fail || 0}`;
    card.appendChild(meta);

    if (job.error) {
      const error = document.createElement("div");
      error.className = "safe-card__text";
      error.style.color = "#fca5a5";
      error.textContent = job.error;
      card.appendChild(error);
    }

    const warnings = (job.results || [])
      .map((result) => result.warning)
      .filter(Boolean);
    if (warnings.length) {
      const warning = document.createElement("div");
      warning.className = "safe-card__meta";
      warning.style.color = "#fbbf24";
      warning.textContent = [...new Set(warnings)].join(" ");
      card.appendChild(warning);
    }
    if (
      job.status === "paused" &&
      job.pauseReason === "ambiguous_repost"
    ) {
      const actions = document.createElement("div");
      actions.className = "safe-actions";
      const skip = button(
        "Уже опубликован — не повторять",
        "btn btn--primary btn--small",
      );
      skip.addEventListener("click", async () => {
        await runtimeMessage({
          type: "resolve_ambiguous_repost",
          jobId: job.id,
          action: "skip",
        });
        await renderQueue();
      });
      const retry = button("Публикации нет — повторить");
      retry.addEventListener("click", async () => {
        if (
          !confirm(
            "Вы проверили стену и уверены, что репоста там нет? Повторить запрос?",
          )
        ) {
          return;
        }
        await runtimeMessage({
          type: "resolve_ambiguous_repost",
          jobId: job.id,
          action: "retry",
        });
        await renderQueue();
      });
      const cancel = button("Отменить задание", "btn btn--danger btn--small");
      cancel.addEventListener("click", async () => {
        if (!confirm("Отменить это задание и перейти к следующему?")) return;
        await runtimeMessage({
          type: "resolve_ambiguous_repost",
          jobId: job.id,
          action: "cancel",
        });
        await renderQueue();
      });
      actions.append(skip, retry, cancel);
      card.appendChild(actions);
    }
    list.appendChild(card);
  }
}

async function renderComments() {
  const list = $("comments-list");
  list.replaceChildren();
  try {
    const response = await runtimeMessage({ type: "list_scheduled_comments" });
    const jobs = response.jobs || [];
    $("comments-count").textContent = String(jobs.length);
    if (!jobs.length) {
      list.appendChild(empty("На сервере нет заданий комментариев."));
      return;
    }
    for (const job of jobs) {
      const card = document.createElement("article");
      card.className = "safe-card";
      const head = document.createElement("div");
      head.className = "safe-panel__head";
      const title = document.createElement("strong");
      title.textContent = `club${job.groupId} · post ${job.postId}`;
      const status = document.createElement("span");
      status.className = `safe-status safe-status--${job.status}`;
      status.textContent = statusLabel(job.status);
      head.append(title, status);
      const text = document.createElement("div");
      text.className = "safe-card__text";
      text.textContent = job.commentText;
      const meta = document.createElement("div");
      meta.className = "safe-card__meta";
      meta.textContent = `Выполнить: ${formatDate(job.commentAt)}`;
      card.append(head, text, meta);
      list.appendChild(card);
    }
  } catch (error) {
    $("comments-count").textContent = "—";
    list.appendChild(
      empty(
        error.message.includes("URL сервера")
          ? "Сервер комментариев не настроен."
          : `Сервер недоступен: ${error.message}`,
      ),
    );
  }
}

async function openPublishDialog(item) {
  selectedWaitingId = item.id;
  $("publish-text").value = item.post?.text || "";
  $("publish-comment").value = "";
  $("publish-date").value = "";
  $("publish-mode").value = "copy";

  const data = await chrome.storage.local.get("vkr_group_tokens");
  const tokens = data.vkr_group_tokens || {};
  const groups = $("publish-groups");
  groups.replaceChildren();
  const entries = Object.entries(tokens);
  if (!entries.length) {
    groups.appendChild(
      empty("Сначала добавьте токены сообществ в настройках расширения."),
    );
  } else {
    for (const [groupId, rawEntry] of entries) {
      const entry =
        typeof rawEntry === "string" ? {} : rawEntry || {};
      const label = document.createElement("label");
      label.className = "safe-check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "publish-group";
      checkbox.value = groupId;
      const name = document.createElement("span");
      name.textContent = entry.label || `club${groupId}`;
      label.append(checkbox, name);
      groups.appendChild(label);
    }
  }
  $("publish-dialog").showModal();
}

async function submitPublish(event) {
  event.preventDefault();
  const groups = Array.from(
    document.querySelectorAll('input[name="publish-group"]:checked'),
    (checkbox) => Number(checkbox.value),
  );
  if (!groups.length) {
    alert("Выберите хотя бы одно сообщество.");
    return;
  }

  const data = await chrome.storage.local.get([
    "vkr_waiting_posts",
    "vk_token",
  ]);
  const item = (data.vkr_waiting_posts || []).find(
    (candidate) => candidate.id === selectedWaitingId,
  );
  if (!item) {
    alert("Пост больше не найден в ожиданиях.");
    return;
  }

  const mode = $("publish-mode").value;
  if (mode === "repost" && !data.vk_token) {
    alert("Для оригинального репоста нужен локальный пользовательский токен.");
    return;
  }
  const dateValue = $("publish-date").value;
  const pubDate = dateValue ? new Date(dateValue).getTime() : null;
  if (pubDate && pubDate <= Date.now()) {
    alert("Дата публикации должна быть в будущем.");
    return;
  }

  const submit = $("publish-submit");
  submit.disabled = true;
  try {
    const response = await runtimeMessage({
      type: "enqueue_publish",
      post: item.post,
      groups,
      mode,
      text: mode === "copy" ? $("publish-text").value : "",
      pubDate,
      processedPhotos: [],
      autoCommentText: $("publish-comment").value.trim(),
      label: `Пост из ожиданий #${item.post?.id || "?"}`,
    });
    if (!response.queued) throw new Error("Сервер очереди не принял задание.");

    await chrome.storage.local.set({
      vkr_waiting_posts: (data.vkr_waiting_posts || []).filter(
        (candidate) => candidate.id !== selectedWaitingId,
      ),
    });
    $("publish-dialog").close();
    await refreshAll();
  } catch (error) {
    alert(`Не удалось поставить пост в очередь: ${error.message}`);
  } finally {
    submit.disabled = false;
  }
}

async function clearFinished() {
  await runtimeMessage({ type: "clear_finished_queue" });
  await renderQueue();
}

async function refreshAll() {
  await Promise.all([renderWaiting(), renderQueue(), renderComments()]);
}

document.addEventListener("DOMContentLoaded", () => {
  $("refresh-btn").addEventListener("click", refreshAll);
  $("settings-btn").addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }),
  );
  $("close-dialog").addEventListener("click", () =>
    $("publish-dialog").close(),
  );
  $("publish-form").addEventListener("submit", submitPublish);
  $("clear-finished").addEventListener("click", clearFinished);
  $("resume-btn").addEventListener("click", async () => {
    const response = await runtimeMessage({ type: "resume_publish_queue" });
    if (response.requiresDecision) {
      alert(response.message);
    }
    await renderQueue();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      (changes.vkr_publish_queue ||
        changes.vkr_waiting_posts ||
        changes.vkr_queue_pause)
    ) {
      void refreshAll();
    }
  });
  void refreshAll();
});
