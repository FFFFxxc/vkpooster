// VK Reposter Pro - Modal Version
const BUTTON_CLASS = 'vkr-btn';
const PROCESSED_ATTR = 'data-vkr-checked';

let tok = null;
let post = null;
let grps = [];
let mode = 'copy';
let modalEl = null;

// Переменные для модалки комментариев
let sRoot = null;
let commentModalEl = null;
let currentCommentPostId = null;

// Переменные для модалки лучших постов
let bestPostsModalEl = null;
let currentOwnerId = null;
let isLoadingPosts = false;
let loadedPosts = [];

// ========== API через background ==========
async function sendMessage(type, data) {
  return new Promise((resolve, reject) => {
    // Защита от ошибки "Extension context invalidated"
    if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      return reject(new Error('Расширение было обновлено. Нажми F5 (обновить страницу)!'));
    }
    
    chrome.runtime.sendMessage({ type, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.ok) {
        resolve(response);
      } else {
        const errorMsg = response?.error || 'Unknown error';
        if (errorMsg.includes('Auth failed') || errorMsg.includes('invalid access_token')) {
          showCustomAlert('❌ Токен недействителен. Пожалуйста, авторизуйтесь заново через расширение.');
          chrome.storage.local.remove('vk_token');
        }
        reject(new Error(errorMsg));
      }
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min = 3000, max = 7000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(delay);
}

// ========== POST DETECTION ==========
function getPostIdFromElement(postEl) {
  if (!postEl) return null;
  const dataId = postEl.getAttribute('data-post-id') || postEl.dataset?.postId;
  if (dataId) {
    return dataId.startsWith('wall') ? dataId : `wall${dataId}`;
  }
  if (postEl.id && postEl.id.startsWith('post-')) {
    return `wall${postEl.id.replace('post-', '')}`;
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
  const selectors = [
    '[data-testid="post-bottom-actions"]',
    '.PostActions', '.post_actions', '.post_actions_btns',
    '.PostActionsWrapper', '.PostActionsBottom', '.PostBottomActions',
    '.PostFooter', '.post_footer', '[class*="PostActions"]',
    '[class*="post_actions"]', '[class*="PostBottom"]',
    '[class*="PostFooter"]', '.like_wrap', '.like_cont',
    '[class*="like_wrap"]', '[class*="like_cont"]'
  ];
  
  // Строгая проверка - игнорируем всё внутри комментариев
  const ignoreSelector = '.reply, .wl_reply, [class*="CommentItem"], [class*="ReplyItem"], [class*="vkitComment"], [data-testid*="comment"], [id^="reply"], [id^="photo_comment"], [id^="video_comment"]';

  for (const selector of selectors) {
    const elements = postEl.querySelectorAll(selector);
    for (const el of elements) {
      if (!el.closest(ignoreSelector)) {
        return el;
      }
    }
  }
  
  const actionButtons = postEl.querySelectorAll(
    'button[aria-label*="Нравится"], button[aria-label*="Мне нравится"], a[aria-label*="Нравится"], [data-like-button], [data-testid="post-like-button"]'
  );
  
  for (const btn of actionButtons) {
    if (!btn.closest(ignoreSelector)) {
      return btn.closest('[class*="Actions"], [class*="actions"], [class*="PostButton"], [class*="like"]') || btn.parentElement;
    }
  }
  
  return null;
}

// ========== BUTTON INJECTION ==========
function addButton(postEl) {
  if (!postEl) return;
  const actions = findActionsContainer(postEl);
  if (!actions) return;

  // Проверяем что кнопки еще не добавлены
  if (postEl.querySelector(`.${BUTTON_CLASS}`)) return;

  // 1. Кнопка Репоста
  const btnRepost = document.createElement('button');
  btnRepost.type = 'button';
  btnRepost.className = BUTTON_CLASS;
  btnRepost.textContent = '📋 В группы';
  btnRepost.addEventListener('click', async (event) => {
    event.stopPropagation();
    event.preventDefault();
    const postUrl = getPostUrl(postEl);
    if (!postUrl) return alert('Не удалось определить ссылку на пост.');
    await openModal(postUrl);
  });
  actions.appendChild(btnRepost);

  // 2. Кнопка Комментария
  const btnComment = document.createElement('button');
  btnComment.type = 'button';
  btnComment.className = `${BUTTON_CLASS} vkr-btn-comment`;
  btnComment.textContent = '💬 Коммент';
  btnComment.addEventListener('click', async (event) => {
    event.stopPropagation();
    event.preventDefault();
    const postUrl = getPostUrl(postEl);
    if (!postUrl) return alert('Не удалось определить ссылку на пост.');
    await openCommentModal(postUrl);
  });
  actions.appendChild(btnComment);
}

function processPosts(root = document) {
  const posts = root.querySelectorAll(
    '[data-post-id], div[id^="post-"], article[data-post-id], .post, .wall_item, .feed_row, .Post, [data-testid="post-root"]'
  );
  const ignoreSelector = '.reply, .wl_reply, [class*="CommentItem"], [class*="ReplyItem"], [class*="vkitComment"], [data-testid*="comment"], [id^="reply"], [id^="photo_comment"], [id^="video_comment"]';

  posts.forEach((postEl) => {
    // ЗАЩИТА: Если блок является комментарием - пропускаем
    if (postEl.matches(ignoreSelector) || postEl.closest(ignoreSelector)) return;

    if (postEl.querySelector(`.${BUTTON_CLASS}`)) return;
    
    if (!postEl.getAttribute(PROCESSED_ATTR)) {
      postEl.setAttribute(PROCESSED_ATTR, '1');
    }
    
    addButton(postEl);
  });
}

// ========== COMMENT BOOST INJECTION ==========
function processComments(root = document) {
  const comments = root.querySelectorAll('.reply, .wl_reply, [class*="ReplyItem"], [class*="CommentItem"], [class*="vkitComment"], [data-testid*="comment"], [id^="reply"], [id^="photo_comment"], [id^="video_comment"]');
  
  comments.forEach(comment => {
    try {
      // Проверяем что комментарий еще не обработан
      if (comment.hasAttribute('data-vkr-boost-processed')) return;
      if (comment.querySelector('.vkr-boost-btn')) return;
      
      // Помечаем комментарий как обработанный
      comment.setAttribute('data-vkr-boost-processed', '1');

      let fullId = null;
      let itemType = 'comment'; 

      const reactBtn = comment.querySelector('[data-reaction-id], [data-object-id], [data-item-id]');
      if (reactBtn) {
        const rawId = reactBtn.getAttribute('data-reaction-id') || reactBtn.getAttribute('data-object-id') || reactBtn.getAttribute('data-item-id');
        if (rawId) {
          const m = rawId.match(/(video_comment|photo_comment|comment)?-?\d+_\d+/);
          if (m) {
            fullId = m[0].replace(/^(video_comment|photo_comment|comment)/, '');
            if (rawId.includes('video_comment')) itemType = 'video_comment';
            else if (rawId.includes('photo_comment')) itemType = 'photo_comment';
          }
        }
      }

      if (!fullId && comment.id) {
        const m = comment.id.match(/(video_comment|photo_comment|reply|comment)(-?\d+_\d+)/);
        if (m) {
          fullId = m[2];
          if (m[1] === 'video_comment') itemType = 'video_comment';
          else if (m[1] === 'photo_comment') itemType = 'photo_comment';
        }
      }

      if (!fullId) {
        const timeLink = comment.querySelector('a[href*="reply="]');
        if (timeLink) {
          const m = timeLink.getAttribute('href').match(/(video|photo|wall)(-?\d+_\d+)\?reply=(\d+)/);
          if (m) {
            fullId = m[2].split('_')[0] + '_' + m[3];
            if (m[1] === 'video') itemType = 'video_comment';
            else if (m[1] === 'photo') itemType = 'photo_comment';
          }
        }
      }

      if (!fullId || !fullId.includes('_')) return;

      const parts = fullId.match(/(-?\d+)_(\d+)/);
      if (!parts) return;
      
      const ownerId = parts[1];
      const commentId = parts[2];

      // Ищем место для вставки
      let targetContainer = null;
      
      const likeContainers = comment.querySelectorAll('[class*="likeShowOnHover"], [class*="CommentLike"], [class*="groupLike"]');
      for (const container of likeContainers) {
        const likeBtn = container.querySelector('[aria-label*="лайк"], [data-testid*="like"], svg[class*="like"]');
        if (likeBtn && !container.querySelector('.vkr-boost-btn')) {
          const style = window.getComputedStyle(container);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            targetContainer = container;
            break;
          }
        }
      }
      
      if (!targetContainer) {
        const likeButton = comment.querySelector('[aria-label*="Нравится"], [aria-label*="лайк"], [data-testid="comment-liked"]');
        if (likeButton) {
          targetContainer = likeButton.closest('[class*="like"]') || likeButton.parentElement;
        }
      }

      if (!targetContainer) return;
    if (!targetContainer.style.display || targetContainer.style.display === 'none') {
      targetContainer.style.display = 'flex';
    }
    targetContainer.style.alignItems = 'center';
    targetContainer.style.gap = '4px';

    const btn = document.createElement('button');
    btn.className = 'vkr-boost-btn';
    btn.innerHTML = '🤖';
    btn.title = 'Накрутить лайки со всех аккаунтов';
    btn.type = 'button';
    
    // ВАЖНО: Добавляем inline стили для гарантии видимости
    btn.style.cssText = `
      background: transparent !important;
      border: none !important;
      font-size: 16px !important;
      cursor: pointer !important;
      opacity: 0.7 !important;
      transition: all 0.2s !important;
      margin-left: 6px !important;
      display: inline-flex !important;
      align-items: center !important;
      padding: 4px !important;
      vertical-align: middle !important;
      flex-shrink: 0 !important;
    `;
    
    btn.onmouseenter = () => {
      btn.style.opacity = '1';
      btn.style.transform = 'scale(1.15)';
    };
    
    btn.onmouseleave = () => {
      btn.style.opacity = '0.7';
      btn.style.transform = 'scale(1)';
    };
    
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.innerHTML = '⏳';
      btn.disabled = true;
      showToast('🤖 Накручиваем лайки...');
      
      try {
        const res = await sendMessage('boost_comment', { ownerId, commentId, itemType });
        if (res.ok) {
          showToast(`✅ Успешно! Поставлено лайков: ${res.count}`);
          btn.innerHTML = '❤️';
        } else {
          showToast(`❌ Ошибка: ${res.error}`);
          btn.innerHTML = '🤖';
        }
      } catch (err) {
        showToast(`❌ Ошибка: ${err.message}`);
        btn.innerHTML = '🤖';
      }
      btn.disabled = false;
    };
    
      targetContainer.appendChild(btn);
    } catch (err) {
      // Игнорируем ошибки при обработке отдельных комментариев
    }
  });
}

function showToast(text) {
  const toast = document.createElement('div');
  toast.className = 'vkr-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ========== INIT OBSERVER ==========
let debounceTimeout;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    processPosts(document);
    processComments(document);
  }, 400); 
});

