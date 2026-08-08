"use strict";

(() => {
  if (window.top !== window || window.__vkrSafeClipUploader) return;
  const jobId = new URLSearchParams(location.hash.replace(/^#/, "")).get("vkr_clip_job");
  if (!jobId) return;
  window.__vkrSafeClipUploader = true;

  let port = null;
  const chunks = [];
  let receivedBytes = 0;
  let metadata = null;
  let terminalSent = false;

  function report(type, extra = {}) {
    if (terminalSent && type !== "clip_terminal") return;
    if (!port) return;
    try { port.postMessage({ type, jobId, ...extra }); } catch { return; }
    if (type === "clip_terminal") terminalSent = true;
  }

  function showStatus(text, tone = "working") {
    let panel = document.getElementById("vkr-safe-clip-status");
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = "vkr-safe-clip-status";
      panel.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;width:min(380px,calc(100vw - 36px));padding:14px 16px;border-radius:14px;background:rgba(17,15,34,.95);border:1px solid rgba(139,92,246,.5);box-shadow:0 18px 55px rgba(0,0,0,.45);color:#fff;font:13px/1.45 system-ui,sans-serif;white-space:pre-wrap;";
      document.documentElement.appendChild(panel);
    }
    panel.textContent = `VK Reposter Pro · клип\n${text}`;
    panel.style.borderColor = tone === "error" ? "rgba(251,113,133,.7)" : tone === "done" ? "rgba(52,211,153,.65)" : "rgba(139,92,246,.5)";
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function protectiveReason() {
    const text = String(document.body?.innerText || "").toLowerCase();
    if (location.href.includes("login") || document.querySelector('input[name="email"],#login_form')) return "В этой вкладке VK требуется вход в аккаунт.";
    if (document.querySelector('input[name="captcha_key"],.Captcha,[data-testid*="captcha"]') || text.includes("введите код с картинки") || text.includes("captcha")) return "VK показал CAPTCHA. Пройдите её вручную и затем возобновите очередь со страницы клипов.";
    if (text.includes("подозрительная активность") || text.includes("подтвердите, что вы") || text.includes("проверка безопасности") || text.includes("страница была взломана")) return "VK запросил проверку безопасности. Выполните её вручную, затем возобновите задание.";
    if (text.includes("клипы недоступны") || text.includes("раздел клипов отключен") || text.includes("доступ ограничен") || text.includes("ошибка доступа")) return "Раздел клипов недоступен этому аккаунту или сообществу.";
    return "";
  }

  function isVisible(element) {
    if (!element || !element.isConnected || element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function cleanName(value) {
    return String(value || "").toLowerCase().replace(/[^a-zа-яё0-9]/gi, "");
  }

  function findVideoFileInput() {
    return [...document.querySelectorAll('input[type="file"]')].find((input) => {
      const accept = String(input.getAttribute("accept") || "").toLowerCase();
      return !accept || accept.includes("video") || !accept.includes("image");
    }) || null;
  }

  function assertCommunityRoute(options) {
    if (/^\/clips\/upload-?\d+/i.test(location.pathname)) return;
    const expected = String(options.screenName || `club${options.groupId}`).toLowerCase();
    const fallback = `club${Math.abs(Number(options.groupId))}`.toLowerCase();
    const match = location.pathname.match(/^\/clips\/([^/]+)/i);
    const actual = match ? decodeURIComponent(match[1]).toLowerCase() : "";
    if (!actual || ![expected, fallback].includes(actual)) {
      throw new Error(`VK открыл не страницу целевого сообщества, а «${location.pathname}». Ничего не опубликовано; вкладка оставлена открытой.`);
    }
  }

  async function waitFor(find, timeoutMs, description) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const protection = protectiveReason();
      if (protection) throw new Error(protection);
      const value = find();
      if (value) return value;
      await delay(400);
    }
    throw new Error(`VK изменил форму: не найден элемент «${description}». Вкладка оставлена открытой.`);
  }

  function decodeChunk(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function findUploadEntryButton() {
    const exact = document.querySelector('[data-testid="clips-publish-button"]');
    if (isVisible(exact)) return exact;
    for (const button of document.querySelectorAll("button,[role=button]")) {
      if (!isVisible(button)) continue;
      const text = String(button.textContent || "").trim().toLowerCase();
      if (["опубликовать", "создать клип", "добавить клип", "загрузить клип"].some((label) => text === label || text.includes(label))) return button;
    }
    return null;
  }

  async function waitForCommunityFileInput(options) {
    const started = Date.now();
    let contextChosen = false;
    while (Date.now() - started < 30_000) {
      const protection = protectiveReason();
      if (protection) throw new Error(protection);
      const input = findVideoFileInput();
      if (input) return input;
      if (!contextChosen) {
        const community = [...document.querySelectorAll('button,[role="button"]')].find((button) => {
          if (!isVisible(button)) return false;
          const text = String(button.textContent || "").trim().toLowerCase();
          return text === "сообщество" || text.includes("от имени сообщества") || text.includes("продолжить как сообщество");
        });
        if (community) {
          community.click();
          contextChosen = true;
        }
      }
      await delay(400);
    }
    throw new Error(`Не появилась форма выбора видео для «${options.groupName || `club${options.groupId}`}». Вкладка оставлена открытой.`);
  }

  function findAuthorSelector() {
    const selectors = [
      '[data-testid="clips-upload-author"]',
      '[data-testid="clips-upload-author-selector"]',
      '[data-testid="clips-upload-owner-selector"]',
      '[data-testid="author-selector"]',
      '[data-testid="owner-selector"]',
    ];
    return selectors.map((selector) => document.querySelector(selector)).find(isVisible) || null;
  }

  async function ensureCommunityAuthor(options) {
    const groupId = Math.abs(Number(options.groupId));
    const expectedOwnerId = -groupId;
    const ownerMatch = location.pathname.match(/^\/clips\/upload(-?\d+)/i);
    if (ownerMatch) {
      const ownerId = Number(ownerMatch[1]);
      if (ownerId !== expectedOwnerId) {
        throw new Error(`VK создал черновик от владельца ${ownerId}, ожидалось сообщество ${expectedOwnerId}. Публикация остановлена.`);
      }
      return;
    }

    const selector = findAuthorSelector();
    if (!selector) {
      throw new Error(`Не удалось подтвердить автора клипа «${options.groupName || `club${groupId}`}». Публикация остановлена до ручной проверки.`);
    }
    const target = cleanName(options.groupName);
    const current = cleanName(selector.textContent);
    if (target && (current === target || current.includes(target))) return;

    selector.click();
    const choices = await waitFor(() => {
      const items = [...document.querySelectorAll('[data-testid="clips-upload-modal-option-owner"]')].filter(isVisible);
      return items.length ? items : null;
    }, 10_000, "список авторов клипа");
    const screenName = String(options.screenName || "").toLowerCase();
    const club = `club${groupId}`;
    const choice = choices.find((item) => {
      const text = cleanName(item.textContent);
      const attrs = [...item.attributes].map((attribute) => String(attribute.value || "").toLowerCase()).join(" ");
      return (target && (text === target || text.includes(target))) || attrs.includes(screenName) || attrs.includes(club);
    });
    if (!choice) {
      const available = choices.map((item) => String(item.textContent || "").trim()).filter(Boolean).slice(0, 8).join(", ");
      throw new Error(`Сообщество «${options.groupName || club}» не найдено среди авторов клипа. Доступно: ${available || "ничего"}.`);
    }
    choice.click();
    await delay(900);
    const updated = findAuthorSelector();
    const updatedName = cleanName(updated?.textContent);
    if (target && updatedName !== target && !updatedName.includes(target)) {
      throw new Error(`VK не подтвердил переключение автора на «${options.groupName || club}». Публикация остановлена.`);
    }
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value); else if (element.isContentEditable) element.textContent = value; else element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function chooseSchedule(publishAt) {
    if (!publishAt || publishAt <= Date.now() + 60_000) return false;
    const target = new Date(publishAt);
    const trigger = await waitFor(() => document.querySelector('[data-testid="clips-upload-publish-date"]'), 20_000, "дата публикации");
    trigger.click();
    await delay(500);
    const hour = await waitFor(() => document.querySelector('[data-testid="clips-upload-calendar-hours"]'), 10_000, "часы публикации");
    const minute = document.querySelector('[data-testid="clips-upload-calendar-minutes"]');
    if (!minute) throw new Error("VK изменил календарь клипов: не найдено поле минут. Вкладка оставлена открытой.");
    setNativeValue(hour, String(target.getHours()).padStart(2, "0"));
    setNativeValue(minute, String(target.getMinutes()).padStart(2, "0"));
    const monthInput = document.querySelector('[data-testid="clips-upload-calendar-month"]');
    for (let attempts = 0; monthInput && attempts < 12; attempts += 1) {
      const wanted = target.toLocaleString("ru-RU", { month: "long" }).toLowerCase();
      if (String(monthInput.value || monthInput.textContent).toLowerCase().includes(wanted)) break;
      const next = document.querySelector('[data-testid="clips-upload-calendar-next-month"]');
      if (!next) throw new Error("VK изменил переключатель месяца в календаре клипов.");
      next.click();
      await delay(250);
    }
    const day = [...document.querySelectorAll('[data-testid="clips-upload-calendar-day"]')].find((element) => {
      const number = element.querySelector('span[aria-hidden="true"]')?.textContent || element.textContent;
      return String(number).trim() === String(target.getDate());
    });
    if (!day) throw new Error("Не удалось выбрать день публикации в календаре VK.");
    day.click();
    await delay(300);
    if (document.querySelector('[data-testid="clips-upload-calendar-hours"]')) trigger.click();
    return true;
  }

  async function automateUpload(file, options) {
    showStatus("Файл получен. Открываю форму загрузки…");
    assertCommunityRoute(options);
    let input = findVideoFileInput();
    if (!input) {
      const entry = await waitFor(findUploadEntryButton, 30_000, "создать/добавить клип");
      entry.click();
      input = await waitForCommunityFileInput(options);
    }
    await delay(800);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    report("clip_upload_started");
    showStatus("VK загружает и обрабатывает видео…");

    const description = await waitFor(
      () => document.querySelector('[data-testid="clips-upload-description"],[data-testid*="clips-upload"][contenteditable="true"],textarea[placeholder*="описан" i],textarea[placeholder*="клип" i]'),
      90_000,
      "описание клипа после загрузки",
    );
    report("clip_upload_progress", { progress: 70 });
    await ensureCommunityAuthor(options);
    if (options.description) setNativeValue(description, options.description);

    const wallSwitch = document.querySelector('input[data-testid="clips-upload-wallpost"]');
    if (wallSwitch && wallSwitch.checked !== options.wallPost) wallSwitch.click();
    else if (!wallSwitch && options.wallPost) throw new Error("VK изменил переключатель публикации на стене. Проверьте форму вручную.");

    const scheduled = await chooseSchedule(options.publishAt);
    showStatus(scheduled ? "Ожидаю готовности кнопки «Запланировать»…" : "Ожидаю готовности кнопки «Опубликовать»…");
    const finalButton = await waitFor(() => {
      const button = document.querySelector('[data-testid="clips-uploadForm-publish-button"]')
        || document.querySelector('[data-testid="clips-publish-button"]');
      if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return null;
      const text = String(button.textContent || "").toLowerCase();
      return scheduled ? (text.includes("заплан") ? button : null) : (text.includes("опублик") ? button : null);
    }, 180_000, scheduled ? "запланировать клип" : "опубликовать клип");
    report("clip_upload_progress", { progress: 95 });
    finalButton.click();
    await waitFor(() => {
      const body = String(document.body?.innerText || "").toLowerCase();
      if (body.includes("клип опубликован") || body.includes("клип запланирован") || body.includes("клип успешно")) return true;
      return !document.contains(finalButton) && !document.querySelector('[data-testid="clips-uploadForm-publish-button"]');
    }, 45_000, "подтверждение публикации");
    showStatus(scheduled ? "Клип запланирован." : "Клип опубликован.", "done");
    report("clip_terminal", { event: "complete" });
  }

  function onPortMessage(message) {
    if (message.type !== "clip_chunk" || message.jobId !== jobId || terminalSent) return;
    try {
      const bytes = decodeChunk(String(message.data || ""));
      if (bytes.byteLength !== Number(message.byteLength) || Number(message.offset) !== receivedBytes) throw new Error("Нарушен порядок фрагментов видеофайла.");
      chunks.push(bytes);
      receivedBytes += bytes.byteLength;
      metadata = message;
      if (!message.done) {
        showStatus(`Передача видео во вкладку: ${Math.min(99, Math.round((receivedBytes / message.file.size) * 100))}%`);
        report("clip_chunk_ack", { nextOffset: receivedBytes });
        return;
      }
      if (receivedBytes !== Number(message.file.size)) throw new Error(`Размер полученного файла ${receivedBytes}, ожидалось ${message.file.size}.`);
      const file = new File(chunks, message.file.name, { type: message.file.type, lastModified: Date.now() });
      chunks.length = 0;
      void automateUpload(file, metadata).catch((error) => {
        showStatus(error.message, "error");
        report("clip_terminal", { event: "pause", error: error.message });
      });
    } catch (error) {
      showStatus(error.message, "error");
      report("clip_terminal", { event: "pause", error: error.message });
    }
  }

  function connectPort() {
    if (terminalSent) return;
    port = chrome.runtime.connect({ name: "vkr_clip_upload_tab" });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (!terminalSent) {
        chunks.length = 0;
        receivedBytes = 0;
        showStatus("Фоновый процесс расширения перезапустился. Восстанавливаю связь…");
        setTimeout(connectPort, 800);
      }
    });
    showStatus("Вкладка готова. Ожидаю видео из страницы расширения…");
    report("clip_tab_ready", { receivedBytes });
  }

  connectPort();
})();
