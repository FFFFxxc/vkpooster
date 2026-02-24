// КРИТИЧЕСКИЕ ИСПРАВЛЕНИЯ для content-modal.js
// Применить эти изменения к существующему файлу

// ========== 1. SHADOW DOM ИЗОЛЯЦИЯ ==========
// Заменить функцию createModal()

function createModal() {
  // Создаём host для Shadow DOM
  const host = document.createElement('div');
  host.id = 'vkr-shadow-host';
  document.body.appendChild(host);
  
  // Создаём Shadow DOM
  const shadow = host.attachShadow({ mode: 'open' });
  
  // Загружаем CSS
  const style = document.createElement('style');
  style.textContent = `
    /* Вставить сюда весь CSS из modal.css и content.css */
    /* Или загрузить через fetch */
  `;
  shadow.appendChild(style);
  
  // Создаём модальное окно
  const modalContainer = document.createElement('div');
  modalContainer.innerHTML = `
    <!-- Весь HTML модалки -->
  `;
  
  modalEl = modalContainer.firstElementChild;
  shadow.appendChild(modalEl);
  
  // Привязываем обработчики
  bindModalEvents();
}

// ========== 2. MUTATION OBSERVER С DEBOUNCE ==========
// Заменить в конце файла

let debounceTimeout;
const observer = new MutationObserver((mutations) => {
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (
          node.matches &&
          (node.matches('[data-post-id]') ||
            node.matches('div[id^="post-"]') ||
            node.matches('article[data-post-id]') ||
            node.matches('.post') ||
            node.matches('.wall_item') ||
            node.matches('.feed_row') ||
            node.matches('.Post'))
        ) {
          processPosts(node.parentElement || document);
        } else if (node.querySelectorAll) {
          processPosts(node);
        }
      });
    }
  }, 500); // Debounce 500ms
});

processPosts();
setTimeout(processPosts, 1500);
observer.observe(document.documentElement, { childList: true, subtree: true });

// ========== 3. РАНДОМНАЯ ЗАДЕРЖКА ==========
// Заменить функцию sleep()

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min = 3000, max = 7000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(delay);
}

// В функции sendToGroups() заменить:
// if (completed < total) await sleep(2500);
// НА:
// if (completed < total) await randomDelay(3000, 7000);

// ========== 4. УЛУЧШЕННАЯ ОБРАБОТКА ОШИБОК ==========
// Добавить в функцию sendMessage()

async function sendMessage(type, data) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.ok) {
        resolve(response);
      } else {
        // Проверяем код ошибки ВК
        const errorMsg = response?.error || 'Unknown error';
        
        if (errorMsg.includes('Auth failed') || errorMsg.includes('invalid access_token')) {
          // Токен протух
          showCustomAlert('❌ Токен недействителен. Пожалуйста, авторизуйтесь заново через расширение.');
          chrome.storage.local.remove('vk_token');
        }
        
        reject(new Error(errorMsg));
      }
    });
  });
}

// ========== 5. PNG vs JPEG для водяных знаков ==========
// Заменить в функции applyWatermarkToPhoto()

// Определяем формат по исходному изображению
const format = photoUrl.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg';
const quality = format === 'image/jpeg' ? 0.95 : 1.0;

// Конвертируем в data URL
const resultDataUrl = canvas.toDataURL(format, quality);
resolve(resultDataUrl);

// ========== 6. DRAGGABLE MODAL (ОПЦИОНАЛЬНО) ==========
// Добавить в bindModalEvents()

function makeDraggable() {
  const header = modalEl.querySelector('#vkr-modal-header');
  const modal = modalEl.querySelector('#vkr-modal');
  
  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;
  
  header.style.cursor = 'move';
  
  header.addEventListener('mousedown', dragStart);
  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', dragEnd);
  
  function dragStart(e) {
    if (e.target.closest('button')) return; // Не тащим если кликнули на кнопку
    
    initialX = e.clientX - xOffset;
    initialY = e.clientY - yOffset;
    
    isDragging = true;
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
    isDragging = false;
  }
}

// Вызвать в конце bindModalEvents()
makeDraggable();

// ========== 7. ОПТИМИЗАЦИЯ РАЗМЕРА СООБЩЕНИЙ ==========
// Добавить проверку размера перед отправкой

function estimateMessageSize(data) {
  return JSON.stringify(data).length;
}

// В sendToGroups() перед отправкой:
const messageSize = estimateMessageSize({
  post,
  groups: [gid],
  mode,
  text: txt,
  pubDate,
  processedPhotos,
  autoDeleteAfter,
  token: tok
});

console.log('[VKR] Message size:', (messageSize / 1024 / 1024).toFixed(2), 'MB');

if (messageSize > 50 * 1024 * 1024) { // 50MB предупреждение
  console.warn('[VKR] Message size is large, may fail!');
  setStatus('⚠️ Размер данных большой, возможны ошибки...', 'warning');
}

// ========== 8. ЗАГРУЗКА CSS В SHADOW DOM ==========
// Функция для загрузки CSS

async function loadCSS() {
  try {
    const modalCssUrl = chrome.runtime.getURL('modal.css');
    const contentCssUrl = chrome.runtime.getURL('content.css');
    
    const [modalCss, contentCss] = await Promise.all([
      fetch(modalCssUrl).then(r => r.text()),
      fetch(contentCssUrl).then(r => r.text())
    ]);
    
    return modalCss + '\n' + contentCss;
  } catch (e) {
    console.error('[VKR] Failed to load CSS:', e);
    return '';
  }
}

// Использовать в createModal():
const cssText = await loadCSS();
style.textContent = cssText;