let scrollTimeout;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    processPosts(document);
    processComments(document);
  }, 800);
}, { passive: true });

// Глобальная функция для ручного запуска
window.VKR_processComments = () => {
  console.log('[VKR] Ручной запуск processComments');
  processComments(document);
};

// Функция для очистки всех кнопок (для отладки)
window.VKR_clearButtons = () => {
  console.log('[VKR] Удаление всех кнопок накрутки');
  document.querySelectorAll('.vkr-boost-btn').forEach(btn => btn.remove());
  document.querySelectorAll('[data-vkr-boost-processed]').forEach(el => el.removeAttribute('data-vkr-boost-processed'));
  console.log('[VKR] Готово! Теперь можно запустить VKR_processComments()');
};

console.log('[VKR] Расширение загружено!');
console.log('[VKR] Команды:');
console.log('[VKR]   VKR_processComments() - обработать комментарии');
console.log('[VKR]   VKR_clearButtons() - удалить все кнопки и начать заново');

processPosts(document);
processComments(document);
setTimeout(() => {
  processPosts(document);
  processComments(document);
}, 1500);

observer.observe(document.documentElement, { childList: true, subtree: true });

// ========== MODALS SHARED LOGIC ==========
async function initModals() {
  if (!sRoot) {
    if (typeof createShadowModal !== 'function') {
       throw new Error('Функция createShadowModal не найдена! Убедитесь что content-shadow-dom.js подключен.');
    }
    sRoot = await createShadowModal();
    modalEl = sRoot.querySelector('#vkr-modal-overlay');
    commentModalEl = sRoot.querySelector('#vkr-comment-modal-overlay');
    
    bindModalEvents();
    bindCommentModalEvents();
  }
}

// ========== REPOST MODAL LOGIC ==========
async function openModal(postUrl) {
  if (!chrome || !chrome.storage || !chrome.storage.local) {
    return alert('❌ Скрипт обновлен. Нажми F5 на клавиатуре!');
  }
  
  const d = await chrome.storage.local.get(['vk_token']);
  if (!d.vk_token) return alert('❌ Сначала авторизуйтесь! Откройте расширение через иконку в панели браузера.');
  tok = d.vk_token;

  await initModals();
  modalEl.style.display = 'flex';

  try {
    await loadPost(postUrl);
  } catch (e) {
    const statusEl = modalEl.querySelector('#vkr-status');
    if (statusEl) {
      statusEl.textContent = '❌ Ошибка загрузки: ' + e.message;
      statusEl.className = 'status error';
    }
  }
}

