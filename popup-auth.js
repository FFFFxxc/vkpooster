/**
 * VK Reposter Pro - Popup Auth Script
 */

document.addEventListener('DOMContentLoaded', async () => {
  const elements = {
    // Main
    mainContent: document.getElementById('mainContent'),
    settingsPanel: document.getElementById('settingsPanel'),
    
    // Server
    serverStatus: document.getElementById('serverStatus'),
    statusIndicator: document.getElementById('statusIndicator'),
    statusText: document.getElementById('statusText'),
    connectionStatus: document.getElementById('connectionStatus'),
    
    // Settings
    settingsBtn: document.getElementById('settingsBtn'),
    closeSettings: document.getElementById('closeSettings'),
    serverUrlInput: document.getElementById('serverUrlInput'),
    saveServerBtn: document.getElementById('saveServerBtn'),
    testServerBtn: document.getElementById('testServerBtn'),
    
    // Accounts
    accountsList: document.getElementById('accountsList'),
    addAccountBtn: document.getElementById('addAccountBtn'),
    
    // Stats
    statsSection: document.getElementById('statsSection'),
    scheduledPosts: document.getElementById('scheduledPosts'),
    scheduledComments: document.getElementById('scheduledComments'),
    serverUptime: document.getElementById('serverUptime'),
    
    // Actions
    syncBtn: document.getElementById('syncBtn'),
    historyBtn: document.getElementById('historyBtn')
  };

  let serverUrl = '';

  // Загрузка сохранённого URL
  chrome.runtime.sendMessage({ type: 'get_server_url' }, (response) => {
    if (response?.url) {
      serverUrl = response.url;
      elements.serverUrlInput.value = serverUrl;
      checkServer();
    }
  });

  // Показать/скрыть настройки
  elements.settingsBtn.addEventListener('click', () => {
    elements.settingsPanel.style.display = 'block';
  });

  elements.closeSettings.addEventListener('click', () => {
    elements.settingsPanel.style.display = 'none';
  });

  // Сохранить URL сервера
  elements.saveServerBtn.addEventListener('click', async () => {
    const url = elements.serverUrlInput.value.trim();
    if (!url) {
      showToast('Введите URL сервера', 'error');
      return;
    }

    chrome.runtime.sendMessage({ type: 'set_server_url', url }, (response) => {
      if (response?.ok) {
        serverUrl = url;
        showToast('URL сохранён');
        checkServer();
      }
    });
  });

  // Проверить соединение
  elements.testServerBtn.addEventListener('click', checkServer);

  async function checkServer() {
    elements.statusIndicator.className = 'status-indicator connecting';
    elements.statusText.textContent = 'Проверка...';

    chrome.runtime.sendMessage({ type: 'check_server' }, async (response) => {
      if (response?.ok) {
        elements.statusIndicator.className = 'status-indicator online';
        elements.statusText.textContent = 'Сервер подключён';
        elements.connectionStatus.textContent = 'Подключено к серверу';
        elements.connectionStatus.className = 'connected';
        elements.statsSection.style.display = 'block';
        
        // Загружаем статистику
        loadServerStats();
      } else {
        elements.statusIndicator.className = 'status-indicator offline';
        elements.statusText.textContent = 'Сервер недоступен';
        elements.connectionStatus.textContent = 'Локальный режим';
        elements.connectionStatus.className = '';
        elements.statsSection.style.display = 'none';
      }
    });
  }

  async function loadServerStats() {
    if (!serverUrl) return;
    
    try {
      const resp = await fetch(`${serverUrl}/`);
      const data = await resp.json();
      
      elements.scheduledPosts.textContent = data.scheduledPosts || 0;
      elements.scheduledComments.textContent = data.scheduledComments || 0;
      
      const hours = Math.floor(data.uptime / 3600);
      const mins = Math.floor((data.uptime % 3600) / 60);
      elements.serverUptime.textContent = `${hours}ч ${mins}м`;
    } catch (e) {
      console.error('Stats error:', e);
    }
  }

  // Загрузка аккаунтов
  loadAccounts();

  function loadAccounts() {
    chrome.storage.local.get(['vk_accounts'], (data) => {
      const accounts = data.vk_accounts || [];
      
      if (accounts.length === 0) {
        elements.accountsList.innerHTML = `
          <div class="no-accounts">
            Нет аккаунтов<br>
            <small>Нажмите "Добавить" для авторизации</small>
          </div>
        `;
        return;
      }

      elements.accountsList.innerHTML = accounts.map(acc => `
        <div class="account-item" data-id="${acc.id}">
          <img class="account-photo" src="${acc.photo}" alt="">
          <div class="account-info">
            <div class="account-name">${acc.name}</div>
            <div class="account-id">ID: ${acc.id}</div>
          </div>
          <button class="account-delete" data-id="${acc.id}">×</button>
        </div>
      `).join('');

      // Delete handlers
      elements.accountsList.querySelectorAll('.account-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = parseInt(btn.dataset.id);
          
          chrome.storage.local.get(['vk_accounts'], (data) => {
            const accounts = data.vk_accounts || [];
            const filtered = accounts.filter(a => a.id !== id);
            chrome.storage.local.set({ vk_accounts: filtered }, () => {
              loadAccounts();
              showToast('Аккаунт удалён');
            });
          });
        });
      });
    });
  }

  // Добавить аккаунт
  elements.addAccountBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'start_auth' }, () => {
      showToast('Откройте вкладку VK для авторизации');
    });
  });

  // Синхронизация
  elements.syncBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'sync_accounts' }, (response) => {
      if (response?.ok) {
        showToast(`Синхронизировано ${response.count} аккаунтов`);
        loadServerStats();
      } else {
        showToast('Ошибка синхронизации', 'error');
      }
    });
  });

  // История
  elements.historyBtn.addEventListener('click', async () => {
    if (!serverUrl) {
      showToast('Сначала подключите сервер', 'error');
      return;
    }
    
    try {
      const resp = await fetch(`${serverUrl}/api/history`);
      const data = await resp.json();
      
      if (data.ok && data.history.length > 0) {
        const lastTasks = data.history.slice(0, 5);
        const message = lastTasks.map(t => {
          const icon = t.success ? '✅' : '❌';
          const time = new Date(t.timestamp).toLocaleTimeString('ru-RU');
          return `${icon} ${t.type} в ${time}`;
        }).join('\n');
        alert(`Последние задачи:\n\n${message}`);
      } else {
        showToast('История пуста');
      }
    } catch (e) {
      showToast('Ошибка загрузки истории', 'error');
    }
  });

  // Toast notification
  function showToast(message, type = 'success') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
  }

  // Слушатель изменений storage
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.vk_accounts) {
      loadAccounts();
    }
  });
});