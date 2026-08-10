/**
 * VK Reposter Pro - Shadow DOM Modal
 * Modern Glassmorphism Design
 */

let shadowHost = null;
let shadowRoot = null;

async function createShadowModal() {
  if (document.getElementById("vkr-shadow-host")) {
    return document.getElementById("vkr-shadow-host").shadowRoot;
  }

  shadowHost = document.createElement("div");
  shadowHost.id = "vkr-shadow-host";
  shadowHost.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 999999;
  `;
  document.body.appendChild(shadowHost);

  shadowRoot = shadowHost.attachShadow({ mode: "open" });

  const cssText = await loadCSS();
  const style = document.createElement("style");
  style.textContent = cssText;
  shadowRoot.appendChild(style);

  const modalContainer = document.createElement("div");
  modalContainer.innerHTML = getModalHTML();
  shadowRoot.appendChild(modalContainer);

  return shadowRoot;
}

async function loadCSS() {
  try {
    // Проверяем контекст до обращения к chrome API
    if (!chrome?.runtime?.id) {
      console.warn("[VKR] Extension context invalidated, skipping CSS load");
      return "";
    }
    const modalCssUrl = chrome.runtime.getURL("modal.css");
    return await fetch(modalCssUrl).then((r) => r.text());
  } catch (e) {
    if (e.message?.includes("Extension context invalidated")) {
      console.warn("[VKR] CSS load skipped: extension context invalidated");
    } else {
      console.error("[VKR] Failed to load CSS:", e);
    }
    return "";
  }
}

function getModalHTML() {
  return `
<!-- Main Repost Modal -->
<div id="vkr-modal-overlay" style="display:none; pointer-events: auto;">
  <div id="vkr-modal">
    <div id="vkr-modal-header">
      <span>📋 VK Reposter Pro</span>
      <div class="vkr-header-buttons" style="display: flex; gap: 8px; align-items: center; margin-left: auto;">
        <button id="vkr-minimize" title="Свернуть">🗕</button>
        <button id="vkr-close" style="margin-left: 0;">✕</button>
      </div>
    </div>

    <div id="vkr-modal-body">
      <!-- Preview Section -->
      <div id="vkr-preview">
        <div class="vkr-section-title">📷 Превью поста</div>
        <div id="vkr-post-content"></div>
      </div>

      <!-- Settings Section -->
      <div id="vkr-settings">
        <!-- Tabs -->
        <div class="vkr-tabs">
          <button class="vkr-tab active" data-tab="main">Основное</button>
          <button class="vkr-tab" data-tab="schedule">Отложка</button>
          <button class="vkr-tab" data-tab="hidden">Скрытые</button>
        </div>

        <!-- Main Tab -->
        <div id="vkr-tab-main" class="vkr-tab-content active">
          <!-- Mode -->
          <div class="vkr-section">
            <div class="vkr-section-title">📝 Режим публикации</div>
            <div class="vkr-mode-toggle">
              <button class="vkr-mode-btn active" data-mode="copy">📋 Копия</button>
              <button class="vkr-mode-btn" data-mode="repost">🔄 Репост</button>
            </div>
          </div>

          <!-- Text -->
          <div class="vkr-section" id="vkr-text-section">
            <div class="vkr-section-title">✏️ Текст поста</div>
            <textarea id="vkr-post-text" placeholder="Введите текст или оставьте пустым..."></textarea>
          </div>

          <!-- Autocomment (перемещено в основную вкладку) -->
          <div class="vkr-section">
            <div class="vkr-section-title">💬 Автокомментарий</div>
            <label class="vkr-checkbox">
              <input type="checkbox" id="vkr-autocomment">
              <span>Добавить комментарий после публикации</span>
            </label>
            <div id="vkr-autocomment-settings" style="display: none; margin-top: 10px;">
              <textarea id="vkr-autocomment-text" placeholder="Введите текст комментария..." style="width: 100%; min-height: 60px; padding: 12px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md); color: var(--vkr-text-primary); font-family: inherit; font-size: 13px; resize: vertical; margin-bottom: 8px;"></textarea>
              <div style="display: flex; gap: 8px; align-items: center;">
                <select id="vkr-autocomment-template" style="flex: 1; padding: 8px 12px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md); color: var(--vkr-text-primary); font-size: 13px; outline: none; cursor: pointer; height: 36px; -webkit-appearance: none; -moz-appearance: none; appearance: none; background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23a5b4c7%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 12px top 50%25; background-size: 8px auto; padding-right: 30px;">
                  <option value="">Выбрать заготовку...</option>
                </select>
                <button id="vkr-autocomment-save-template" title="Сохранить как заготовку" style="background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md); color: var(--vkr-text-primary); padding: 8px 12px; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; height: 36px; transition: all var(--vkr-transition-base);">💾</button>
                <button id="vkr-autocomment-delete-template" title="Удалить выбранную заготовку" style="background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md); color: var(--vkr-text-primary); padding: 8px 12px; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; height: 36px; transition: all var(--vkr-transition-base);">🗑️</button>
              </div>
            </div>
          </div>

          <!-- Watermark -->
          <div class="vkr-section" id="vkr-watermark-section">
            <div class="vkr-section-title">💧 Водяной знак</div>
            <label class="vkr-checkbox">
              <input type="checkbox" id="vkr-watermark-enabled">
              <span>Добавить водяной знак на фото</span>
            </label>
            <div id="vkr-watermark-settings" style="display: none; margin-top: 10px;">
              <select id="vkr-watermark-list" style="width: 100%; padding: 10px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md); color: var(--vkr-text-primary); margin-bottom: 10px;">
                <option value="">Выберите водяной знак...</option>
              </select>
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <label style="font-size: 12px; color: var(--vkr-text-secondary); min-width: 100px;">Прозрачность:</label>
                <input type="range" id="vkr-watermark-opacity" min="10" max="100" value="70" style="flex: 1;">
                <span id="vkr-opacity-value" style="font-size: 12px; color: var(--vkr-accent); min-width: 40px;">70%</span>
              </div>
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <label style="font-size: 12px; color: var(--vkr-text-secondary); min-width: 100px;">Размер:</label>
                <input type="range" id="vkr-watermark-size" min="10" max="50" value="20" style="flex: 1;">
                <span id="vkr-size-value" style="font-size: 12px; color: var(--vkr-accent); min-width: 40px;">20%</span>
              </div>
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                <label style="font-size: 12px; color: var(--vkr-text-secondary); min-width: 100px;">Позиция:</label>
                <select id="vkr-watermark-position" style="flex: 1; padding: 8px; background: var(--vkr-bg-secondary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-sm); color: var(--vkr-text-primary);">
                  <option value="bottom-right">Нижний правый</option>
                  <option value="bottom-left">Нижний левый</option>
                  <option value="top-right">Верхний правый</option>
                  <option value="top-left">Верхний левый</option>
                  <option value="center">Центр</option>
                </select>
              </div>
              <div id="vkr-watermark-preview" style="display: none;">
                <canvas id="vkr-watermark-canvas" style="width: 100%; border-radius: var(--vkr-radius-md);"></canvas>
              </div>
              <div style="display: flex; gap: 8px; margin-top: 10px;">
                <button id="vkr-watermark-upload" class="vkr-mode-btn" style="flex: 1;">📤 Загрузить PNG</button>
                <button id="vkr-watermark-manage" class="vkr-mode-btn" style="flex: 1;">⚙️ Управление</button>
              </div>
            </div>
          </div>

          <!-- Groups -->
          <div class="vkr-section">
            <div class="vkr-section-title" style="display: flex; align-items: center; gap: 10px;">
              📢 Группы
              <span id="vkr-group-count" style="font-size: 11px; color: var(--vkr-accent); background: rgba(99, 102, 241, 0.15); padding: 2px 8px; border-radius: 10px;">0 выбрано</span>
              <button id="vkr-delete-mode" style="margin-left: auto; padding: 4px 10px; background: transparent; border: 1px solid var(--vkr-border); border-radius: 6px; color: var(--vkr-text-muted); font-size: 11px; cursor: pointer;">🗑️ Скрыть</button>
            </div>

            <div class="vkr-group-sets">
              <div class="vkr-group-sets-head">
                <div class="vkr-group-sets-heading">
                  <strong>⚡ Наборы пабликов</strong>
                  <span>Сохрани выбор и включай его одним нажатием</span>
                </div>
                <button type="button" id="vkr-group-set-new">＋ Сохранить выбор</button>
              </div>
              <div id="vkr-group-sets-list" class="vkr-group-sets-list"></div>
              <div id="vkr-group-set-editor" class="vkr-group-set-editor" hidden>
                <label for="vkr-group-set-name">Название набора</label>
                <input type="text" id="vkr-group-set-name" maxlength="48" placeholder="Например, Группа 1" autocomplete="off">
                <div id="vkr-group-set-meta" class="vkr-group-set-meta">Будут сохранены отмеченные паблики</div>
                <div class="vkr-group-set-editor-actions">
                  <button type="button" id="vkr-group-set-save">Сохранить набор</button>
                  <button type="button" id="vkr-group-set-delete" hidden>Удалить</button>
                  <button type="button" id="vkr-group-set-cancel">Отмена</button>
                </div>
              </div>
            </div>

            <input type="text" id="vkr-search" placeholder="🔍 Поиск групп...">
            <div class="vkr-group-actions">
              <button id="vkr-select-all"><svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" width="14" height="14" style="vertical-align: middle; margin-right: 4px; display: inline-block;"><defs><linearGradient x1="3.879" y1="3.879" x2="20.121" y2="20.121" gradientUnits="userSpaceOnUse" id="color-1_u6c3jH8492CC_gr1"><stop offset="0" stop-color="#9bff04"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0.3"></stop></linearGradient><linearGradient x1="3.879" y1="3.879" x2="20.121" y2="20.121" gradientUnits="userSpaceOnUse" id="color-2_u6c3jH8492CC_gr2"><stop offset="0" stop-color="#9bff04"></stop><stop offset="0.493" stop-color="#ffffff" stop-opacity="0"></stop><stop offset="0.997" stop-color="#ffffff" stop-opacity="0.3"></stop></linearGradient><linearGradient x1="12.293" y1="6.293" x2="16.707" y2="10.707" gradientUnits="userSpaceOnUse" id="color-3_u6c3jH8492CC_gr3"><stop offset="0" stop-color="#ffffff" stop-opacity="0.7"></stop><stop offset="0.519" stop-color="#ffffff" stop-opacity="0.45"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0.55"></stop></linearGradient></defs><g fill="none" fill-rule="nonzero" stroke="none" stroke-width="1" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10" stroke-dasharray="" stroke-dashoffset="0" font-family="none" font-weight="none" font-size="none" text-anchor="none" style="mix-blend-mode: normal"><g transform="scale(10.66667,10.66667)"><path d="M18,21h-12c-1.657,0 -3,-1.343 -3,-3v-12c0,-1.657 1.343,-3 3,-3h12c1.657,0 3,1.343 3,3v12c0,1.657 -1.343,3 -3,3z" fill="url(#color-1_u6c3jH8492CC_gr1)"></path><path d="M18,3.5c1.379,0 2.5,1.122 2.5,2.5v12c0,1.378 -1.121,2.5 -2.5,2.5h-12c-1.379,0 -2.5,-1.122 -2.5,-2.5v-12c0,-1.378 1.121,-2.5 2.5,-2.5h12M18,3h-12c-1.657,0 -3,1.343 -3,3v12c0,1.657 1.343,3 3,3h12c1.657,0 3,-1.343 3,-3v-12c0,-1.657 -1.343,-3 -3,-3z" fill="url(#color-2_u6c3jH8492CC_gr2)"></path><path d="M11,16c-0.256,0 -0.512,-0.098 -0.707,-0.293l-3,-3c-0.391,-0.391 -0.391,-1.023 0,-1.414c0.391,-0.391 1.023,-0.391 1.414,0l2.293,2.293l9.293,-9.293c0.391,-0.391 1.023,-0.391 1.414,0c0.391,0.391 0.391,1.023 0,1.414l-10,10c-0.195,0.195 -0.451,0.293 -0.707,0.293z" fill="url(#color-3_u6c3jH8492CC_gr3)"></path></g></g></svg> Все</button>
              <button id="vkr-select-none">✕ Снять</button>
            </div>

            <!-- Delete Panel -->
            <div id="vkr-delete-panel" style="display: none; padding: 12px; background: rgba(239, 68, 68, 0.1); border-radius: var(--vkr-radius-md); margin-top: 10px;">
              <div style="display: flex; gap: 8px;">
                <button id="vkr-delete-selected" class="vkr-mode-btn" style="flex: 1; background: var(--vkr-error);">🗑️ Скрыть выбранные</button>
                <button id="vkr-cancel-delete" class="vkr-mode-btn" style="flex: 1;">Отмена</button>
              </div>
            </div>

            <div id="vkr-groups-list"></div>
          </div>
        </div>

        <!-- Schedule Tab -->
        <div id="vkr-tab-schedule" class="vkr-tab-content">
          <!-- Schedule -->
          <div class="vkr-section">
            <div class="vkr-section-title">⏰ Отложенный постинг</div>
            <label class="vkr-checkbox">
              <input type="checkbox" id="vkr-schedule">
              <span>Опубликовать позже</span>
            </label>
            <div id="vkr-schedule-inputs" style="display: none; margin-top: 10px; flex-direction: column; gap: 10px;">
              <div style="display: flex; gap: 10px; width: 100%;">
                <input type="text" id="vkr-date" placeholder="ДД.ММ.ГГГГ" maxlength="10" style="flex: 1;">
                <input type="text" id="vkr-time" placeholder="ЧЧ:ММ" maxlength="5" style="flex: 1;">
              </div>
              <div id="vkr-schedule-interval-container" style="display: flex; align-items: center; gap: 10px; padding: 4px 0;">
                <span style="font-size: 13px; color: var(--vkr-text-secondary);">Интервал между группами (мин):</span>
                <input type="number" id="vkr-interval" value="0" min="0" max="1440">
              </div>
              <label style="display: grid; gap: 6px; width: 100%;">
                <span style="font-size: 13px; color: var(--vkr-text-secondary);">Как подготовить отложенный пост:</span>
                <select id="vkr-schedule-mode" style="width: 100%; padding: 10px; color: var(--vkr-text-primary); background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md);">
                  <option value="native_vk">Надёжно: передать в отложку VK сейчас</option>
                  <option value="exact_photo_time">Точная дата фото: загрузить в момент выхода</option>
                </select>
              </label>
              <div id="vkr-schedule-mode-note" style="padding: 10px 12px; border: 1px solid rgba(56, 189, 248, .28); border-radius: var(--vkr-radius-md); background: rgba(56, 189, 248, .08); color: var(--vkr-text-secondary); font-size: 12px; line-height: 1.45;">
                Фото загрузятся сейчас, запись попадёт в отложку VK. После завершения подготовки Chrome можно закрыть.
              </div>
            </div>

            <!-- Analytics -->
            <div id="vkr-analytics" style="display: none; margin-top: 15px;">
              <div class="vkr-section-title">📊 Лучшее время публикации</div>
              <select id="vkr-analytics-group" style="width: 100%; padding: 10px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md); color: var(--vkr-text-primary); margin-bottom: 10px;">
                <option>Выберите группу...</option>
              </select>
              <div id="vkr-analytics-loading" style="text-align: center; padding: 20px; color: var(--vkr-text-muted);">⏳ Загрузка аналитики...</div>
              <div id="vkr-analytics-content" style="display: none;">
                <div id="vkr-analytics-meta" style="font-size: 11px; color: var(--vkr-text-muted); margin-bottom: 12px;"></div>
                <div id="vkr-heatmap" class="vkr-heatmap"></div>
                <div id="vkr-analytics-top3"></div>
              </div>
              <div id="vkr-analytics-error" style="display: none;"></div>
            </div>
          </div>

          <!-- Autodelete -->
          <div class="vkr-section">
            <div class="vkr-section-title">🗑️ Автоудаление</div>
            <label class="vkr-checkbox">
              <input type="checkbox" id="vkr-autodelete">
              <span>Удалить пост через</span>
            </label>
            <div id="vkr-autodelete-settings" style="display: none; margin-top: 10px;">
              <div class="vkr-chips" style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
                <div class="vkr-chip" data-hours="1" style="padding: 6px 12px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: 16px; font-size: 12px; cursor: pointer; transition: all 0.2s;">1 час</div>
                <div class="vkr-chip" data-hours="6" style="padding: 6px 12px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: 16px; font-size: 12px; cursor: pointer; transition: all 0.2s;">6 часов</div>
                <div class="vkr-chip" data-hours="12" style="padding: 6px 12px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: 16px; font-size: 12px; cursor: pointer; transition: all 0.2s;">12 часов</div>
                <div class="vkr-chip" data-hours="24" style="padding: 6px 12px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: 16px; font-size: 12px; cursor: pointer; transition: all 0.2s;">24 часа</div>
              </div>
              <div style="display: flex; gap: 10px; align-items: center;">
                <input type="number" id="vkr-delete-hours" value="0" min="0" max="999" style="width: 80px; padding: 8px 10px; background: var(--vkr-bg-secondary); border: 1px solid var(--vkr-border); border-radius: 6px; color: var(--vkr-text-primary); text-align: center;">
                <span style="font-size: 12px; color: var(--vkr-text-muted);">часов</span>
                <input type="number" id="vkr-delete-minutes" value="0" min="0" max="59" step="15" style="width: 80px; padding: 8px 10px; background: var(--vkr-bg-secondary); border: 1px solid var(--vkr-border); border-radius: 6px; color: var(--vkr-text-primary); text-align: center;">
                <span style="font-size: 12px; color: var(--vkr-text-muted);">минут</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Hidden Groups Tab -->
        <div id="vkr-tab-hidden" class="vkr-tab-content">
          <div class="vkr-section">
            <div class="vkr-section-title" style="display: flex; align-items: center; gap: 10px;">
              👁️ Скрытые группы
              <span id="vkr-hidden-count" style="font-size: 11px; color: var(--vkr-text-muted);">0 скрыто</span>
            </div>
            <input type="text" id="vkr-search-hidden" placeholder="🔍 Поиск...">
            <div id="vkr-hidden-groups-list"></div>
            <button id="vkr-restore-all" class="vkr-mode-btn" style="width: 100%; margin-top: 12px;">↩️ Восстановить все</button>
          </div>
        </div>
      </div>
    </div>

    <div id="vkr-modal-footer">
      <div id="vkr-status"></div>
      <div id="vkr-progress" style="display: none;">
        <div id="vkr-progress-bar"></div>
      </div>
      <div class="vkr-footer-buttons">
        <button id="vkr-minimize-btn-footer" style="display: none;">🗕 Свернуть в фон</button>
        <button id="vkr-cancel">Отмена</button>
        <button id="vkr-submit">🚀 Репост</button>
      </div>
    </div>
  </div>
</div>

<!-- Comment Modal (по центру) -->
<div id="vkr-comment-modal-overlay" style="display:none; pointer-events: auto;">
  <div id="vkr-modal" style="max-width: 480px; margin: auto;">
    <div id="vkr-modal-header" style="cursor: move;">
      <span>💬 Комментарий</span>
      <button id="vkr-comment-close">✕</button>
    </div>
    <div id="vkr-modal-body" style="flex-direction: column;">
      <div class="vkr-section">
        <div class="vkr-section-title">👤 Аккаунт</div>
        <select id="vkr-comment-account" style="width: 100%; padding: 10px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md); color: var(--vkr-text-primary);"></select>
      </div>
      <div class="vkr-section">
        <div class="vkr-section-title">📝 Заготовки</div>
        <div id="vkr-phrases-list"></div>
        <div style="display: flex; gap: 8px; margin-top: 10px;">
          <input type="text" id="vkr-new-phrase" placeholder="Новая фраза..." style="flex: 1; padding: 10px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md); color: var(--vkr-text-primary);">
          <button id="vkr-add-phrase" class="vkr-mode-btn active">➕</button>
        </div>
      </div>
      <div id="vkr-comment-status"></div>
      <button id="vkr-send-comment-btn" class="vkr-mode-btn active" style="width: 100%; padding: 12px; font-size: 14px;">🚀 Отправить случайную фразу</button>
    </div>
  </div>
</div>
`;
}

window.createShadowModal = createShadowModal;