function bindModalEvents() {
  const $ = (id) => modalEl.querySelector('#' + id);
  let deleteMode = false;

  $('vkr-close').onclick = closeModal;
  $('vkr-cancel').onclick = closeModal;
  modalEl.onclick = (e) => {
    if (e.target === modalEl) closeModal();
  };

  modalEl.querySelectorAll('.vkr-mode-btn').forEach(btn => {
    btn.onclick = () => {
      mode = btn.dataset.mode;
      modalEl.querySelectorAll('.vkr-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      $('vkr-text-section').style.display = mode === 'repost' ? 'none' : 'block';
      $('vkr-watermark-section').style.display = mode === 'repost' ? 'none' : 'block';
    };
  });

  // ВОТЕРМАРКИ
  $('vkr-watermark-enabled').onchange = (e) => {
    $('vkr-watermark-settings').style.display = e.target.checked ? 'block' : 'none';
    updateWatermarkPreview();
  };

  loadWatermarks();

  $('vkr-watermark-opacity').oninput = (e) => {
    $('vkr-opacity-value').textContent = e.target.value + '%';
    updateWatermarkPreview();
  };

  $('vkr-watermark-size').oninput = (e) => {
    $('vkr-size-value').textContent = e.target.value + '%';
    updateWatermarkPreview();
  };

  $('vkr-watermark-list').onchange = updateWatermarkPreview;
  $('vkr-watermark-position').onchange = updateWatermarkPreview;

  async function updateWatermarkPreview() {
    const previewDiv = modalEl.querySelector('#vkr-watermark-preview');
    const canvas = modalEl.querySelector('#vkr-watermark-canvas');
    
    if (!$('vkr-watermark-enabled').checked || !post) {
      previewDiv.style.display = 'none';
      return;
    }

    const wmId = $('vkr-watermark-list').value;
    if (!wmId) {
      previewDiv.style.display = 'none';
      return;
    }

    const data = await chrome.storage.local.get('vkr_watermarks');
    const watermarks = data.vkr_watermarks || [];
    const wm = watermarks.find(w => w.id === wmId);
    if (!wm) {
      previewDiv.style.display = 'none';
      return;
    }

    const photoAttachment = post.attachments?.find(a => a.type === 'photo');
    if (!photoAttachment) {
      previewDiv.style.display = 'none';
      return;
    }

    const sizes = photoAttachment.photo.sizes || [];
    const photoSize = sizes.find(s => s.type === 'x') || sizes[sizes.length - 1];
    if (!photoSize) {
      previewDiv.style.display = 'none';
      return;
    }

    previewDiv.style.display = 'block';

    const ctx = canvas.getContext('2d');
    canvas.width = 400;
    canvas.height = 300;
    ctx.fillStyle = '#2a2a4a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#666';
    ctx.font = '14px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Фото поста', canvas.width / 2, canvas.height / 2);
    
    const watermarkImg = new Image();
    watermarkImg.onload = () => {
      const opacity = parseInt($('vkr-watermark-opacity').value) / 100;
      const size = parseInt($('vkr-watermark-size').value) / 100;
      const position = $('vkr-watermark-position').value;

      const wmWidth = canvas.width * size;
      const wmHeight = watermarkImg.height * (wmWidth / watermarkImg.width);

      let x, y;
      const padding = 10;

      switch (position) {
        case 'bottom-right': x = canvas.width - wmWidth - padding; y = canvas.height - wmHeight - padding; break;
        case 'bottom-left': x = padding; y = canvas.height - wmHeight - padding; break;
        case 'top-right': x = canvas.width - wmWidth - padding; y = padding; break;
        case 'top-left': x = padding; y = padding; break;
        case 'center': x = (canvas.width - wmWidth) / 2; y = (canvas.height - wmHeight) / 2; break;
        default: x = canvas.width - wmWidth - padding; y = canvas.height - wmHeight - padding;
      }

      ctx.globalAlpha = opacity;
      ctx.drawImage(watermarkImg, x, y, wmWidth, wmHeight);
      ctx.globalAlpha = 1.0;
    };

    watermarkImg.src = wm.dataUrl;
  }

  $('vkr-watermark-upload').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (!file.type.includes('png')) {
        showCustomAlert('Пожалуйста, выберите PNG файл');
        return;
      }

      const reader = new FileReader();
      reader.onload = async (event) => {
        const dataUrl = event.target.result;
        const name = prompt('Название водяного знака:', file.name.replace('.png', ''));
        if (!name) return;

        const data = await chrome.storage.local.get('vkr_watermarks');
        const watermarks = data.vkr_watermarks || [];
        watermarks.push({ id: Date.now().toString(), name, dataUrl });
        await chrome.storage.local.set({ vkr_watermarks: watermarks });

        loadWatermarks();
        showCustomAlert('Водяной знак добавлен!');
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  $('vkr-watermark-manage').onclick = async () => {
    const data = await chrome.storage.local.get('vkr_watermarks');
    const watermarks = data.vkr_watermarks || [];

    if (watermarks.length === 0) {
      showCustomAlert('Нет сохранённых водяных знаков');
      return;
    }

    const names = watermarks.map(w => w.name).join('\n');
    const confirmed = await showCustomConfirm(`Сохранённые водяные знаки:\n\n${names}\n\nУдалить все?`);
    
    if (confirmed) {
      await chrome.storage.local.set({ vkr_watermarks: [] });
      loadWatermarks();
      showCustomAlert('Все водяные знаки удалены');
    }
  };

  async function loadWatermarks() {
    const data = await chrome.storage.local.get('vkr_watermarks');
    const watermarks = data.vkr_watermarks || [];
    const select = $('vkr-watermark-list');
    
    select.innerHTML = '<option value="">Выберите водяной знак...</option>';
    watermarks.forEach(w => {
      const option = document.createElement('option');
      option.value = w.id;
      option.textContent = w.name;
      select.appendChild(option);
    });
  }

  // СКРОЛЛ КОЛЕСИКОМ ПО ДАТАМ (МАКСИМУМ 2026)
  $('vkr-date').addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = e.target;
    
    if (!input.value || input.value.length < 10) {
      const now = new Date();
      const day = String(now.getDate()).padStart(2, '0');
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const year = now.getFullYear();
      input.value = `${day}.${month}.${year}`;
    }
    
    const cursorPos = input.selectionStart || 0;
    const parts = input.value.split('.');
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
      if (year > 2026) year = 2026; // Ограничение года 2026
    }
    
    input.value = String(day).padStart(2, '0') + '.' + String(month).padStart(2, '0') + '.' + year;
    input.setSelectionRange(cursorPos, cursorPos);
  });

  $('vkr-time').addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = e.target;
    
    if (!input.value || input.value.length < 5) {
      input.value = '12:00';
    }
    
    const cursorPos = input.selectionStart || 0;
    const parts = input.value.split(':');
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
    
    input.value = String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
    input.setSelectionRange(cursorPos, cursorPos);
  });

  $('vkr-delete-hours').addEventListener('wheel', (e) => {
    e.preventDefault();
    const input = e.target;
    let val = parseInt(input.value) || 0;
    val += e.deltaY < 0 ? 1 : -1;
    if (val < 0) val = 0;
    if (val > 999) val = 999;
    input.value = val;
    modalEl.querySelectorAll('.vkr-chip').forEach(c => c.classList.remove('active'));
  });

  $('vkr-delete-minutes').addEventListener('wheel', (e) => {
    e.preventDefault();
    const input = e.target;
    let val = parseInt(input.value) || 0;
    val += (e.deltaY < 0 ? 15 : -15);
    if (val < 0) val = 0;
    if (val > 999) val = 999;
    input.value = val;
    modalEl.querySelectorAll('.vkr-chip').forEach(c => c.classList.remove('active'));
  });

  $('vkr-schedule').onchange = (e) => {
    $('vkr-schedule-inputs').style.display = e.target.checked ? 'flex' : 'none';
    if (e.target.checked && !$('vkr-date').value) {
      const now = new Date();
      now.setHours(now.getHours() + 1);
      const day = String(now.getDate()).padStart(2, '0');
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const year = now.getFullYear();
      $('vkr-date').value = `${day}.${month}.${year}`;
      $('vkr-time').value = now.toTimeString().slice(0, 5);
    }
    
    $('vkr-analytics').style.display = e.target.checked ? 'block' : 'none';
    if (e.target.checked) {
      populateAnalyticsGroupSelect();
    }
  };
  
  function populateAnalyticsGroupSelect() {
    const select = $('vkr-analytics-group');
    select.innerHTML = '';
    const checked = modalEl.querySelectorAll('#vkr-groups-list input:checked');
    if (checked.length === 0) {
      select.innerHTML = '<option>Сначала выберите группы</option>';
      return;
    }
    checked.forEach(c => {
      const name = c.closest('.vkr-group-item')?.querySelector('span')?.textContent || c.value;
      const opt = document.createElement('option');
      opt.value = c.value;
      opt.textContent = name;
      select.appendChild(opt);
    });
    runAnalytics(select.value);
  }
  
  $('vkr-analytics-group').onchange = (e) => {
    runAnalytics(e.target.value);
  };
  
  async function runAnalytics(groupId) {
    if (!groupId || !tok) return;
    
    $('vkr-analytics-loading').style.display = 'block';
    $('vkr-analytics-content').style.display = 'none';
    $('vkr-analytics-error').style.display = 'none';
    
    try {
      const res = await sendMessage('analyze_activity', { groupId, token: tok });
      const data = res.data;
      
      $('vkr-analytics-loading').style.display = 'none';
      $('vkr-analytics-content').style.display = 'block';
      $('vkr-analytics-meta').textContent = 'По ' + data.analyzedPosts + ' постам';
      
      const maxEng = Math.max(...data.hourly.map(h => h.engagement), 1);
      let hmHtml = '';
      for (let h = 0; h < 24; h++) {
        const d = data.hourly[h];
        const level = d.posts < 2 ? 0 : Math.ceil((d.engagement / maxEng) * 7);
        const isBest = data.top3[0] && data.top3[0].hour === h;
        const cls = 'vkr-heatmap-cell vkr-heat-' + Math.min(level, 7) + (isBest ? ' vkr-heat-best' : '');
        const tip = String(h).padStart(2, '0') + ':00 — ❤️' + d.engagement + ' 👁' + formatK(d.avgViews) + ' (' + d.posts + ' постов)';
        hmHtml += `<div class="${cls}" data-tooltip="${tip}" data-hour="${h}">${String(h).padStart(2, '0')}</div>`;
      }
      $('vkr-heatmap').innerHTML = hmHtml;
      
      modalEl.querySelectorAll('.vkr-heatmap-cell').forEach(cell => {
        cell.onclick = () => applyTime(parseInt(cell.dataset.hour));
      });
      
      const medals = ['🥇', '🥈', '🥉'];
      let topHtml = '';
      data.top3.forEach((t, i) => {
        topHtml += `<div class="vkr-rec-item${i === 0 ? ' gold' : ''}">
          <span class="vkr-rec-medal">${medals[i]}</span>
          <span class="vkr-rec-info"><strong>${String(t.hour).padStart(2, '0')}:00</strong>
          <span class="vkr-rec-stats"> — ❤️${t.engagement}  👁${formatK(t.avgViews)}</span></span>
          <button class="vkr-rec-btn" data-hour="${t.hour}">Применить</button>
          </div>`;
      });
      $('vkr-analytics-top3').innerHTML = topHtml;
      
      modalEl.querySelectorAll('.vkr-rec-btn').forEach(btn => {
        btn.onclick = () => applyTime(parseInt(btn.dataset.hour));
      });
      
    } catch (e) {
      $('vkr-analytics-loading').style.display = 'none';
      $('vkr-analytics-error').style.display = 'block';
      $('vkr-analytics-error').textContent = '❌ ' + e.message;
    }
  }
  
  function applyTime(hour) {
    $('vkr-time').value = String(hour).padStart(2, '0') + ':00';
    if (!$('vkr-date').value) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const d = String(tomorrow.getDate()).padStart(2, '0');
      const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
      $('vkr-date').value = d + '.' + m + '.' + tomorrow.getFullYear();
    }
    setStatus('⏰ Установлено: ' + String(hour).padStart(2, '0') + ':00', 'success');
  }
  
  function formatK(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  $('vkr-autodelete').onchange = (e) => {
    $('vkr-autodelete-settings').style.display = e.target.checked ? 'block' : 'none';
  };

  $('vkr-autocomment').onchange = (e) => {
    $('vkr-autocomment-settings').style.display = e.target.checked ? 'block' : 'none';
  };

  modalEl.querySelectorAll('.vkr-chip').forEach(chip => {
    chip.onclick = () => {
      $('vkr-delete-hours').value = chip.dataset.hours;
      $('vkr-delete-minutes').value = 0;
      modalEl.querySelectorAll('.vkr-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    };
  });

  $('vkr-delete-hours').oninput = $('vkr-delete-minutes').oninput = () => {
    modalEl.querySelectorAll('.vkr-chip').forEach(c => c.classList.remove('active'));
  };

  const groupsList = $('vkr-groups-list');
  groupsList.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') {
      updateGroupCount();
    }
  });
  
  groupsList.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.vkr-group-delete');
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const gid = deleteBtn.dataset.groupId;
      
      const confirmed = await showCustomConfirm('Скрыть эту группу из списка? Вы сможете вернуть её через настройки.');
      if (confirmed) {
        const data = await chrome.storage.local.get('vkr_hidden_groups');
        const hidden = data.vkr_hidden_groups || [];
        hidden.push(gid);
        await chrome.storage.local.set({ vkr_hidden_groups: hidden });
        
        const item = modalEl.querySelector(`.vkr-group-item input[data-gid="${gid}"]`);
        if (item) item.closest('.vkr-group-item').remove();
        
        updateGroupCount();
      }
    }
  });
  
  // КНОПКИ ВСЕ / СНЯТЬ
  $('vkr-select-all').onclick = () => {
    modalEl.querySelectorAll('#vkr-groups-list input').forEach(c => c.checked = true);
    updateGroupCount();
  };
  $('vkr-select-none').onclick = () => {
    modalEl.querySelectorAll('#vkr-groups-list input').forEach(c => c.checked = false);
    updateGroupCount();
  };
  
  async function loadHiddenGroups() {
    const data = await chrome.storage.local.get('vkr_hidden_groups');
    const hidden = data.vkr_hidden_groups || [];
    
    const hiddenList = modalEl.querySelector('#vkr-hidden-groups-list');
    const hiddenCount = modalEl.querySelector('#vkr-hidden-count');
    
    if (hidden.length === 0) {
      hiddenList.innerHTML = '<div style="text-align:center;color:#666;padding:20px">Нет скрытых групп</div>';
      hiddenCount.textContent = '0 скрыто';
      return;
    }
    
    hiddenCount.textContent = hidden.length + ' скрыто';
    
    let gh = '';
    hidden.forEach(gid => {
      const g = grps.find(gr => String(gr.id) === gid);
      if (!g) return;
      
      gh += `<label class="vkr-group-item">
        <img src="${g.photo_50}">
        <span>${esc(g.name)}</span>
        <button class="vkr-group-restore" data-group-id="${g.id}" title="Восстановить группу">↩️</button>
      </label>`;
    });
    
    hiddenList.innerHTML = gh;
    
    modalEl.querySelectorAll('.vkr-group-restore').forEach(btn => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const gid = btn.dataset.groupId;
        
        const data = await chrome.storage.local.get('vkr_hidden_groups');
        const hidden = data.vkr_hidden_groups || [];
        const newHidden = hidden.filter(id => id !== gid);
        await chrome.storage.local.set({ vkr_hidden_groups: newHidden });
        
        btn.closest('.vkr-group-item').remove();
        
        const count = modalEl.querySelectorAll('#vkr-hidden-groups-list .vkr-group-item').length;
        modalEl.querySelector('#vkr-hidden-count').textContent = count + ' скрыто';
        
        if (count === 0) {
          hiddenList.innerHTML = '<div style="text-align:center;color:#666;padding:20px">Нет скрытых групп</div>';
        }
        
        showCustomAlert('Группа восстановлена! Перезагрузите окно чтобы увидеть её в списке активных.');
      };
    });
  }

  // РЕЖИМ УДАЛЕНИЯ
  $('vkr-delete-mode').onclick = () => {
    deleteMode = !deleteMode;
    
    if (deleteMode) {
      $('vkr-delete-mode').classList.add('active');
      $('vkr-delete-panel').style.display = 'block';
      $('vkr-group-count').style.display = 'none';
      modalEl.querySelectorAll('#vkr-groups-list input').forEach(c => c.checked = false);
      modalEl.querySelector('#vkr-groups-list').classList.add('delete-mode');
    } else {
      $('vkr-delete-mode').classList.remove('active');
      $('vkr-delete-panel').style.display = 'none';
      $('vkr-group-count').style.display = 'block';
      modalEl.querySelectorAll('#vkr-groups-list input').forEach(c => c.checked = false);
      modalEl.querySelector('#vkr-groups-list').classList.remove('delete-mode');
      updateGroupCount();
    }
  };

  $('vkr-delete-selected').onclick = async () => {
    const selected = [];
    modalEl.querySelectorAll('#vkr-groups-list input:checked').forEach(c => {
      selected.push(c.value);
    });

    if (selected.length === 0) {
      showCustomAlert('Выберите группы для скрытия');
      return;
    }

    const confirmed = await showCustomConfirm(`Скрыть ${selected.length} групп(ы)?`);
    if (confirmed) {
      const data = await chrome.storage.local.get('vkr_hidden_groups');
      const hidden = data.vkr_hidden_groups || [];
      hidden.push(...selected);
      await chrome.storage.local.set({ vkr_hidden_groups: hidden });

      selected.forEach(gid => {
        const item = modalEl.querySelector(`.vkr-group-item input[value="${gid}"]`);
        if (item) item.closest('.vkr-group-item').remove();
      });

      deleteMode = false;
      $('vkr-delete-mode').classList.remove('active');
      $('vkr-delete-panel').style.display = 'none';
      $('vkr-group-count').style.display = 'block';
      modalEl.querySelector('#vkr-groups-list').classList.remove('delete-mode');
      updateGroupCount();
    }
  };

  $('vkr-cancel-delete').onclick = () => {
    deleteMode = false;
    $('vkr-delete-mode').classList.remove('active');
    $('vkr-delete-panel').style.display = 'none';
    $('vkr-group-count').style.display = 'block';
    modalEl.querySelectorAll('#vkr-groups-list input').forEach(c => c.checked = false);
    modalEl.querySelector('#vkr-groups-list').classList.remove('delete-mode');
    updateGroupCount();
  };

  $('vkr-search').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    modalEl.querySelectorAll('.vkr-group-item').forEach(el => {
      el.style.display = el.querySelector('span').textContent.toLowerCase().includes(q) ? 'flex' : 'none';
    });
  };

  // ВКЛАДКИ
  modalEl.querySelectorAll('.vkr-tab').forEach(tab => {
    tab.onclick = () => {
      const tabName = tab.dataset.tab;
      
      modalEl.querySelectorAll('.vkr-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      modalEl.querySelectorAll('.vkr-tab-content').forEach(c => c.classList.remove('active'));
      modalEl.querySelector(`#vkr-tab-${tabName}`).classList.add('active');
      
      if (tabName === 'hidden') {
        loadHiddenGroups();
      }
    };
  });

  $('vkr-search-hidden').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    modalEl.querySelectorAll('#vkr-hidden-groups-list .vkr-group-item').forEach(el => {
      el.style.display = el.querySelector('span').textContent.toLowerCase().includes(q) ? 'flex' : 'none';
    });
  };

  $('vkr-restore-all').onclick = async () => {
    const confirmed = await showCustomConfirm('Восстановить все скрытые группы?');
    if (confirmed) {
      await chrome.storage.local.set({ vkr_hidden_groups: [] });
      showCustomAlert('Все группы восстановлены! Перезагрузите окно (закройте и откройте пост заново).');
    }
  };

  $('vkr-submit').onclick = sendToGroups;
  
  // DRAGGABLE
  makeDraggable();
}

