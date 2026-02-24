/**
 * VK Reposter Pro - Shadow DOM Modal
 * Modern Glassmorphism Design
 */

let shadowHost = null;
let shadowRoot = null;

async function createShadowModal() {
  if (document.getElementById('vkr-shadow-host')) {
    return document.getElementById('vkr-shadow-host').shadowRoot;
  }
  
  shadowHost = document.createElement('div');
  shadowHost.id = 'vkr-shadow-host';
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
  
  shadowRoot = shadowHost.attachShadow({ mode: 'open' });
  
  const cssText = await loadCSS();
  const style = document.createElement('style');
  style.textContent = cssText;
  shadowRoot.appendChild(style);
  
  const modalContainer = document.createElement('div');
  modalContainer.innerHTML = getModalHTML();
  shadowRoot.appendChild(modalContainer);
  
  return shadowRoot;
}

async function loadCSS() {
  try {
    const modalCssUrl = chrome.runtime.getURL('modal.css');
    return await fetch(modalCssUrl).then(r => r.text());
  } catch (e) {
    console.error('[VKR] Failed to load CSS:', e);
    return '';
  }
}

function getModalHTML() {
  return `
<!-- Main Repost Modal -->
<div id="vkr-modal-overlay" style="display:none; pointer-events: auto;">
  <div id="vkr-modal">
    <div id="vkr-modal-header">
      <span>📋 VK Reposter Pro</span>
      <button id="vkr-close">✕</button>
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
              <textarea id="vkr-autocomment-text" placeholder="Введите текст комментария..." style="width: 100%; min-height: 60px; padding: 12px; background: var(--vkr-bg-tertiary); border: 1px solid var(--vkr-border); border-radius: var(--vkr-radius-md); color: var(--vkr-text-primary); font-family: inherit; font-size: 13px; resize: vertical;"></textarea>
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
            <input type="text" id="vkr-search" placeholder="🔍 Поиск групп...">
            <div class="vkr-group-actions">
              <button id="vkr-select-all">✓ Все</button>
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
            <div id="vkr-schedule-inputs" style="display: none; margin-top: 10px;">
              <input type="text" id="vkr-date" placeholder="ДД.ММ.ГГГГ" maxlength="10">
              <input type="text" id="vkr-time" placeholder="ЧЧ:ММ" maxlength="5">
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
