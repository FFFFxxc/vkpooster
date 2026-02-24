/**
 * VK Reposter Pro - Background Service Worker (с поддержкой сервера)
 */

let authTabId = null;
const V = '5.199';
let serverUrl = null;

// Загрузка URL сервера
async function getServerUrl() {
  if (serverUrl) return serverUrl;
  const data = await chrome.storage.local.get(['vkr_server_url']);
  serverUrl = data.vkr_server_url || '';
  return serverUrl;
}

// Установка URL сервера
async function setServerUrl(url) {
  serverUrl = url.replace(/\/$/, ''); // Убираем слэш в конце
  await chrome.storage.local.set({ vkr_server_url: serverUrl });
  return serverUrl;
}

// Проверка соединения с сервером
async function checkServerConnection() {
  const url = await getServerUrl();
  if (!url) return { ok: false, error: 'Server URL not set' };
  
  try {
    const resp = await fetch(`${url}/health`, { method: 'GET' });
    const data = await resp.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Отправка данных на сервер
async function sendToServer(endpoint, method, body) {
  const url = await getServerUrl();
  if (!url) return { ok: false, error: 'Server URL not set' };
  
  try {
    const resp = await fetch(`${url}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// OAuth авторизация
function startAuthFlow() {
  const authUrl = 'https://oauth.vk.com/authorize?client_id=6121396&scope=wall,groups,photos,video,offline&redirect_uri=https://oauth.vk.com/blank.html&display=page&response_type=token&v=5.199';
  chrome.tabs.create({ url: authUrl }, (tab) => { authTabId = tab?.id ?? null; });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!authTabId || tabId !== authTabId) return;
  if (!changeInfo.url || !changeInfo.url.includes('access_token=')) return;
  
  const hash = changeInfo.url.split('#')[1];
  if (!hash) return;
  const token = new URLSearchParams(hash).get('access_token');
  if (!token) return;
  
  chrome.tabs.remove(tabId);
  authTabId = null;
  
  try {
    const u = (await vkApi('users.get', { fields: 'photo_50' }, token))[0];
    const data = await chrome.storage.local.get(['vk_accounts']);
    const accounts = data.vk_accounts || [];
    
    if (!accounts.some(acc => acc.id === u.id)) {
      accounts.push({
        token: token,
        id: u.id,
        name: `${u.first_name} ${u.last_name}`,
        photo: u.photo_50 || 'https://vk.com/images/camera_50.png'
      });
      await chrome.storage.local.set({ vk_accounts: accounts, vk_token: accounts[0].token });
    }
    
    // Отправляем аккаунт на сервер
    const serverResult = await sendToServer('/api/accounts', 'POST', {
      token: token,
      userId: u.id,
      name: `${u.first_name} ${u.last_name}`,
      photo: u.photo_50
    });
    
    if (serverResult.ok) {
      console.log('[BG] Account synced to server');
    }
  } catch (e) {
    console.error('[BG] Error saving OAuth account:', e);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === authTabId) authTabId = null; });

async function vkApi(method, params, token, captchaSid, captchaKey) {
  const u = new URL('https://api.vk.com/method/' + method);
  u.searchParams.set('access_token', token);
  u.searchParams.set('v', V);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') u.searchParams.set(k, String(v));
  }
  if (captchaSid && captchaKey) {
    u.searchParams.set('captcha_sid', captchaSid);
    u.searchParams.set('captcha_key', captchaKey);
  }
  const r = await fetch(u.toString());
  const d = await r.json();
  if (d.error) {
    const err = new Error(d.error.error_msg);
    err.code = d.error.error_code;
    throw err;
  }
  return d.response;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;

  if (type === 'start_auth') {
    startAuthFlow();
    sendResponse({ ok: true });
    return false;
  }
  
  // Server management
  if (type === 'set_server_url') {
    setServerUrl(message.url).then(url => sendResponse({ ok: true, url }));
    return true;
  }
  if (type === 'get_server_url') {
    getServerUrl().then(url => sendResponse({ ok: true, url }));
    return true;
  }
  if (type === 'check_server') {
    checkServerConnection().then(sendResponse);
    return true;
  }
  
  // Sync accounts to server
  if (type === 'sync_accounts') {
    (async () => {
      const data = await chrome.storage.local.get(['vk_accounts']);
      const accounts = data.vk_accounts || [];
      for (const acc of accounts) {
        await sendToServer('/api/accounts', 'POST', {
          token: acc.token,
          userId: acc.id,
          name: acc.name,
          photo: acc.photo
        });
      }
      sendResponse({ ok: true, count: accounts.length });
    })();
    return true;
  }
  
  // Scheduled comment to server
  if (type === 'schedule_comment') {
    sendToServer('/api/scheduled-comments', 'POST', message.data).then(sendResponse);
    return true;
  }
  
  // Get scheduled comments from server
  if (type === 'get_scheduled_comments') {
    sendToServer('/api/scheduled-comments', 'GET').then(sendResponse);
    return true;
  }
  
  // Delete scheduled comment
  if (type === 'delete_scheduled_comment') {
    fetch(`${serverUrl}/api/scheduled-comments/${message.id}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(sendResponse);
    return true;
  }
  
  // Scheduled deletion to server
  if (type === 'schedule_deletion') {
    sendToServer('/api/scheduled-deletions', 'POST', message.data).then(sendResponse);
    return true;
  }
  
  // Autolike settings to server
  if (type === 'save_autolike_settings_server') {
    sendToServer('/api/autolike-settings', 'POST', message.settings).then(sendResponse);
    return true;
  }
  
  // Original handlers (fallback when no server)
  if (type === 'load_post') { handleLoadPost(message, sendResponse); return true; }
  if (type === 'send_to_groups') { handleSendToGroups(message, sendResponse); return true; }
  if (type === 'fetch_image') { handleFetchImage(message, sendResponse); return true; }
  if (type === 'resolve_screen_name') { handleResolveScreenName(message, sendResponse); return true; }
  if (type === 'search_best_posts') { handleSearchBestPosts(message, sendResponse); return true; }
  if (type === 'analyze_activity') { handleAnalyzeActivity(message, sendResponse); return true; }
  if (type === 'save_autolike_settings') { handleSaveAutolikeSettings(message, sendResponse); return true; }
  if (type === 'get_my_groups') { handleGetMyGroups(message, sendResponse); return true; }
  if (type === 'run_autolike_now') { handleRunAutolikeNow(message, sendResponse); return true; }
  if (type === 'boost_comment') { handleBoostComment(message, sendResponse); return true; }
  if (type === 'create_comment') { handleCreateComment(message, sendResponse); return true; }
  if (type === 'create_group_comment') { handleCreateGroupComment(message, sendResponse); return true; }
  
  return false;
});

async function handleLoadPost(message, sendResponse) {
  try {
    const { postUrl, token } = message;
    const m = postUrl.match(/wall(-?\d+_\d+)/) || postUrl.match(/(-?\d+_\d+)/);
    if (!m) throw new Error('Invalid link');
    const pp = m[1].split('_');
    const res = await vkApi('wall.getById', { posts: pp[0] + '_' + pp[1] }, token);
    const post = res.items ? res.items[0] : (Array.isArray(res) ? res[0] : null);
    if (!post) throw new Error('Post not found');
    await delay(350);
    const gr = await vkApi('groups.get', { extended: 1, filter: 'admin,editor', count: 100 }, token);
    const groups = gr.items || (Array.isArray(gr) ? gr : []);
    sendResponse({ ok: true, post, groups });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleSendToGroups(message, sendResponse) {
  try {
    const { post, groups, mode, text, pubDate, processedPhotos, token, useServer } = message;
    
    // Если включен сервер - отправляем расписание
    if (useServer && pubDate) {
      const results = [];
      for (const gid of groups) {
        const serverResult = await sendToServer('/api/scheduled-posts', 'POST', {
          groupId: gid,
          message: text || '',
          publishDate: pubDate,
          ownerId: post.owner_id,
          postId: post.id
        });
        results.push({ gid, ok: serverResult.ok, taskId: serverResult.task?.id });
      }
      sendResponse({ ok: true, results, usedServer: true });
      return;
    }
    
    // Локальная обработка
    const results = [];
    for (const gid of groups) {
      try {
        let postId = null;
        if (mode === 'repost') {
          const r = await vkApi('wall.repost', { object: 'wall' + post.owner_id + '_' + post.id, group_id: gid }, token);
          postId = r.post_id;
        } else {
          const params = { owner_id: '-' + gid, from_group: 1, message: text || '' };
          if (pubDate) params.publish_date = Math.floor(pubDate / 1000);
          if (post.attachments && post.attachments.length) {
            const atts = [];
            let pi = 0;
            for (const a of post.attachments) {
              const tp = a.type, obj = a[tp];
              if (!obj) continue;
              if (tp === 'photo') {
                try {
                  let photoDataUrl;
                  if (processedPhotos && processedPhotos[pi]) {
                    photoDataUrl = processedPhotos[pi];
                  } else {
                    const sizes = obj.sizes || [];
                    const best = sizes[sizes.length - 1];
                    if (best) {
                      const imgResp = await fetch(best.url);
                      const blob = await imgResp.blob();
                      photoDataUrl = await new Promise((res, rej) => {
                        const r = new FileReader();
                        r.onloadend = () => res(r.result);
                        r.onerror = rej;
                        r.readAsDataURL(blob);
                      });
                    }
                  }
                  if (photoDataUrl) {
                    const srv = await vkApi('photos.getWallUploadServer', { group_id: gid }, token);
                    const photoBlob = await fetch(photoDataUrl).then(r => r.blob());
                    const fd = new FormData();
                    fd.append('photo', photoBlob, 'photo.jpg');
                    const upResp = await fetch(srv.upload_url, { method: 'POST', body: fd });
                    const up = await upResp.json();
                    const saved = await vkApi('photos.saveWallPhoto', { group_id: gid, photo: up.photo, server: up.server, hash: up.hash }, token);
                    if (saved && saved[0]) atts.push('photo' + saved[0].owner_id + '_' + saved[0].id);
                    await delay(400);
                  }
                } catch (pe) { console.error('[BG] Photo error:', pe); }
                pi++;
              } else if (tp === 'video') {
                const ak = obj.access_key ? '_' + obj.access_key : '';
                atts.push('video' + obj.owner_id + '_' + obj.id + ak);
              } else if (tp === 'doc') {
                atts.push('doc' + obj.owner_id + '_' + obj.id);
              }
            }
            if (atts.length) params.attachments = atts.join(',');
          }
          const r = await vkApi('wall.post', params, token);
          postId = r.post_id;
        }
        results.push({ gid, ok: true, postId });
      } catch (e) {
        results.push({ gid, ok: false, error: e.message });
      }
    }
    sendResponse({ ok: true, results, usedServer: false });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleFetchImage(message, sendResponse) {
  try {
    const resp = await fetch(message.url);
    const blob = await resp.blob();
    const reader = new FileReader();
    reader.onloadend = () => sendResponse({ ok: true, dataUrl: reader.result });
    reader.onerror = () => sendResponse({ ok: false, error: 'FileReader error' });
    reader.readAsDataURL(blob);
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleResolveScreenName(message, sendResponse) {
  try {
    const result = await vkApi('utils.resolveScreenName', { screen_name: message.screenName }, message.token);
    if (!result || !result.object_id) throw new Error('Cannot resolve ID');
    sendResponse({ ok: true, objectId: result.object_id, objectType: result.type });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleSearchBestPosts(message, sendResponse) {
  try {
    const result = await vkApi('wall.get', {
      owner_id: message.ownerId,
      count: Math.min(message.count, 100),
      offset: message.offset || 0,
      filter: 'owner',
      extended: 1
    }, message.token);
    const posts = (result.items || []).filter(p => !p.marked_as_ads && p.is_pinned !== 1);
    sendResponse({ ok: true, posts, totalCount: result.count || 0, hasMore: (result.items || []).length === 100 });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleAnalyzeActivity(message, sendResponse) {
  try {
    const { groupId, token } = message;
    const allPosts = [];
    for (let offset = 0; offset < 200; offset += 100) {
      const batch = await vkApi('wall.get', { owner_id: '-' + groupId, count: 100, offset, filter: 'owner' }, token);
      const items = (batch.items || []).filter(p => !p.marked_as_ads && p.is_pinned !== 1);
      allPosts.push(...items);
      if ((batch.items || []).length < 100) break;
      await delay(350);
    }
    const hours = Array.from({ length: 24 }, () => ({ posts: 0, likes: 0, views: 0, comments: 0, reposts: 0 }));
    for (const p of allPosts) {
      const h = new Date(p.date * 1000).getHours();
      hours[h].posts++;
      hours[h].likes += p.likes?.count || 0;
      hours[h].views += p.views?.count || 0;
      hours[h].comments += p.comments?.count || 0;
      hours[h].reposts += p.reposts?.count || 0;
    }
    const hourly = hours.map((d, h) => ({
      hour: h, posts: d.posts,
      avgLikes: Math.round(d.likes / (d.posts || 1)),
      avgViews: Math.round(d.views / (d.posts || 1)),
      engagement: Math.round((d.likes + d.comments + d.reposts) / (d.posts || 1))
    }));
    const top3 = [...hourly].filter(h => h.posts >= 2).sort((a, b) => b.engagement - a.engagement).slice(0, 3);
    sendResponse({ ok: true, data: { groupId, analyzedPosts: allPosts.length, hourly, top3 } });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleSaveAutolikeSettings(message, sendResponse) {
  try {
    await chrome.storage.local.set({ vkr_autolike_settings: message.settings });
    await setupAutolikeAlarm();
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleGetMyGroups(message, sendResponse) {
  try {
    const groups = await vkApi('groups.get', { extended: 1, filter: 'admin,editor', count: 100 }, message.token);
    sendResponse({ ok: true, groups: groups.items || groups });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleRunAutolikeNow(message, sendResponse) {
  try {
    await processAutoLikes();
    const data = await chrome.storage.local.get('vkr_autolike_settings');
    sendResponse({ ok: true, settings: data.vkr_autolike_settings });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleBoostComment(message, sendResponse) {
  try {
    const { ownerId, commentId, itemType } = message;
    const data = await chrome.storage.local.get(['vk_accounts', 'vkr_autolike_settings']);
    const accounts = data.vk_accounts || [];
    if (accounts.length === 0) throw new Error('No accounts');
    let successCount = 0;
    const typeForApi = itemType || 'comment';
    for (const acc of accounts) {
      try {
        await vkApi('likes.add', { type: typeForApi, owner_id: ownerId, item_id: commentId }, acc.token);
        successCount++;
        await delay(Math.floor(Math.random() * 1000) + 1000);
      } catch (e) {
        if (e.message && e.message.includes('Already liked')) successCount++;
      }
    }
    sendResponse({ ok: true, count: successCount });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleCreateComment(message, sendResponse) {
  try {
    const res = await vkApi('wall.createComment', { owner_id: message.ownerId, post_id: message.postId, message: message.text }, message.token);
    sendResponse({ ok: true, commentId: res.comment_id });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleCreateGroupComment(message, sendResponse) {
  try {
    const res = await vkApi('wall.createComment', { owner_id: message.ownerId, post_id: message.postId, message: message.text, from_group: Math.abs(parseInt(message.ownerId)) }, message.token);
    sendResponse({ ok: true, commentId: res.comment_id });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

// Autolike System
async function setupAutolikeAlarm() {
  const data = await chrome.storage.local.get('vkr_autolike_settings');
  const settings = data.vkr_autolike_settings;
  await chrome.alarms.clear('autolike_check');
  if (settings?.enabled && settings.groups?.length > 0) {
    chrome.alarms.create('autolike_check', { periodInMinutes: settings.intervalMinutes || 10 });
  }
}

async function processAutoLikes() {
  try {
    const data = await chrome.storage.local.get(['vkr_autolike_settings', 'vk_accounts']);
    const settings = data.vkr_autolike_settings;
    const accounts = data.vk_accounts || [];
    if (!settings?.enabled || accounts.length === 0 || !settings.groups?.length) return;

    const processedSet = new Set(settings.processedPosts || []);
    const newProcessed = [];
    let likesAdded = 0;
    const today = new Date().toISOString().split('T')[0];
    let stats = settings.stats || { today: 0, todayDate: today, total: 0 };
    if (stats.todayDate !== today) { stats.today = 0; stats.todayDate = today; }

    for (const groupId of settings.groups) {
      try {
        const res = await vkApi('wall.get', { owner_id: '-' + groupId, count: 10, filter: settings.onlyFromGroup ? 'owner' : 'all' }, accounts[0].token);
        for (const post of (res.items || [])) {
          const postKey = 'wall' + post.owner_id + '_' + post.id;
          if (processedSet.has(postKey) || post.marked_as_ads || post.is_pinned === 1) continue;
          if (post.date < (Date.now() / 1000) - (14 * 24 * 60 * 60)) continue;
          
          for (const acc of accounts) {
            try {
              await vkApi('likes.add', { type: 'post', owner_id: post.owner_id, item_id: post.id }, acc.token);
              likesAdded++;
              stats.today++;
              stats.total++;
              await delay(Math.floor(Math.random() * 1500) + 1500);
            } catch (e) {
              if (!e.message.includes('Already liked')) console.error(e.message);
            }
          }
          newProcessed.push(postKey);
          await delay(1000);
        }
      } catch (e) {
        console.error('[BG] Autolike group error:', groupId, e);
      }
    }

    settings.processedPosts = [...(settings.processedPosts || []), ...newProcessed].slice(-500);
    settings.lastCheck = Date.now();
    settings.stats = stats;
    await chrome.storage.local.set({ vkr_autolike_settings: settings });
    if (likesAdded > 0) {
      chrome.action.setBadgeText({ text: '+' + likesAdded });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
    }
  } catch (e) {
    console.error('[BG] Autolike error:', e);
  }
}

// Alarms
chrome.alarms.create('check_deletions', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'autolike_check') await processAutoLikes();
  
  if (alarm.name === 'check_deletions') {
    const data = await chrome.storage.local.get(['vkr_scheduled_deletions', 'vkr_scheduled_comments', 'vk_token']);
    const token = data.vk_token;
    if (!token) return;
    
    const now = Date.now();
    
    if (data.vkr_scheduled_deletions?.length) {
      const remaining = [];
      for (const item of data.vkr_scheduled_deletions) {
        if (item.deleteAt <= now) {
          try { await vkApi('wall.delete', { owner_id: item.ownerId, post_id: item.postId }, token); } catch (e) {}
        } else {
          remaining.push(item);
        }
      }
      await chrome.storage.local.set({ vkr_scheduled_deletions: remaining });
    }
    
    if (data.vkr_scheduled_comments?.length) {
      const remaining = [];
      for (const item of data.vkr_scheduled_comments) {
        if (item.commentAt <= now) {
          try {
            await vkApi('wall.createComment', {
              owner_id: item.ownerId, post_id: item.postId, message: item.commentText,
              from_group: Math.abs(parseInt(item.ownerId))
            }, token);
          } catch (e) {
            if ((item.retries || 0) < 3) {
              item.retries = (item.retries || 0) + 1;
              item.commentAt = now + 60000;
              remaining.push(item);
            }
            continue;
          }
        } else {
          remaining.push(item);
        }
      }
      await chrome.storage.local.set({ vkr_scheduled_comments: remaining });
    }
  }
});

console.log('[BG] VK Reposter Pro loaded');
setupAutolikeAlarm();