function makeDraggable() {
  const header = modalEl.querySelector('#vkr-modal-header');
  const modal = modalEl.querySelector('#vkr-modal');
  
  if (!header || !modal) return;
  
  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;
  
  header.style.cursor = 'move';
  header.style.userSelect = 'none';
  
  header.addEventListener('mousedown', dragStart);
  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', dragEnd);
  
  function dragStart(e) {
    if (e.target.closest('button')) return;
    
    initialX = e.clientX - xOffset;
    initialY = e.clientY - yOffset;
    
    isDragging = true;
    header.style.cursor = 'grabbing';
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
    header.style.cursor = 'move';
  }
}

function closeModal() {
  if (modalEl) modalEl.style.display = 'none';
}

async function loadPost(postUrl) {
  const $ = (id) => modalEl.querySelector('#' + id);

  setStatus('⏳ Загрузка поста...', 'info');
  console.log('[VKR-CS] loadPost called, URL:', postUrl);
  console.log('[VKR-CS] Token:', tok ? tok.substring(0, 10) + '...' : 'NULL');

  try {
    console.log('[VKR-CS] Sending load_post message to background...');
    
    const response = await Promise.race([
      sendMessage('load_post', { postUrl, token: tok }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Background не ответил за 15 сек. Service Worker мёртв?')), 15000))
    ]);
    
    console.log('[VKR-CS] Response from background:', response);
    console.log('[VKR-CS] Post:', response.post ? 'OK, id=' + response.post.id : 'MISSING');
    console.log('[VKR-CS] Groups:', response.groups ? response.groups.length : 'MISSING');
    
    post = response.post;
    grps = response.groups;
    console.log('[VKR-CS] Post assigned:', post, 'Groups:', grps.length);

    // Превью
    let html = esc(post.text || '[Без текста]');
    if (post.attachments) {
      const ph = post.attachments.filter(a => a.type === 'photo');
      ph.forEach((a, index) => {
        const s = a.photo.sizes || [];
        const b = s.find(x => x.type === 'x') || s[s.length - 1];
        if (b) {
          html += `<div class="vkr-photo-preview" data-photo-index="${index}">
            <img src="${b.url}">
            <button class="vkr-photo-delete" data-photo-index="${index}" title="Удалить это фото">✕</button>
          </div>`;
        }
      });
      const types = post.attachments.map(a => {
        if (a.type === 'photo') return '🖼';
        if (a.type === 'video') return '🎥';
        if (a.type === 'doc') return '📎';
        return '📁';
      });
      html += '<div style="color:#5181b8;margin-top:8px">' + types.join(' ') + '</div>';
    }
    $('vkr-post-content').innerHTML = html;
    $('vkr-post-text').value = post.text || '';
    
    // Обработчики удаления фото
    modalEl.querySelectorAll('.vkr-photo-delete').forEach(btn => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const photoIndex = parseInt(btn.dataset.photoIndex);
        
        const photoAttachments = post.attachments.filter(a => a.type === 'photo');
        const photoToRemove = photoAttachments[photoIndex];
        const indexInAll = post.attachments.indexOf(photoToRemove);
        
        if (indexInAll !== -1) {
          post.attachments.splice(indexInAll, 1);
        }
        
        const photoPreview = modalEl.querySelector(`.vkr-photo-preview[data-photo-index="${photoIndex}"]`);
        if (photoPreview) {
          photoPreview.remove();
        }
        
        setStatus('🗑️ Фото удалено из превью', 'info');
        setTimeout(() => setStatus('', ''), 2000);
      };
    });

    // Группы
    const saved = await chrome.storage.local.get('vkr_groups');
    const sg = saved.vkr_groups || [];
    const autoSelect = sg.length === 0;

    const hiddenData = await chrome.storage.local.get('vkr_hidden_groups');
    const hiddenGroups = hiddenData.vkr_hidden_groups || [];

    let gh = '';
    grps.forEach(g => {
      if (hiddenGroups.includes(String(g.id))) return;
      
      const ch = (autoSelect || sg.includes(String(g.id))) ? 'checked' : '';
      gh += `<label class="vkr-group-item" data-group-id="${g.id}">
        <input type="checkbox" value="${g.id}" ${ch} data-gid="${g.id}">
        <img src="${g.photo_50}">
        <span>${esc(g.name)}</span>
        <button class="vkr-group-delete" data-group-id="${g.id}" title="Скрыть группу">✕</button>
      </label>`;
    });
    $('vkr-groups-list').innerHTML = gh;
    
    updateGroupCount();

    setStatus('✅ Пост загружен!', 'success');
    console.log('[VKR-CS] loadPost complete!');
  } catch (e) {
    console.error('[VKR-CS] loadPost ERROR:', e);
    setStatus('❌ ' + e.message, 'error');
  }
}

