/**
 * VK Reposter Pro - Page Context Injection Script
 * Video & Clip Download with Network Interception
 * @version 4.6.0
 */

(function () {
  'use strict';

  if (location.hash && location.hash.includes('vkr_')) {
    sessionStorage.setItem('vkr_automation_tab', '1');
  }
  const isAutomationTab = (location.hash && location.hash.includes('vkr_')) || sessionStorage.getItem('vkr_automation_tab') === '1';
  if (isAutomationTab) {
    console.log('[VKR Injection] Automation tab detected, skipping injection.js logic');
    return;
  }

  let enabled = false;
  let activeClipId = null;
  let observer = null;
  let lastClickedClip = null;
  let lastVideoSrc = null;
  let isFetchingQualities = false;
  const clipRequestStatuses = new Map();

  // Получаем настройку из storage через content script
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;

    const { type, videoDownload, id, ts, videoId, ok, files, title } = event.data || {};

    if (type === 'VKR_DISABLE_BEFOREUNLOAD_MAIN') {
      window.onbeforeunload = null;
    }

    if (type === 'VKR_VIDEO_DOWNLOAD_SETTING') {
      enabled = videoDownload;
      console.log('[VKR Injection] Setting updated:', enabled);

      if (!enabled) {
        // Удаляем панель если выключено
        document.querySelector('#vkr-player-download-panel')?.remove();
        if (searchTimer) {
          clearInterval(searchTimer);
          searchTimer = null;
        }
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        activeClipId = null;
      } else {
        setupMutationObserver();
      }
    }

    if (type === 'VKR_LAST_CLICKED_CLIP') {
      lastClickedClip = { id, ts };
    }

    if (type === 'VKR_RESPONSE_VIDEO_QUALITIES') {
      if (isFetchingQualities === videoId) {
        isFetchingQualities = false;
      }

      if (ok && files) {
        const qualities = extractStandardQualities(files);
        if (Object.keys(qualities).length > 0) {
          clipCache.set(videoId, { qualities, title: title || "clip" });
          clipRequestStatuses.set(videoId, 'done');
          if (getCurrentClipId() === videoId) {
            activeClipId = videoId;
            createPanel(qualities, title || "clip");
          }
        } else {
          // Различаем причину отсутствия качеств
          const hasHls = files && (files.hls || files.live_hls || files.hlsMaster);
          const errMsg = hasHls
            ? 'Только HLS-поток, progressive MP4 недоступен'
            : 'Недоступно для скачивания';
          console.warn('[VKR] No qualities found in files:', files, '| HLS:', hasHls);
          clipRequestStatuses.set(videoId, 'failed');
          if (getCurrentClipId() === videoId) {
            showErrorPanel(errMsg);
          }
        }
      } else {
        // Нет данных вообще — возможно нет токена или ошибка API
        const noToken = event.data && event.data.error && /token|auth|access/i.test(event.data.error);
        const errMsg = noToken
          ? 'Нужна авторизация VK'
          : 'Недоступно для скачивания';
        console.warn('[VKR] No files in response. ok:', ok, 'error:', event.data?.error);
        clipRequestStatuses.set(videoId, 'failed');
        if (getCurrentClipId() === videoId) {
          showErrorPanel(errMsg);
        }
      }
    }
  });

  // Запрашиваем настройку при загрузке
  window.postMessage({ type: 'VKR_GET_VIDEO_DOWNLOAD_SETTING' }, '*');

  console.log('[VKR Injection] Script loaded, waiting for setting...');

  let currentUrl = location.href;
  let searchTimer = null;
  const clipCache = new Map();
  const rawClipSources = new Map();

  function checkEnabled() {
    if (!enabled) {
      console.log('[VKR Injection] Video download is disabled');
      return false;
    }
    return true;
  }

  // Задержка инициализации до получения настройки
  let initCheck = setInterval(() => {
    if (enabled) {
      clearInterval(initCheck);
      setupNetworkInterceptor();
      setupMutationObserver();

      setInterval(() => {
        if (location.href !== currentUrl && enabled) {
          currentUrl = location.href;
          handleUrlChange();
        }
      }, 500);

      handleUrlChange();
    }
  }, 100);

  // Таймаут - если настройка не получена за 3 сек, выключаем
  setTimeout(() => {
    clearInterval(initCheck);
    if (!enabled) {
      console.log('[VKR Injection] No setting received, disabled');
    }
  }, 3000);

  function handleUrlChange() {
    if (!enabled) return;

    document.querySelector('#vkr-player-download-panel')?.remove();

    if (searchTimer) {
      clearInterval(searchTimer);
      searchTimer = null;
    }

    const isClipUrl = isClipPage();
    const isVideoUrl = !isClipUrl && isVideoPage();

    console.log('[VKR Injection] URL:', location.href,
      '| isVideo:', isVideoUrl, '| isClip:', isClipUrl);

    if (isClipUrl) {
      const clipId = getCurrentClipId();
      if (clipId) {
        activeClipId = clipId;
        startPlayerSearch(true);
      }
    } else if (isVideoUrl) {
      startPlayerSearch(false);
    }
  }

  function isVideoPage() {
    return /z=video/.test(location.search)
      || /^\/video(-?\d+_\d+)?/.test(location.pathname)
      || /^\/videos/.test(location.pathname);
  }

  function isClipPage() {
    return /z=clip/.test(location.search)
      || /^\/clips/.test(location.pathname)
      || /^\/clip/.test(location.pathname);
  }

  function getCurrentClipId() {
    // а) параметр z=clip-XXX_YYY в location.href
    let m = location.href.match(/[?&]z=clip(-?\d+_\d+)/);
    if (m) return m[1];

    // б) lastClickedClip, если ему меньше 30 секунд (случай мессенджера)
    if (lastClickedClip && (Date.now() - lastClickedClip.ts < 30000)) {
      return lastClickedClip.id;
    }

    // в) прежние способы (ссылки вида /clip-XXX_YYY внутри модалки)
    const modal = document.querySelector('.VideoLayer__container, .ShortsPage, .ShortsPlayer, [class*="ShortsPlayer"], [class*="video_box_wrap"]');
    if (modal) {
      const links = modal.querySelectorAll('a[href*="/clip-"], a[href*="z=clip-"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const lm = href.match(/clip(-?\d+_\d+)/);
        if (lm) return lm[1];
      }
    }

    const video = document.querySelector('.ShortsPlayer video, [class*="ShortsPlayer"] video, .VideoLayer video, video');
    if (video) {
      const idAttr = video.getAttribute('id') || '';
      let vm = idAttr.match(/(-?\d+_\d+)/);
      if (vm) return vm[1];

      const parent = video.closest('[id*="video"], [data-video-id], [id*="clip"]');
      if (parent) {
        const pId = parent.getAttribute('id') || parent.getAttribute('data-video-id') || '';
        const pm = pId.match(/(-?\d+_\d+)/);
        if (pm) return pm[1];
      }
    }

    // Резервный поиск clip-XXX_YYY в URL
    m = location.href.match(/clip(-?\d+_\d+)/);
    if (m) return m[1];

    return null;
  }

  function isClipPlayerOpen() {
    const video = document.querySelector('video');
    if (!video) return false;

    if (document.querySelector('.ShortsPlayer, [class*="ShortsPlayer"], .ShortsPage, [class*="ShortsPage"]')) {
      return true;
    }
    if (document.querySelector('[class*="ShortsPlayer__actions"], [class*="actions"], [class*="Actions"]')) {
      return true;
    }
    if (/[?&]z=clip/.test(location.href)) {
      return true;
    }
    return false;
  }

  let mutationTimeout = null;

  function setupMutationObserver() {
    if (observer) return;

    observer = new MutationObserver(() => {
      if (!enabled) return;

      clearTimeout(mutationTimeout);
      mutationTimeout = setTimeout(() => {
        handleMutations();
      }, 1000);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  const originalQuerySelector = document.querySelector;
  const originalQuerySelectorAll = document.querySelectorAll;

  function handleMutations() {
    if (!enabled) return;

    // Временный кэш на время выполнения одного handleMutations
    const qsCache = new Map();
    const qsaCache = new Map();

    document.querySelector = function (selector) {
      if (qsCache.has(selector)) return qsCache.get(selector);
      const res = originalQuerySelector.call(document, selector);
      qsCache.set(selector, res);
      return res;
    };

    document.querySelectorAll = function (selector) {
      if (qsaCache.has(selector)) return qsaCache.get(selector);
      const res = originalQuerySelectorAll.call(document, selector);
      qsaCache.set(selector, res);
      return res;
    };

    try {
      const isOpen = isClipPlayerOpen();
      if (isOpen) {
        const video = document.querySelector('video');
        const currentSrc = video ? (video.currentSrc || video.src || '') : '';

        // Ранний выход для предотвращения лишних вызовов getCurrentClipId
        if (activeClipId &&
          clipRequestStatuses.get(activeClipId) === 'done' &&
          document.querySelector('#vkr-player-download-panel') &&
          lastVideoSrc === currentSrc) {
          return;
        }

        if (video && lastVideoSrc !== currentSrc) {
          if (currentSrc || lastVideoSrc) {
            console.log("[VKR] Video src changed from", lastVideoSrc, "to", currentSrc);
          }
          document.querySelector('#vkr-player-download-panel')?.remove();
          // Сбрасываем failed статус при смене src — позволяем повторный запрос
          if (activeClipId) {
            clipRequestStatuses.delete(activeClipId);
          }
          activeClipId = null;
          lastVideoSrc = currentSrc;
          isFetchingQualities = false;
        }

        const clipId = getCurrentClipId();
        if (!clipId) {
          console.warn("[VKR] Clip player open but clip ID not resolved.");
          document.querySelector('#vkr-player-download-panel')?.remove();
          activeClipId = null;
          return;
        }

        if (activeClipId !== clipId) {
          console.log('[VKR] Clip resolved:', clipId);
          document.querySelector('#vkr-player-download-panel')?.remove();
          // Сбрасываем failed статус при смене clipId — повторный запрос
          const prevStatus = clipRequestStatuses.get(clipId);
          if (prevStatus === 'failed') {
            console.log('[VKR] Clearing failed status for new clip:', clipId);
            clipRequestStatuses.delete(clipId);
          }
          activeClipId = clipId;
        }

        const status = clipRequestStatuses.get(clipId);
        if (status === 'loading') {
          return;
        }
        if (status === 'failed') {
          return;
        }
        if (status === 'done') {
          if (!document.querySelector('#vkr-player-download-panel')) {
            if (clipCache.has(clipId)) {
              const { qualities, title } = clipCache.get(clipId);
              createPanel(qualities, title);
            }
          }
          return;
        }

        console.log('[VKR] Clip player detected in modal. ID:', clipId);

        if (clipCache.has(clipId)) {
          const { qualities, title } = clipCache.get(clipId);
          createPanel(qualities, title);
          clipRequestStatuses.set(clipId, 'done');
        } else {
          if (isFetchingQualities !== clipId) {
            isFetchingQualities = clipId;
            clipRequestStatuses.set(clipId, 'loading');
            window.postMessage({ type: "VKR_REQUEST_VIDEO_QUALITIES", videoId: clipId }, "*");
          }
        }
      } else {
        if (activeClipId !== null) {
          console.log('[VKR] Clip player closed.');
          document.querySelector('#vkr-player-download-panel')?.remove();
          activeClipId = null;
          lastVideoSrc = null;
          isFetchingQualities = false;
        }
      }
    } finally {
      // Восстанавливаем оригинальные методы после завершения выполнения
      document.querySelector = originalQuerySelector;
      document.querySelectorAll = originalQuerySelectorAll;
    }
  }

  function startPlayerSearch(isClip = false) {
    if (!enabled) return;

    let attempts = 0;
    const maxAttempts = 60;

    searchTimer = setInterval(() => {
      if (!enabled) {
        clearInterval(searchTimer);
        searchTimer = null;
        return;
      }

      attempts++;
      if (location.href !== currentUrl) {
        clearInterval(searchTimer); searchTimer = null; return;
      }
      if (attempts > maxAttempts) {
        clearInterval(searchTimer); searchTimer = null; return;
      }
      const found = isClip ? tryFindClip() : tryFindVideo();
      if (found) { clearInterval(searchTimer); searchTimer = null; }
    }, 500);
  }

  function tryFindVideo() {
    const playerVars = window.mvcur?.player?.vars || window.cur?.videoInlinePlayer?.vars;
    if (playerVars && hasVideoUrls(playerVars)) {
      createPanel(extractStandardQualities(playerVars), playerVars.md_title || 'video');
      return true;
    }
    const videoEl = document.querySelector('#video_player video[src]');
    if (videoEl) {
      const src = videoEl.currentSrc || videoEl.src;
      if (src && !src.startsWith('blob:')) { createPanel({ 'auto': src }, 'video'); return true; }
    }
    const iframe = document.querySelector('#video_player iframe');
    if (iframe) { showErrorPanel('Видео со стороннего сайта'); return true; }
    return false;
  }

  function tryFindClip() {
    const clipId = getCurrentClipId();
    if (!clipId) {
      console.warn("[VKR] Clip ID not resolved cascade-wise.");
      return false;
    }
    if (clipCache.has(clipId)) {
      const { qualities, title } = clipCache.get(clipId);
      createPanel(qualities, title);
      return true;
    }
    return false;
  }

  // ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ КЭШИРОВАНИЯ И МАТЧИНГА =====
  function saveRawClipSource(key, qualities) {
    if (rawClipSources.size >= 20) {
      const oldestKey = rawClipSources.keys().next().value;
      rawClipSources.delete(oldestKey);
    }
    const entry = { key, qualities, ts: Date.now() };
    rawClipSources.set(key, entry);

    // Шлем в content.js
    window.postMessage({ type: "VKR_CLIP_SOURCES", entry }, "*");
  }

  function cleanUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.host + u.pathname;
    } catch (e) {
      return url.split('?')[0];
    }
  }

  async function matchClipFromCache(video) {
    const maxTime = 3000;
    const interval = 500;
    let elapsed = 0;

    while (elapsed <= maxTime) {
      const currentSrc = video?.currentSrc || video?.src || '';
      const cleanCurrent = cleanUrl(currentSrc);

      if (cleanCurrent) {
        // а) сматчи video.currentSrc с URL из кэша (сравнение по хосту и пути)
        for (const entry of rawClipSources.values()) {
          for (const qUrl of Object.values(entry.qualities)) {
            if (cleanUrl(qUrl) === cleanCurrent) {
              return entry;
            }
          }
        }
      }

      // б) если не сматчилось — возьми самую свежую запись с ts моложе 15 секунд
      let newestEntry = null;
      const now = Date.now();
      for (const entry of rawClipSources.values()) {
        if (now - entry.ts < 15000) {
          if (!newestEntry || entry.ts > newestEntry.ts) {
            newestEntry = entry;
          }
        }
      }
      if (newestEntry) {
        return newestEntry;
      }

      // в) если кэш пуст — повторяй проверку каждые 500 мс
      await new Promise(r => setTimeout(r, interval));
      elapsed += interval;
    }

    return null;
  }

  function scanTextForVideoQualities(text) {
    if (!text || typeof text !== 'string') return null;

    const videoIds = [];
    let match;

    // Паттерн 1: "oid": -123, "vid": 456
    const oidVidRegex = /"oid"\s*:\s*(-?\d+)\s*,\s*"vid"\s*:\s*(\d+)/g;
    while ((match = oidVidRegex.exec(text)) !== null) {
      videoIds.push(`${match[1]}_${match[2]}`);
    }

    // Паттерн 2: "video_id": "owner_id_video_id"
    const vidIdRegex = /"video_id"\s*:\s*"?(-?\d+_\d+)"?/g;
    while ((match = vidIdRegex.exec(text)) !== null) {
      videoIds.push(match[1]);
    }

    // Паттерн 3: clip-XXX_YYY
    const clipUrlRegex = /clip(-?\d+_\d+)/g;
    while ((match = clipUrlRegex.exec(text)) !== null) {
      videoIds.push(match[1]);
    }

    const uniqueIds = [...new Set(videoIds)];
    if (uniqueIds.length === 0) {
      const generalIdRegex = /(-?\d+_\d+)/g;
      while ((match = generalIdRegex.exec(text)) !== null) {
        const parts = match[1].split('_');
        if (parts[1] && parts[1].length >= 5) {
          uniqueIds.push(match[1]);
        }
      }
    }

    if (uniqueIds.length === 0) return null;

    const qualities = {};
    const qualPatterns = {
      '144p': /(?:url144|mp4_144|144)\b[^"']*?["'](https?:[^"']+?)["']/gi,
      '240p': /(?:url240|mp4_240|240)\b[^"']*?["'](https?:[^"']+?)["']/gi,
      '360p': /(?:url360|mp4_360|360)\b[^"']*?["'](https?:[^"']+?)["']/gi,
      '480p': /(?:url480|mp4_480|480)\b[^"']*?["'](https?:[^"']+?)["']/gi,
      '540p': /(?:url540|mp4_540|540)\b[^"']*?["'](https?:[^"']+?)["']/gi,
      '720p': /(?:url720|mp4_720|720)\b[^"']*?["'](https?:[^"']+?)["']/gi,
      '1080p': /(?:url1080|mp4_1080|1080)\b[^"']*?["'](https?:[^"']+?)["']/gi,
      '1440p': /(?:url1440|mp4_1440|1440)\b[^"']*?["'](https?:[^"']+?)["']/gi,
      '2160p': /(?:url2160|mp4_2160|2160)\b[^"']*?["'](https?:[^"']+?)["']/gi
    };

    for (const [label, regex] of Object.entries(qualPatterns)) {
      const qMatch = regex.exec(text);
      if (qMatch && qMatch[1]) {
        qualities[label] = qMatch[1].replace(/\\/g, '');
      }
    }

    if (Object.keys(qualities).length === 0) return null;

    return {
      ids: uniqueIds,
      qualities
    };
  }

  // ===== ПЕРЕХВАТ СЕТИ =====
  function setupNetworkInterceptor() {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const url = args[0]?.toString() || '';
      const response = await originalFetch.apply(this, args);

      try {
        const isTarget = url.includes('al_video.php') || url.includes('api.vk.com/method/video');
        if (isTarget) {
          const contentLength = response.headers.get('content-length');
          const size = contentLength ? parseInt(contentLength, 10) : 0;

          if (!contentLength || size <= 2 * 1024 * 1024) {
            response.clone().text().then(text => {
              if (text.length <= 2 * 1024 * 1024) {
                const result = scanTextForVideoQualities(text);
                if (result) {
                  for (const id of result.ids) {
                    saveRawClipSource(id, result.qualities);
                  }
                }
              }
            }).catch(() => { });
          }
        }
      } catch (err) {
        console.error('[VKR] Fetch interception error:', err);
      }

      if (url.includes('api.vk.com/method/video')) {
        try {
          const contentLength = response.headers.get('content-length');
          const size = contentLength ? parseInt(contentLength, 10) : 0;
          if (!contentLength || size <= 2 * 1024 * 1024) {
            const clipIdAtRequest = getCurrentClipId();
            response.clone().json().then(data => {
              processApiData(data, clipIdAtRequest);
            }).catch(() => { });
          }
        } catch (err) { }
      }

      return response;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._vkrUrl = url || '';
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          const url = this._vkrUrl || '';
          const isTarget = url.includes('al_video.php') || url.includes('api.vk.com/method/video');
          if (isTarget) {
            const responseText = this.responseText || '';
            if (responseText.length <= 2 * 1024 * 1024) {
              const result = scanTextForVideoQualities(responseText);
              if (result) {
                for (const id of result.ids) {
                  saveRawClipSource(id, result.qualities);
                }
              }
            }
          }

          if (url.includes('api.vk.com/method/video')) {
            const responseText = this.responseText || '';
            if (responseText.length <= 2 * 1024 * 1024) {
              const clipId = getCurrentClipId();
              if (clipId) {
                processApiData(JSON.parse(responseText), clipId);
              }
            }
          }
        } catch (e) {
          // Silent catch
        }
      });
      return origSend.apply(this, args);
    };

    console.log('[VKR Injection] Network interceptor ready');
  }

  function processApiData(data, clipId) {
    if (!clipId) return;
    if (clipCache.has(clipId)) return;

    try {
      const resp = data?.response;
      if (resp === undefined || resp === null) return;

      // resp может быть массивом (execute возвращает массив результатов)
      // или объектом с items
      const toSearch = Array.isArray(resp) ? resp : [resp];

      for (const chunk of toSearch) {
        if (!chunk || typeof chunk !== 'object') continue;

        // Ищем объект с полем items[] где items[0].files содержит mp4_*
        const items = chunk.items;
        if (Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            // Проверяем direct_url — там есть ID клипа!
            const directUrl = item.direct_url || item.share_url || '';
            const urlClipId = extractClipIdFromUrl(directUrl);

            const files = item.files;
            if (!files || typeof files !== 'object') continue;

            // Есть mp4 файлы
            const qualities = parseMp4Files(files);
            if (Object.keys(qualities).length === 0) continue;

            // Если нашли clipId в direct_url — матчим точно
            if (urlClipId && urlClipId === clipId) {
              console.log('[VKR] EXACT MATCH by direct_url:', clipId);
              saveAndShow(clipId, qualities, item.title || item.description || 'clip');
              return;
            }

            // Если direct_url нет — сохраняем в "pending" и покажем для текущего клипа
            if (!urlClipId) {
              console.log('[VKR] No direct_url, using for current clip:', clipId);
              saveAndShow(clipId, qualities, item.title || item.description || 'clip');
              return;
            }
          }
        }
      }
    } catch (e) {
      console.log('[VKR] processApiData error:', e.message);
    }
  }

  // Извлекаем clip ID из direct_url типа https://vkvideo.ru/clip-149478522_456259448
  function extractClipIdFromUrl(url) {
    if (!url) return null;
    const m = url.match(/clip(-?\d+_\d+)/);
    return m ? m[1] : null;
  }

  function parseMp4Files(files) {
    const qualities = {};
    const map = {
      'mp4_144': '144p', 'mp4_240': '240p', 'mp4_360': '360p',
      'mp4_480': '480p', 'mp4_540': '540p', 'mp4_720': '720p',
      'mp4_1080': '1080p', 'mp4_1440': '1440p', 'mp4_2160': '2160p'
    };
    for (const [key, label] of Object.entries(map)) {
      if (files[key] && typeof files[key] === 'string') {
        qualities[label] = files[key];
      }
    }
    return qualities;
  }

  function saveAndShow(clipId, qualities, title) {
    clipCache.set(clipId, { qualities, title });
    console.log('[VKR] Saved to cache:', clipId, Object.keys(qualities));
    if (getCurrentClipId() === clipId) {
      createPanel(qualities, title);
      if (searchTimer) { clearInterval(searchTimer); searchTimer = null; }
    }
  }

  function extractStandardQualities(obj) {
    if (!obj || typeof obj !== 'object') return {};
    const qualities = {};
    // Принимаем оба формата: url* (al_video) и mp4_* (video.get API)
    const map = {
      'url144': '144p',  'mp4_144': '144p',
      'url240': '240p',  'mp4_240': '240p',
      'url360': '360p',  'mp4_360': '360p',
      'url480': '480p',  'mp4_480': '480p',
      'url540': '540p',  'mp4_540': '540p',
      'url720': '720p',  'mp4_720': '720p',
      'url1080': '1080p','mp4_1080': '1080p',
      'url1440': '1440p','mp4_1440': '1440p',
      'url2160': '2160p','mp4_2160': '2160p',
    };
    for (const [key, label] of Object.entries(map)) {
      const v = obj[key];
      if (typeof v === 'string' && v.startsWith('http') && !qualities[label]) {
        qualities[label] = v.replace(/&amp;/g, '&');
      }
    }
    return qualities;
  }

  function hasVideoUrls(obj) {
    if (!obj) return false;
    // Проверяем оба формата ключей
    return !!(obj.url360 || obj.url480 || obj.url720 || obj.url240
      || obj.mp4_360 || obj.mp4_480 || obj.mp4_720 || obj.mp4_240);
  }

  function createPanel(qualities, title) {
    if (!enabled) return;

    document.querySelector('#vkr-player-download-panel')?.remove();
    if (!qualities || Object.keys(qualities).length === 0) return;

    const panel = document.createElement('div');
    panel.id = 'vkr-player-download-panel';
    panel.className = 'vkr-dl-panel';

    // SVG-иконка download
    const iconContainer = document.createElement('span');
    iconContainer.className = 'vkr-dl-icon';
    iconContainer.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    `;
    panel.appendChild(iconContainer);

    const label = document.createElement('span');
    label.className = 'vkr-dl-label';
    label.textContent = 'Скачать';
    panel.appendChild(label);

    const sorted = Object.entries(qualities).sort((a, b) =>
      (parseInt(b[0]) || 0) - (parseInt(a[0]) || 0)
    );

    sorted.forEach(([quality, url], index) => {
      const btn = document.createElement('a');
      btn.href = url;
      btn.textContent = quality;
      btn.className = index === 0 ? 'vkr-dl-btn vkr-dl-btn--primary' : 'vkr-dl-btn vkr-dl-btn--secondary';

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        window.postMessage({
          type: 'VKR_DOWNLOAD_VIDEO',
          url, quality,
          title: (title || 'clip').replace(/[^\wа-яёА-ЯЁ\- ]/gi, '_')
        }, '*');
      });
      panel.appendChild(btn);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'vkr-dl-close';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => panel.remove();
    panel.appendChild(closeBtn);

    document.body.appendChild(panel);
    console.log('[VKR] Panel created:', Object.keys(qualities));
  }

  function showErrorPanel(message) {
    document.querySelector('#vkr-player-download-panel')?.remove();
    const panel = document.createElement('div');
    panel.id = 'vkr-player-download-panel';
    panel.className = 'vkr-dl-panel vkr-dl-panel--error';
    panel.textContent = '⚠️ ' + message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'vkr-dl-close';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => panel.remove();
    panel.appendChild(closeBtn);

    document.body.appendChild(panel);
  }

  console.log('[VKR Injection] Ready');
})();