function updateGroupCount() {
  const n = modalEl.querySelectorAll('#vkr-groups-list input:checked').length;
  modalEl.querySelector('#vkr-group-count').textContent = n + ' выбрано';
}

function setStatus(text, type) {
  const st = modalEl.querySelector('#vkr-status');
  st.textContent = text;
  st.className = type ? 'status ' + type : '';
}

async function sendToGroups() {
  const $ = (id) => modalEl.querySelector('#' + id);

  const sel = [];
  modalEl.querySelectorAll('#vkr-groups-list input:checked').forEach(c => sel.push(c.value));
  if (!sel.length) {
    setStatus('❌ Выберите группы!', 'error');
    return;
  }
  if (!post) {
    setStatus('❌ Пост не загружен!', 'error');
    return;
  }

  chrome.storage.local.set({ vkr_groups: sel });

  const txt = $('vkr-post-text').value;

  // Настройки водяного знака
  let watermarkSettings = null;
  let processedPhotos = []; 
  
  if ($('vkr-watermark-enabled').checked && mode === 'copy') {
    const wmId = $('vkr-watermark-list').value;
    if (wmId && post.attachments) {
      const data = await chrome.storage.local.get('vkr_watermarks');
      const watermarks = data.vkr_watermarks || [];
      const wm = watermarks.find(w => w.id === wmId);
      
      if (wm) {
        setStatus('⏳ Обработка фото с водяными знаками...', 'info');
        
        const photoAttachments = post.attachments.filter(a => a.type === 'photo');
        
        for (const attachment of photoAttachments) {
          try {
            const sizes = attachment.photo.sizes || [];
            const best =
              sizes.find(s => s.type === 'w') ||
              sizes.find(s => s.type === 'z') ||
              sizes.find(s => s.type === 'y') ||
              sizes.find(s => s.type === 'x') ||
              sizes[sizes.length - 1];
            
            if (best) {
              const processedDataUrl = await applyWatermarkToPhoto(best.url, {
                dataUrl: wm.dataUrl,
                position: $('vkr-watermark-position').value,
                opacity: parseInt($('vkr-watermark-opacity').value) / 100,
                size: parseInt($('vkr-watermark-size').value) / 100
              });
              
              processedPhotos.push(processedDataUrl);
            }
          } catch (e) {
            console.error('Ошибка обработки фото:', e);
          }
        }
      }
    }
  }

  // Проверяем отложку
  let pubDate = null;
  if ($('vkr-schedule').checked) {
    const d = $('vkr-date').value;
    const t = $('vkr-time').value;
    if (!d || !t || d.length < 10 || t.length < 5) {
      setStatus('❌ Укажите дату и время правильно!', 'error');
      return;
    }
    const [day, month, year] = d.split('.').map(Number);
    const [hours, minutes] = t.split(':').map(Number);
    pubDate = new Date(year, month - 1, day, hours, minutes).getTime();
    if (isNaN(pubDate) || pubDate <= Date.now()) {
      setStatus('❌ Дата должна быть в будущем!', 'error');
      return;
    }
  }

  // Проверяем автоудаление
  let autoDeleteAfter = null;
  if ($('vkr-autodelete').checked) {
    const hours = parseInt($('vkr-delete-hours').value) || 0;
    const minutes = parseInt($('vkr-delete-minutes').value) || 0;
    
    if (hours === 0 && minutes === 0) {
      setStatus('❌ Укажите время для автоудаления!', 'error');
      return;
    }
    
    autoDeleteAfter = (hours * 60 + minutes) * 60 * 1000;
  }

  // Проверяем автокомментарий
  let autoCommentText = null;
  if ($('vkr-autocomment').checked) {
    const commentText = $('vkr-autocomment-text').value.trim();
    if (!commentText) {
      setStatus('❌ Введите текст комментария!', 'error');
      return;
    }
    autoCommentText = commentText;
  }

  const btn = $('vkr-submit');
  btn.disabled = true;
  btn.textContent = '⏳ Отправка...';
  $('vkr-progress').style.display = 'block';

  try {
    let completed = 0;
    const total = sel.length;

    let ok = 0, fail = 0;
    for (const gid of sel) {
      const gn = modalEl.querySelector('input[value="' + gid + '"]')?.closest('.vkr-group-item')?.querySelector('span')?.textContent || gid;
      setStatus(`📤 "${gn}" (${completed + 1}/${total})...`, 'info');

      try {
        const response = await sendMessage('send_to_groups', {
          post,
          groups: [gid],
          mode,
          text: txt,
          pubDate,
          processedPhotos,
          autoDeleteAfter,
          autoCommentText,
          token: tok
        });

        if (response.results[0].ok) {
          ok++;
          
          if (autoDeleteAfter && response.results[0].postId) {
            const deleteAt = Date.now() + autoDeleteAfter;
            await saveScheduledDeletion(gid, response.results[0].postId, deleteAt);
          }
          
          if (autoCommentText && response.results[0].postId) {
            if (pubDate) {
              // Для отложенных постов - сохраняем комментарий для публикации после выхода
              const commentAt = pubDate + 5000; // Комментарий через 5 секунд после публикации
              await saveScheduledComment(gid, response.results[0].postId, autoCommentText, commentAt);
            } else {
              // Для моментальных постов - сохраняем комментарий для публикации через 3 секунды
              const commentAt = Date.now() + 3000; // Комментарий через 3 секунды
              await saveScheduledComment(gid, response.results[0].postId, autoCommentText, commentAt);
            }
          }
        } else {
          fail++;
        }
      } catch (e) {
        fail++;
        console.error(gid, e);
      }

      completed++;
      const pct = Math.round((completed / total) * 100);
      $('vkr-progress-bar').style.width = pct + '%';

      if (completed < total) await randomDelay(3000, 7000);
    }

    $('vkr-progress-bar').style.width = '100%';
    btn.disabled = false;

    if (!fail) {
      setStatus(`✅ Отправлено в ${ok} групп! Можете выбрать другие группы или закрыть окно.`, 'success');
      btn.textContent = '✅ Готово!';
    } else {
      setStatus(`⚠️ Успешно: ${ok}, Ошибки: ${fail}`, 'error');
      btn.textContent = '🔄 Ещё раз';
    }

    setTimeout(() => {
      btn.textContent = '🚀 Репост';
    }, 3000);
  } catch (e) {
    setStatus('❌ ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '🚀 Репост';
  }
}

function esc(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

// ========== CUSTOM DIALOGS ==========
function showCustomAlert(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'vkr-custom-dialog-overlay';
    overlay.innerHTML = `
      <div class="vkr-custom-dialog">
        <div class="vkr-custom-dialog-message">${esc(message)}</div>
        <div class="vkr-custom-dialog-buttons">
          <button class="vkr-custom-dialog-btn vkr-custom-dialog-btn-primary">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    
    const btn = overlay.querySelector('.vkr-custom-dialog-btn');
    btn.onclick = () => {
      overlay.remove();
      resolve();
    };
    
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve();
      }
    };
  });
}

function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'vkr-custom-dialog-overlay';
    overlay.innerHTML = `
      <div class="vkr-custom-dialog">
        <div class="vkr-custom-dialog-message">${esc(message)}</div>
        <div class="vkr-custom-dialog-buttons">
          <button class="vkr-custom-dialog-btn vkr-custom-dialog-btn-secondary" data-action="cancel">Отмена</button>
          <button class="vkr-custom-dialog-btn vkr-custom-dialog-btn-primary" data-action="confirm">Подтвердить</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    
    const buttons = overlay.querySelectorAll('.vkr-custom-dialog-btn');
    buttons.forEach(btn => {
      btn.onclick = () => {
        const action = btn.dataset.action;
        overlay.remove();
        resolve(action === 'confirm');
      };
    });
    
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(false);
      }
    };
  });
}

// ========== WATERMARK ==========
async function applyWatermarkToPhoto(photoUrl, settings) {
  return new Promise(async (resolve, reject) => {
    try {
      const photoResponse = await sendMessage('fetch_image', { url: photoUrl });
      const photoDataUrl = photoResponse.dataUrl;
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
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
            case 'bottom-right':
              x = canvas.width - wmWidth - padding;
              y = canvas.height - wmHeight - padding;
              break;
            case 'bottom-left':
              x = padding;
              y = canvas.height - wmHeight - padding;
              break;
            case 'top-right':
              x = canvas.width - wmWidth - padding;
              y = padding;
              break;
            case 'top-left':
              x = padding;
              y = padding;
              break;
            case 'center':
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
          
          const format = photoUrl.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg';
          const quality = format === 'image/jpeg' ? 0.95 : 1.0;
          
          const resultDataUrl = canvas.toDataURL(format, quality);
          resolve(resultDataUrl);
        };
        
        watermarkImg.onerror = () => reject(new Error('Не удалось загрузить водяной знак'));
        watermarkImg.src = settings.dataUrl;
      };
      
      photoImg.onerror = () => reject(new Error('Не удалось загрузить фото'));
      photoImg.src = photoDataUrl;
    } catch (e) {
      reject(e);
    }
  });
}

// ========== AUTO DELETE ==========
async function saveScheduledDeletion(ownerId, postId, deleteAt) {
  const data = await chrome.storage.local.get('vkr_scheduled_deletions');
  const deletions = data.vkr_scheduled_deletions || [];
  
  deletions.push({
    ownerId: '-' + ownerId,
    postId,
    deleteAt,
    createdAt: Date.now()
  });
  
  await chrome.storage.local.set({ vkr_scheduled_deletions: deletions });
}

async function saveScheduledComment(ownerId, postId, commentText, commentAt) {
  const data = await chrome.storage.local.get('vkr_scheduled_comments');
  const comments = data.vkr_scheduled_comments || [];
  
  comments.push({
    ownerId: '-' + ownerId,
    postId,
    commentText,
    commentAt,
    createdAt: Date.now()
  });
  
  await chrome.storage.local.set({ vkr_scheduled_comments: comments });
}

// ========== COMMENT MODAL FUNCTIONS ==========
async function openCommentModal(postUrl) {
  const m = postUrl.match(/wall(-?\d+_\d+)/) || postUrl.match(/(-?\d+_\d+)/);
  if (!m) return alert('❌ Не удалось получить ID поста');
  currentCommentPostId = m[1];

  await initModals();

  const d = await chrome.storage.local.get(['vk_accounts', 'vkr_comment_templates']);
  const accounts = d.vk_accounts || [];
  
  if (accounts.length === 0) {
    alert('❌ Сначала добавьте аккаунты в расширении!');
    return;
  }

  const select = commentModalEl.querySelector('#vkr-comment-account');
  select.innerHTML = '';
  accounts.forEach((acc, i) => {
    const suffix = i === 0 ? ' (Основной)' : ' (Бот)';
    select.innerHTML += `<option value="${i}">${acc.name}${suffix}</option>`;
  });

  renderPhrases(d.vkr_comment_templates || []);

  commentModalEl.style.display = 'flex';
}

function renderPhrases(phrases) {
  const list = commentModalEl.querySelector('#vkr-phrases-list');
  list.innerHTML = '';
  
  if (phrases.length === 0) {
    list.innerHTML = '<div style="color: #a1a1aa; text-align: center; padding: 10px; font-size: 13px;">Нет заготовленных фраз. Добавьте первую!</div>';
    return;
  }
  
  phrases.forEach((text, i) => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px; font-size: 13px;';
    div.innerHTML = `
      <span style="flex:1; word-break: break-word;">${esc(text)}</span>
      <button class="vkr-phrase-del" data-idx="${i}" style="background:transparent; border:none; color:#ef5350; cursor:pointer; font-size:16px; margin-left:8px; padding: 0 4px;">✕</button>
    `;
    list.appendChild(div);
  });
  
  list.querySelectorAll('.vkr-phrase-del').forEach(btn => {
    btn.onclick = async () => {
      const idx = parseInt(btn.dataset.idx);
      phrases.splice(idx, 1);
      await chrome.storage.local.set({ vkr_comment_templates: phrases });
      renderPhrases(phrases);
    };
  });
}

function bindCommentModalEvents() {
  const $ = (id) => commentModalEl.querySelector('#' + id);
  
  $('vkr-comment-close').onclick = () => commentModalEl.style.display = 'none';
  commentModalEl.onclick = (e) => { if (e.target === commentModalEl) commentModalEl.style.display = 'none'; };

  $('vkr-add-phrase').onclick = async () => {
    const val = $('vkr-new-phrase').value.trim();
    if (!val) return;
    
    const d = await chrome.storage.local.get('vkr_comment_templates');
    const tpl = d.vkr_comment_templates || [];
    tpl.push(val);
    await chrome.storage.local.set({ vkr_comment_templates: tpl });
    
    $('vkr-new-phrase').value = '';
    renderPhrases(tpl);
  };

  $('vkr-send-comment-btn').onclick = async () => {
    const d = await chrome.storage.local.get(['vk_accounts', 'vkr_comment_templates']);
    const tpl = d.vkr_comment_templates || [];
    const accounts = d.vk_accounts || [];
    
    if (tpl.length === 0) return alert('❌ Добавьте хотя бы одну фразу!');
    
    const accIdx = $('vkr-comment-account').value;
    const account = accounts[accIdx];
    
    const randomText = tpl[Math.floor(Math.random() * tpl.length)];
    
    const parts = currentCommentPostId.split('_');
    const ownerId = parts[0];
    const postId = parts[1];

    const btn = $('vkr-send-comment-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Отправка...';

    try {
      const res = await sendMessage('create_comment', {
        ownerId, postId, text: randomText, token: account.token
      });
      
      if (res.ok) {
        $('vkr-comment-status').innerHTML = `<span style="color:#34c759">✅ Отправлено: "${randomText}"</span>`;
        setTimeout(() => {
          commentModalEl.style.display = 'none';
          $('vkr-comment-status').innerHTML = '';
          btn.disabled = false;
          btn.textContent = '🚀 Отправить случайную фразу';
        }, 2000);
      } else {
        throw new Error(res.error);
      }
    } catch(e) {
      $('vkr-comment-status').innerHTML = `<span style="color:#ef5350">❌ Ошибка: ${e.message}</span>`;
      btn.disabled = false;
      btn.textContent = '🚀 Повторить';
    }
  };
}

// ========== BEST POSTS FEATURE ==========
function detectCurrentPage() {
  const url = window.location.href;
  
  const clubMatch = url.match(/vk\.com\/club(\d+)/);
  const publicMatch = url.match(/vk\.com\/public(\d+)/);
  const eventMatch = url.match(/vk\.com\/event(\d+)/);
  
  if (clubMatch) return { type: 'group', id: -parseInt(clubMatch[1]) };
  if (publicMatch) return { type: 'group', id: -parseInt(publicMatch[1]) };
  if (eventMatch) return { type: 'group', id: -parseInt(eventMatch[1]) };
  
  const shortNameMatch = url.match(/vk\.com\/([a-zA-Z0-9_]+)$/);
  if (shortNameMatch && shortNameMatch[1] !== 'feed' && shortNameMatch[1] !== 'im') {
    return { type: 'shortname', name: shortNameMatch[1] };
  }
  
  const groupIdEl = document.querySelector('[data-group-id]');
  if (groupIdEl) {
    const gid = groupIdEl.getAttribute('data-group-id');
    return { type: 'group', id: -parseInt(gid) };
  }
  
  return null;
}

function createFAB() {
  const pageInfo = detectCurrentPage();
  if (!pageInfo) return;
  
  if (document.querySelector('.vkr-fab')) return;
  
  const fab = document.createElement('button');
  fab.className = 'vkr-fab';
  fab.innerHTML = '🔥';
  fab.title = 'Лучшие посты';
  
  // ДОБАВЛЕНЫ СТИЛИ ДЛЯ КНОПКИ ЛУЧШИХ ПОСТОВ
  fab.style.cssText = `
    position: fixed;
    bottom: 80px;
    right: 20px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ff6b35, #e64646);
    border: none;
    color: white;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(230, 70, 70, 0.4);
    z-index: 9998;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.3s ease;
  `;
  
  fab.onclick = async () => {
    await openBestPostsModal(pageInfo);
  };
  
  document.body.appendChild(fab);
}

async function openBestPostsModal(pageInfo) {
  const d = await chrome.storage.local.get(['vk_token']);
  if (!d.vk_token) {
    alert('❌ Сначала авторизуйтесь! Откройте расширение через иконку в панели браузера.');
    return;
  }
  tok = d.vk_token;
  
  if (pageInfo.type === 'shortname') {
    try {
      const response = await sendMessage('resolve_screen_name', { screenName: pageInfo.name, token: tok });
      if (response.objectType === 'group') {
        currentOwnerId = -response.objectId;
      } else if (response.objectType === 'user') {
        currentOwnerId = response.objectId;
      } else {
        alert('❌ Это не группа и не пользователь');
        return;
      }
    } catch (e) {
      alert('❌ Не удалось определить ID: ' + e.message);
      return;
    }
  } else {
    currentOwnerId = pageInfo.id;
  }
  
  if (!bestPostsModalEl) {
    createBestPostsModal();
  }
  
  const settings = await chrome.storage.local.get('vkr_best_posts_settings');
  if (settings.vkr_best_posts_settings) {
    applyBestPostsSettings(settings.vkr_best_posts_settings);
  }
  
  bestPostsModalEl.style.display = 'flex';
  bestPostsModalEl.querySelector('#vkr-bp-search-view').style.display = 'block';
  bestPostsModalEl.querySelector('#vkr-bp-results-view').style.display = 'none';
}

function createBestPostsModal() {
  const html = `
<div id="vkr-best-posts-overlay" style="display:none; z-index: 999999; pointer-events: auto; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.75); align-items: center; justify-content: center; backdrop-filter: blur(4px);">
  <div id="vkr-best-posts-modal" style="background: #1e1e2e; border-radius: 16px; width: 90%; max-width: 700px; max-height: 90vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);">
    <div id="vkr-bp-search-view">
      <div class="vkr-bp-header" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #2a2a4a, #1e1e2e); border-bottom: 1px solid #3a3a5a; font-size: 18px; font-weight: 600; color: #fff;">
        <span>🔥 Лучшие посты</span><button class="vkr-bp-close" style="background: none; border: none; color: #999; font-size: 24px; cursor: pointer;">✕</button>
      </div>
      <div class="vkr-bp-body" style="padding: 20px; overflow-y: auto; color: #aaa;">
        <div class="vkr-bp-section" style="margin-bottom: 20px;">
          <div class="vkr-bp-label" style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">📌 Паблик</div>
          <div class="vkr-bp-owner-info" style="color: #5181b8; font-size: 14px;">ID: <span id="vkr-bp-owner-id">-</span></div>
        </div>
        <div class="vkr-bp-section" style="margin-bottom: 20px;">
          <div class="vkr-bp-label" style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">📅 Период</div>
          <div style="display: flex; gap: 12px; margin-bottom: 12px;">
            <div style="flex: 1; display: flex; align-items: center; gap: 8px;"><label>С:</label><input type="text" id="vkr-bp-date-from" placeholder="ДД.ММ.ГГГГ" maxlength="10" style="flex: 1; background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 8px; padding: 8px 12px; color: #fff; font-size: 14px;"></div>
            <div style="flex: 1; display: flex; align-items: center; gap: 8px;"><label>По:</label><input type="text" id="vkr-bp-date-to" placeholder="ДД.ММ.ГГГГ" maxlength="10" style="flex: 1; background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 8px; padding: 8px 12px; color: #fff; font-size: 14px;"></div>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button class="vkr-bp-chip" data-days="7" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 16px; padding: 6px 12px; color: #aaa; font-size: 13px; cursor: pointer;">Неделя</button>
            <button class="vkr-bp-chip" data-days="30" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 16px; padding: 6px 12px; color: #aaa; font-size: 13px; cursor: pointer;">Месяц</button>
            <button class="vkr-bp-chip" data-days="90" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 16px; padding: 6px 12px; color: #aaa; font-size: 13px; cursor: pointer;">3 месяца</button>
            <button class="vkr-bp-chip" data-days="180" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 16px; padding: 6px 12px; color: #aaa; font-size: 13px; cursor: pointer;">6 месяцев</button>
            <button class="vkr-bp-chip" data-days="365" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 16px; padding: 6px 12px; color: #aaa; font-size: 13px; cursor: pointer;">Год</button>
            <button class="vkr-bp-chip" data-days="3650" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 16px; padding: 6px 12px; color: #aaa; font-size: 13px; cursor: pointer;">Всё время</button>
          </div>
        </div>
        <div class="vkr-bp-section" style="margin-bottom: 20px;">
          <div class="vkr-bp-label" style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">📊 Сортировка</div>
          <div style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
            <button class="vkr-bp-sort-btn active" data-metric="likes" style="background: #5181b8; border: 1px solid #5181b8; border-radius: 8px; padding: 8px 16px; color: #fff; font-size: 14px; cursor: pointer;">❤️ Лайки</button>
            <button class="vkr-bp-sort-btn" data-metric="views" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 8px; padding: 8px 16px; color: #aaa; font-size: 14px; cursor: pointer;">👁 Просмотры</button>
            <button class="vkr-bp-sort-btn" data-metric="reposts" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 8px; padding: 8px 16px; color: #aaa; font-size: 14px; cursor: pointer;">🔄 Репосты</button>
            <button class="vkr-bp-sort-btn" data-metric="comments" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 8px; padding: 8px 16px; color: #aaa; font-size: 14px; cursor: pointer;">💬 Комменты</button>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;"><label>Мин. значение:</label><input type="number" id="vkr-bp-min-value" placeholder="0" min="0" style="flex: 1; background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 8px; padding: 8px 12px; color: #fff; font-size: 14px;"></div>
        </div>
        <div class="vkr-bp-section" style="margin-bottom: 20px;">
          <div class="vkr-bp-label" style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">📦 Загрузить постов</div>
          <input type="number" id="vkr-bp-count" value="50" min="10" max="300" step="10" style="width: 100%; background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 8px; padding: 8px 12px; color: #fff; font-size: 14px;">
        </div>
        <div class="vkr-bp-section">
          <div class="vkr-bp-filters">
            <label style="display:flex; gap:8px;"><input type="checkbox" id="vkr-bp-only-photo"> Только с фото</label>
            <label style="display:flex; gap:8px;"><input type="checkbox" id="vkr-bp-only-video"> Только с видео</label>
            <label style="display:flex; gap:8px;"><input type="checkbox" id="vkr-bp-no-reposts"> Без репостов</label>
          </div>
        </div>
      </div>
      <div class="vkr-bp-footer" style="padding: 16px 20px; border-top: 1px solid #3a3a5a; display: flex; justify-content: center;">
        <button id="vkr-bp-search" style="background: linear-gradient(135deg, #5181b8, #4a76a8); border: none; border-radius: 8px; padding: 12px 24px; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer;">🔍 Найти лучшие посты</button>
      </div>
    </div>
    
    <div id="vkr-bp-results-view" style="display:none; color: #aaa;">
      <div class="vkr-bp-header" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #2a2a4a, #1e1e2e); border-bottom: 1px solid #3a3a5a; font-size: 18px; font-weight: 600; color: #fff;">
        <span>🔥 Лучшие посты</span><button class="vkr-bp-close" style="background: none; border: none; color: #999; font-size: 24px; cursor: pointer;">✕</button>
      </div>
      <div style="padding: 16px 20px; border-bottom: 1px solid #3a3a5a; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <button id="vkr-bp-back" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 8px; padding: 8px 16px; color: #aaa; font-size: 14px; cursor: pointer;">← Назад</button>
        <div id="vkr-bp-results-count">Найдено: 0</div>
        <label class="vkr-bp-select-all-label" style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="vkr-bp-select-all-results"><span>Выбрать все</span>
        </label>
      </div>
      <div id="vkr-bp-progress" style="display:none; padding: 20px; text-align: center;">
        <div style="margin-bottom: 12px;">⏳ Загрузка постов...</div>
        <div style="width: 100%; height: 8px; background: #2a2a4a; border-radius: 4px; overflow: hidden; margin-bottom: 12px;"><div id="vkr-bp-progress-bar" style="height: 100%; background: #5181b8; width: 0%;"></div></div>
        <div id="vkr-bp-progress-info" style="margin-bottom: 12px;">Загружено: 0 постов</div>
        <button id="vkr-bp-stop" style="background: #e64646; border: none; border-radius: 8px; padding: 8px 16px; color: #fff; cursor: pointer;">Остановить</button>
      </div>
      <div id="vkr-bp-results-list" style="padding: 20px; overflow-y: auto; max-height: 60vh;"></div>
      <div class="vkr-bp-footer" id="vkr-bp-mass-repost-footer" style="display:none; padding: 16px 20px; border-top: 1px solid #3a3a5a; display: flex; justify-content: space-between; align-items: center;">
        <div id="vkr-bp-selected-count">Выбрано: 0 постов</div>
        <button id="vkr-bp-mass-repost" style="background: linear-gradient(135deg, #5181b8, #4a76a8); border: none; border-radius: 8px; padding: 12px 24px; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer;">📋 Репост выбранных</button>
      </div>
    </div>
  </div>
</div>`;
  const container = document.createElement('div');
  container.innerHTML = html;
  bestPostsModalEl = container.firstElementChild;
  document.body.appendChild(bestPostsModalEl);
  
  bindBestPostsEvents();
}

function bindBestPostsEvents() {
  const $ = (id) => bestPostsModalEl.querySelector('#' + id);
  
  bestPostsModalEl.querySelectorAll('.vkr-bp-close').forEach(btn => {
    btn.onclick = () => { bestPostsModalEl.style.display = 'none'; isLoadingPosts = false; };
  });
  
  bestPostsModalEl.onclick = (e) => {
    if (e.target === bestPostsModalEl) { bestPostsModalEl.style.display = 'none'; isLoadingPosts = false; }
  };
  
  bestPostsModalEl.querySelectorAll('.vkr-bp-chip').forEach(chip => {
    chip.onclick = () => {
      const days = parseInt(chip.dataset.days);
      const now = new Date();
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      $('vkr-bp-date-from').value = formatDate(from);
      $('vkr-bp-date-to').value = formatDate(now);
    };
  });
  
  bestPostsModalEl.querySelectorAll('.vkr-bp-sort-btn').forEach(btn => {
    btn.onclick = () => {
      bestPostsModalEl.querySelectorAll('.vkr-bp-sort-btn').forEach(b => {
        b.classList.remove('active'); b.style.background = '#2a2a4a'; b.style.color = '#aaa'; b.style.borderColor = '#3a3a5a';
      });
      btn.classList.add('active'); btn.style.background = '#5181b8'; btn.style.color = '#fff'; btn.style.borderColor = '#5181b8';
    };
  });
  
  $('vkr-bp-search').onclick = () => searchBestPosts();
  $('vkr-bp-back').onclick = () => { $('vkr-bp-search-view').style.display = 'block'; $('vkr-bp-results-view').style.display = 'none'; };
  $('vkr-bp-stop').onclick = () => { isLoadingPosts = false; };
  
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  $('vkr-bp-date-from').value = formatDate(monthAgo);
  $('vkr-bp-date-to').value = formatDate(now);
  $('vkr-bp-owner-id').textContent = currentOwnerId || '-';
}

async function searchBestPosts() {
  const $ = (id) => bestPostsModalEl.querySelector('#' + id);
  const settings = {
    dateFrom: $('vkr-bp-date-from').value,
    dateTo: $('vkr-bp-date-to').value,
    metric: bestPostsModalEl.querySelector('.vkr-bp-sort-btn.active').dataset.metric,
    minValue: parseInt($('vkr-bp-min-value').value) || 0,
    count: parseInt($('vkr-bp-count').value) || 50,
    onlyPhoto: $('vkr-bp-only-photo').checked,
    onlyVideo: $('vkr-bp-only-video').checked,
    noReposts: $('vkr-bp-no-reposts').checked
  };
  
  await chrome.storage.local.set({ vkr_best_posts_settings: settings });
  
  const dateFrom = parseDate($('vkr-bp-date-from').value);
  const dateTo = parseDate($('vkr-bp-date-to').value);
  
  if (!dateFrom || !dateTo) return alert('❌ Укажите корректные даты');
  if (dateFrom > dateTo) return alert('❌ Дата "С" должна быть раньше даты "По"');
  
  $('vkr-bp-search-view').style.display = 'none';
  $('vkr-bp-results-view').style.display = 'block';
  $('vkr-bp-progress').style.display = 'block';
  $('vkr-bp-results-list').innerHTML = '';
  
  loadedPosts = [];
  isLoadingPosts = true;
  const maxCount = settings.count;
  let offset = 0;
  let totalRequests = 0;
  const dateFromUnix = Math.floor(dateFrom / 1000);
  const dateToUnix = Math.floor(dateTo / 1000);
  
  try {
    while (isLoadingPosts) {
      const response = await sendMessage('search_best_posts', {
        ownerId: currentOwnerId, dateFrom: dateFromUnix, dateTo: dateToUnix, count: 100, offset, token: tok
      });
      
      totalRequests++;
      if (!response.posts || response.posts.length === 0) break;
      
      loadedPosts.push(...response.posts);
      
      const lastPostDate = response.posts[response.posts.length - 1].date;
      const progress = Math.min(100, Math.round((loadedPosts.length / maxCount) * 100));
      $('vkr-bp-progress-bar').style.width = progress + '%';
      $('vkr-bp-progress-info').textContent = `Загружено: ${loadedPosts.length} постов в периоде`;
      
      if (lastPostDate < dateFromUnix || !response.hasMore || totalRequests >= 30) break;
      offset += 100;
      await sleep(400);
    }
    
    isLoadingPosts = false;
    $('vkr-bp-progress').style.display = 'none';
    
    let filtered = filterPosts(loadedPosts, settings, dateFromUnix, dateToUnix);
    filtered = sortPosts(filtered, settings.metric).slice(0, maxCount);
    renderResults(filtered, settings.metric);
    
  } catch (e) {
    alert('❌ Ошибка: ' + e.message);
    $('vkr-bp-progress').style.display = 'none';
  }
}

function filterPosts(posts, settings, dateFrom, dateTo) {
  return posts.filter(post => {
    if (dateFrom && dateTo && (post.date < dateFrom || post.date > dateTo)) return false;
    let value = 0;
    if (settings.metric === 'likes') value = post.likes?.count || 0;
    else if (settings.metric === 'views') value = post.views?.count || 0;
    else if (settings.metric === 'reposts') value = post.reposts?.count || 0;
    else if (settings.metric === 'comments') value = post.comments?.count || 0;
    
    if (value < settings.minValue) return false;
    if (settings.onlyPhoto && (!post.attachments || !post.attachments.some(a => a.type === 'photo'))) return false;
    if (settings.onlyVideo && (!post.attachments || !post.attachments.some(a => a.type === 'video'))) return false;
    if (settings.noReposts && post.copy_history) return false;
    return true;
  });
}

function sortPosts(posts, metric) {
  return posts.sort((a, b) => {
    let aVal = 0, bVal = 0;
    if (metric === 'likes') { aVal = a.likes?.count || 0; bVal = b.likes?.count || 0; }
    else if (metric === 'views') { aVal = a.views?.count || 0; bVal = b.views?.count || 0; }
    else if (metric === 'reposts') { aVal = a.reposts?.count || 0; bVal = b.reposts?.count || 0; }
    else if (metric === 'comments') { aVal = a.comments?.count || 0; bVal = b.comments?.count || 0; }
    return bVal - aVal;
  });
}

function renderResults(posts, metric) {
  const list = bestPostsModalEl.querySelector('#vkr-bp-results-list');
  bestPostsModalEl.querySelector('#vkr-bp-results-count').textContent = `Найдено: ${posts.length} постов`;
  
  if (posts.length === 0) {
    list.innerHTML = '<div style="text-align: center; color: #666;">Постов не найдено</div>';
    return;
  }
  
  let html = '';
  posts.forEach((post, index) => {
    const postUrl = `https://vk.com/wall${post.owner_id}_${post.id}`;
    const date = new Date(post.date * 1000);
    const text = (post.text || '[Без текста]').substring(0, 200);
    let photoHtml = '';
    
    if (post.attachments) {
      const photo = post.attachments.find(a => a.type === 'photo');
      if (photo) {
        const sizes = photo.photo.sizes || [];
        const thumb = sizes.find(s => s.type === 'm') || sizes[0];
        if (thumb) {
          photoHtml = `<img src="${thumb.url}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px; flex-shrink: 0;">`;
        }
      }
    }
    
    html += `
      <div style="background: #2a2a4a; border: 1px solid ${index < 3 ? '#ffd700' : '#3a3a5a'}; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
          <span style="color: #aaa; font-weight: 600;">#${index + 1}</span>
          <span style="color: #666; font-size: 13px;">📅 ${formatDate(date)}</span>
        </div>
        <div style="display: flex; gap: 12px; margin-bottom: 12px;">
          ${photoHtml}<div style="color: #ccc; font-size: 14px; line-height: 1.5; flex: 1;">${esc(text)}</div>
        </div>
        <div style="display: flex; gap: 16px; margin-bottom: 12px; padding: 8px 0; border-top: 1px solid #3a3a5a; border-bottom: 1px solid #3a3a5a; color: #aaa; font-size: 13px;">
          <span>❤️ ${formatNumber(post.likes?.count || 0)}</span><span>👁 ${formatNumber(post.views?.count || 0)}</span><span>🔄 ${formatNumber(post.reposts?.count || 0)}</span><span>💬 ${formatNumber(post.comments?.count || 0)}</span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="vkr-bp-post-repost" data-post-url="${postUrl}" style="flex: 1; background: #5181b8; border: none; border-radius: 8px; padding: 8px 16px; color: #fff; cursor: pointer;">📋 Репост</button>
          <a href="${postUrl}" target="_blank" style="background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 8px; padding: 8px 16px; color: #aaa; text-decoration: none;">🔗 Открыть</a>
        </div>
      </div>
    `;
  });
  
  list.innerHTML = html;
  
  list.querySelectorAll('.vkr-bp-post-repost').forEach(btn => {
    btn.onclick = async () => {
      bestPostsModalEl.style.display = 'none';
      await openModal(btn.dataset.postUrl);
    };
  });
}

function applyBestPostsSettings(settings) {
  const $ = (id) => bestPostsModalEl.querySelector('#' + id);
  if (settings.dateFrom) $('vkr-bp-date-from').value = settings.dateFrom;
  if (settings.dateTo) $('vkr-bp-date-to').value = settings.dateTo;
  if (settings.minValue) $('vkr-bp-min-value').value = settings.minValue;
  if (settings.count) $('vkr-bp-count').value = settings.count;
  if (settings.onlyPhoto) $('vkr-bp-only-photo').checked = true;
  if (settings.onlyVideo) $('vkr-bp-only-video').checked = true;
  if (settings.noReposts) $('vkr-bp-no-reposts').checked = true;
  if (settings.metric) {
    bestPostsModalEl.querySelectorAll('.vkr-bp-sort-btn').forEach(btn => { 
      if(btn.dataset.metric === settings.metric) {
        btn.classList.add('active'); btn.style.background = '#5181b8'; btn.style.color = '#fff'; btn.style.borderColor = '#5181b8';
      } else {
        btn.classList.remove('active'); btn.style.background = '#2a2a4a'; btn.style.color = '#aaa'; btn.style.borderColor = '#3a3a5a';
      }
    });
  }
}

function formatNumber(n) { return n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function formatDate(date) { const d = date instanceof Date ? date : new Date(date); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; }
function parseDate(str) { const parts = str.split('.'); if (parts.length !== 3) return null; const date = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])); return isNaN(date.getTime()) ? null : date.getTime(); }

// Инициализация FAB при загрузке
setTimeout(() => { createFAB(); }, 2000);
const urlObserver = new MutationObserver(() => {
  if (window.location.href !== urlObserver.lastUrl) {
    urlObserver.lastUrl = window.location.href;
    setTimeout(createFAB, 1000);
  }
});
urlObserver.lastUrl = window.location.href;
urlObserver.observe(document.documentElement, { childList: true, subtree: true });