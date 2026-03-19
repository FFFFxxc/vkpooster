/**
 * VK Automation Server
 * Сервер для автоматизации VK Reposter Pro
 * Работает 24/7 даже когда браузер выключен
 * Поддержка: посты, комментарии, удаления, автолайки, истории
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// VK API версия
const VK_VERSION = '5.199';

// Файл для хранения данных
const DATA_FILE = path.join(__dirname, 'data.json');

// Загрузка данных из файла
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[DATA] Error loading:', e.message);
  }
  return {
    accounts: [],
    scheduledPosts: [],
    scheduledComments: [],
    scheduledDeletions: [],
    scheduledStories: [],
    autolikeSettings: null,
    taskHistory: []
  };
}

// Сохранение данных в файл
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[DATA] Error saving:', e.message);
  }
}

// Инициализация данных
let data = loadData();

// VK API запрос
async function vkApi(method, params, token) {
  const url = new URL(`https://api.vk.com/method/${method}`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('v', VK_VERSION);
  
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  
  const response = await fetch(url.toString());
  const result = await response.json();
  
  if (result.error) {
    const error = new Error(result.error.error_msg);
    error.code = result.error.error_code;
    throw error;
  }
  
  return result.response;
}

// Задержка
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== API ROUTES ====================

// Статус сервера
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '2.0.0',
    uptime: Math.floor(process.uptime()),
    accounts: data.accounts.length,
    scheduledPosts: data.scheduledPosts.length,
    scheduledComments: data.scheduledComments.length,
    scheduledDeletions: data.scheduledDeletions.length,
    scheduledStories: data.scheduledStories.length
  });
});

// Проверка здоровья (для Render)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ==================== АККАУНТЫ ====================

// Добавить аккаунт
app.post('/api/accounts', (req, res) => {
  try {
    const { token, userId, name, photo } = req.body;
    
    if (!token || !userId) {
      return res.status(400).json({ ok: false, error: 'Token and userId required' });
    }
    
    // Проверяем, нет ли уже такого аккаунта
    const existingIndex = data.accounts.findIndex(a => a.userId === userId);
    
    const account = {
      userId,
      token,
      name: name || `User ${userId}`,
      photo: photo || 'https://vk.com/images/camera_50.png',
      addedAt: Date.now()
    };
    
    if (existingIndex >= 0) {
      data.accounts[existingIndex] = account;
    } else {
      data.accounts.push(account);
    }
    
    saveData();
    res.json({ ok: true, account });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Получить все аккаунты (без токенов!)
app.get('/api/accounts', (req, res) => {
  const accounts = data.accounts.map(a => ({
    userId: a.userId,
    name: a.name,
    photo: a.photo,
    addedAt: a.addedAt
  }));
  res.json({ ok: true, accounts });
});

// Получить все аккаунты С токенами (для синхронизации расширения)
app.get('/api/accounts/full', (req, res) => {
  const accounts = data.accounts.map(a => ({
    userId: a.userId,
    token: a.token,
    name: a.name,
    photo: a.photo,
    addedAt: a.addedAt
  }));
  res.json({ ok: true, accounts });
});

// Удалить аккаунт
app.delete('/api/accounts/:userId', (req, res) => {
  const { userId } = req.params;
  data.accounts = data.accounts.filter(a => a.userId !== parseInt(userId));
  saveData();
  res.json({ ok: true });
});

// ==================== ОТЛОЖЕННЫЕ ПОСТЫ ====================

// Добавить отложенный пост
app.post('/api/scheduled-posts', (req, res) => {
  try {
    const { groupId, message, attachments, publishDate, ownerId, postId, autoDeleteAfter, autoCommentText } = req.body;
    
    if (!groupId || !publishDate) {
      return res.status(400).json({ ok: false, error: 'groupId and publishDate required' });
    }
    
    const task = {
      id: Date.now().toString(),
      groupId,
      message: message || '',
      attachments: attachments || [],
      publishDate,
      sourcePost: ownerId && postId ? { ownerId, postId } : null,
      autoDeleteAfter: autoDeleteAfter || null,
      autoCommentText: autoCommentText || null,
      status: 'pending',
      createdAt: Date.now(),
      result: null,
      publishedPostId: null
    };
    
    data.scheduledPosts.push(task);
    saveData();
    
    console.log(`[POST] Scheduled post for group ${groupId} at ${new Date(publishDate).toISOString()}`);
    
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Получить все отложенные посты
app.get('/api/scheduled-posts', (req, res) => {
  const posts = data.scheduledPosts.filter(p => p.status === 'pending');
  res.json({ ok: true, posts });
});

// Удалить отложенный пост
app.delete('/api/scheduled-posts/:id', (req, res) => {
  const { id } = req.params;
  data.scheduledPosts = data.scheduledPosts.filter(p => p.id !== id);
  saveData();
  res.json({ ok: true });
});

// ==================== ОТЛОЖЕННЫЕ ИСТОРИИ ====================

// Добавить отложенную историю
app.post('/api/scheduled-stories', (req, res) => {
  try {
    const { groupId, groupName, fileData, fileType, publishDate, caption } = req.body;
    
    if (!groupId || !fileData || !publishDate) {
      return res.status(400).json({ ok: false, error: 'groupId, fileData and publishDate required' });
    }
    
    const task = {
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
      groupId,
      groupName: groupName || '',
      fileData,
      fileType: fileType || 'photo', // 'photo' or 'video'
      publishDate,
      caption: caption || '',
      status: 'pending',
      createdAt: Date.now(),
      result: null
    };
    
    data.scheduledStories.push(task);
    saveData();
    
    console.log(`[STORY] Scheduled story for group ${groupId} at ${new Date(publishDate).toISOString()}`);
    
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Получить все отложенные истории
app.get('/api/scheduled-stories', (req, res) => {
  const stories = data.scheduledStories.filter(s => s.status === 'pending');
  res.json({ ok: true, stories });
});

// Удалить отложенную историю
app.delete('/api/scheduled-stories/:id', (req, res) => {
  const { id } = req.params;
  data.scheduledStories = data.scheduledStories.filter(s => s.id !== id);
  saveData();
  res.json({ ok: true });
});

// ==================== ОТЛОЖЕННЫЕ КОММЕНТАРИИ ====================

app.post('/api/scheduled-comments', (req, res) => {
  try {
    const { ownerId, postId, commentText, commentAt, fromGroup } = req.body;
    
    if (!ownerId || !postId || !commentText || !commentAt) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    
    const task = {
      id: Date.now().toString(),
      ownerId,
      postId,
      commentText,
      commentAt,
      fromGroup: fromGroup || false,
      status: 'pending',
      createdAt: Date.now(),
      retries: 0
    };
    
    data.scheduledComments.push(task);
    saveData();
    
    console.log(`[COMMENT] Scheduled comment for post ${ownerId}_${postId}`);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/scheduled-comments', (req, res) => {
  const comments = data.scheduledComments.filter(c => c.status === 'pending');
  res.json({ ok: true, comments });
});

app.delete('/api/scheduled-comments/:id', (req, res) => {
  const { id } = req.params;
  data.scheduledComments = data.scheduledComments.filter(c => c.id !== id);
  saveData();
  res.json({ ok: true });
});

// ==================== АВТОУДАЛЕНИЕ ====================

app.post('/api/scheduled-deletions', (req, res) => {
  try {
    const { ownerId, postId, deleteAt } = req.body;
    
    if (!ownerId || !postId || !deleteAt) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    
    const task = {
      id: Date.now().toString(),
      ownerId,
      postId,
      deleteAt,
      status: 'pending',
      createdAt: Date.now()
    };
    
    data.scheduledDeletions.push(task);
    saveData();
    
    console.log(`[DELETE] Scheduled deletion for post ${ownerId}_${postId}`);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== АВТОЛАЙКИ ====================

app.post('/api/autolike-settings', (req, res) => {
  try {
    data.autolikeSettings = {
      ...req.body,
      lastUpdate: Date.now()
    };
    saveData();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/autolike-settings', (req, res) => {
  res.json({ ok: true, settings: data.autolikeSettings });
});

// ==================== ИСТОРИЯ ====================

app.get('/api/history', (req, res) => {
  const history = data.taskHistory.slice(-100).reverse();
  res.json({ ok: true, history });
});

// ==================== SCHEDULER (CRON) ====================

// Каждую минуту проверяем задачи
cron.schedule('* * * * *', async () => {
  const now = Date.now();
  
  // ===== Отложенные истории =====
  const pendingStories = data.scheduledStories.filter(s => 
    s.status === 'pending' && s.publishDate <= now
  );
  
  for (const task of pendingStories) {
    console.log(`[CRON] Processing scheduled story ${task.id}`);
    
    const account = data.accounts[0];
    if (!account) {
      task.status = 'error';
      task.result = 'No accounts available';
      continue;
    }
    
    try {
      // Get upload server
      let uploadServer;
      if (task.fileType === 'video') {
        uploadServer = await vkApi('stories.getVideoUploadServer', {
          group_id: task.groupId
        }, account.token);
      } else {
        uploadServer = await vkApi('stories.getPhotoUploadServer', {
          group_id: task.groupId
        }, account.token);
      }
      
      if (!uploadServer?.upload_url) {
        throw new Error('Failed to get upload URL');
      }
      
      // Upload file
      const fileData = task.fileData.split(',')[1] || task.fileData;
      const fileBuffer = Buffer.from(fileData, 'base64');
      
      const form = new FormData();
      form.append('file', fileBuffer, {
        filename: task.fileType === 'video' ? 'video.mp4' : 'photo.jpg',
        contentType: task.fileType === 'video' ? 'video/mp4' : 'image/jpeg'
      });
      
      const uploadResp = await fetch(uploadServer.upload_url, {
        method: 'POST',
        body: form,
        headers: form.getHeaders()
      });
      const uploadResult = await uploadResp.json();
      
      // Save story
      const saveResult = await vkApi('stories.save', {
        ...uploadResult
      }, account.token);
      
      task.status = 'completed';
      task.result = 'Story published';
      task.completedAt = now;
      task.storyId = saveResult?.id;
      
      data.taskHistory.push({
        type: 'story',
        taskId: task.id,
        groupId: task.groupId,
        storyId: saveResult?.id,
        success: true,
        timestamp: now
      });
      
      console.log(`[CRON] Story ${task.id} published successfully`);
    } catch (e) {
      task.status = 'error';
      task.result = e.message;
      console.error(`[CRON] Story ${task.id} error:`, e.message);
      
      data.taskHistory.push({
        type: 'story',
        taskId: task.id,
        groupId: task.groupId,
        success: false,
        error: e.message,
        timestamp: now
      });
    }
    
    await delay(1000);
  }
  
  // ===== Отложенные посты =====
  const pendingPosts = data.scheduledPosts.filter(p => 
    p.status === 'pending' && p.publishDate <= now
  );
  
  for (const task of pendingPosts) {
    console.log(`[CRON] Processing scheduled post ${task.id}`);
    
    const account = data.accounts[0];
    if (!account) {
      task.status = 'error';
      task.result = 'No accounts available';
      continue;
    }
    
    try {
      let publishedPostId = null;
      
      if (task.sourcePost) {
        const postData = await vkApi('wall.getById', {
          posts: `${task.sourcePost.ownerId}_${task.sourcePost.postId}`
        }, account.token);
        
        const post = postData.items?.[0];
        if (!post) throw new Error('Source post not found');
        
        let attachments = [];
        if (post.attachments) {
          for (const att of post.attachments) {
            const type = att.type;
            const obj = att[type];
            if (type === 'photo') {
              try {
                const sizes = obj.sizes || [];
                const best = sizes[sizes.length - 1];
                if (best && best.url) {
                  const imgResp = await fetch(best.url);
                  const imgBuffer = await imgResp.buffer();
                  
                  const uploadServer = await vkApi('photos.getWallUploadServer', {
                    group_id: task.groupId
                  }, account.token);
                  
                  const form = new FormData();
                  form.append('photo', imgBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
                  
                  const uploadResp = await fetch(uploadServer.upload_url, {
                    method: 'POST',
                    body: form,
                    headers: form.getHeaders()
                  });
                  const uploadResult = await uploadResp.json();
                  
                  if (uploadResult && uploadResult.photo && uploadResult.server !== undefined && uploadResult.hash) {
                    const saved = await vkApi('photos.saveWallPhoto', {
                      group_id: task.groupId,
                      photo: uploadResult.photo,
                      server: uploadResult.server,
                      hash: uploadResult.hash
                    }, account.token);
                    
                    if (saved && saved[0]) {
                      attachments.push(`photo${saved[0].owner_id}_${saved[0].id}`);
                    }
                  }
                  await delay(400);
                }
              } catch (photoErr) {
                console.error(`[CRON] Photo re-upload error:`, photoErr.message);
              }
            } else if (type === 'video') {
              const ak = obj.access_key ? `_${obj.access_key}` : '';
              attachments.push(`video${obj.owner_id}_${obj.id}${ak}`);
            } else if (type === 'doc') {
              attachments.push(`doc${obj.owner_id}_${obj.id}`);
            }
          }
        }
        
        const result = await vkApi('wall.post', {
          owner_id: `-${task.groupId}`,
          from_group: 1,
          message: task.message || post.text || '',
          attachments: attachments.join(',')
        }, account.token);
        publishedPostId = result.post_id;
      } else {
        const result = await vkApi('wall.post', {
          owner_id: `-${task.groupId}`,
          from_group: 1,
          message: task.message,
          attachments: task.attachments?.join(',')
        }, account.token);
        publishedPostId = result.post_id;
      }
      
      task.status = 'completed';
      task.result = 'Posted successfully';
      task.completedAt = now;
      task.publishedPostId = publishedPostId;
      
      if (task.autoCommentText && publishedPostId) {
        const commentTask = {
          id: Date.now().toString() + '_comment',
          ownerId: `-${task.groupId}`,
          postId: publishedPostId,
          commentText: task.autoCommentText,
          commentAt: now + 5000,
          fromGroup: true,
          status: 'pending',
          createdAt: now
        };
        data.scheduledComments.push(commentTask);
      }
      
      if (task.autoDeleteAfter && publishedPostId) {
        const deleteTask = {
          id: Date.now().toString() + '_delete',
          ownerId: `-${task.groupId}`,
          postId: publishedPostId,
          deleteAt: now + task.autoDeleteAfter,
          status: 'pending',
          createdAt: now
        };
        data.scheduledDeletions.push(deleteTask);
      }
      
      data.taskHistory.push({
        type: 'post',
        taskId: task.id,
        groupId: task.groupId,
        postId: publishedPostId,
        success: true,
        timestamp: now
      });
      
      console.log(`[CRON] Post ${task.id} completed`);
    } catch (e) {
      task.status = 'error';
      task.result = e.message;
      
      data.taskHistory.push({
        type: 'post',
        taskId: task.id,
        groupId: task.groupId,
        success: false,
        error: e.message,
        timestamp: now
      });
    }
    
    await delay(1000);
  }
  
  // ===== Отложенные комментарии =====
  const pendingComments = data.scheduledComments.filter(c => 
    c.status === 'pending' && c.commentAt <= now
  );
  
  for (const task of pendingComments) {
    const account = data.accounts[0];
    if (!account) {
      task.status = 'error';
      task.result = 'No accounts available';
      continue;
    }
    
    try {
      await vkApi('wall.createComment', {
        owner_id: task.ownerId,
        post_id: task.postId,
        message: task.commentText,
        from_group: task.fromGroup ? Math.abs(parseInt(task.ownerId)) : 0
      }, account.token);
      
      task.status = 'completed';
      task.completedAt = now;
      
      console.log(`[CRON] Comment ${task.id} completed`);
    } catch (e) {
      if (task.retries < 3) {
        task.retries++;
        task.commentAt = now + 60000;
      } else {
        task.status = 'error';
        task.result = e.message;
      }
    }
    
    await delay(1000);
  }
  
  // ===== Автоудаление =====
  const pendingDeletions = data.scheduledDeletions.filter(d => 
    d.status === 'pending' && d.deleteAt <= now
  );
  
  for (const task of pendingDeletions) {
    const account = data.accounts[0];
    if (!account) {
      task.status = 'error';
      task.result = 'No accounts available';
      continue;
    }
    
    try {
      await vkApi('wall.delete', {
        owner_id: task.ownerId,
        post_id: task.postId
      }, account.token);
      
      task.status = 'completed';
      task.completedAt = now;
      
      console.log(`[CRON] Deletion ${task.id} completed`);
    } catch (e) {
      task.status = 'error';
      task.result = e.message;
    }
    
    await delay(500);
  }
  
  // ===== Автолайки =====
  if (data.autolikeSettings?.enabled && data.accounts.length > 0 && data.autolikeSettings.groups?.length > 0) {
    const settings = data.autolikeSettings;
    
    const intervalMs = (settings.intervalMinutes || 10) * 60 * 1000;
    if (settings.lastCheck && (now - settings.lastCheck) < intervalMs) {
      // Skip
    } else {
      console.log(`[AUTOLIKE] Starting autolike check`);
      const processedSet = new Set(settings.processedPosts || []);
      const newProcessed = [];
      let likesAdded = 0;
      
      for (const groupId of (settings.groups || [])) {
        try {
          const result = await vkApi('wall.get', {
            owner_id: `-${groupId}`,
            count: 10,
            filter: settings.onlyFromGroup ? 'owner' : 'all'
          }, data.accounts[0].token);
          
          for (const post of (result.items || [])) {
            const postKey = `wall${post.owner_id}_${post.id}`;
            
            if (processedSet.has(postKey) || post.marked_as_ads || post.is_pinned === 1) continue;
            if (post.date < (now / 1000) - (14 * 24 * 60 * 60)) continue;
            
            for (const acc of data.accounts) {
              try {
                await vkApi('likes.add', {
                  type: 'post',
                  owner_id: post.owner_id,
                  item_id: post.id
                }, acc.token);
                
                likesAdded++;
                await delay(Math.random() * 1500 + 1500);
              } catch (e) {
                if (!e.message.includes('Already liked')) {
                  console.log(`[AUTOLIKE] Error: ${e.message}`);
                }
              }
            }
            
            newProcessed.push(postKey);
            await delay(1000);
          }
        } catch (e) {
          console.error(`[AUTOLIKE] Group ${groupId} error:`, e.message);
        }
      }
      
      settings.processedPosts = [...(settings.processedPosts || []), ...newProcessed].slice(-500);
      settings.lastCheck = now;
      
      const todayDate = new Date().toISOString().split('T')[0];
      const isNewDay = settings.stats?.todayDate !== todayDate;
      
      settings.stats = {
        total: (settings.stats?.total || 0) + likesAdded,
        today: isNewDay ? likesAdded : (settings.stats?.today || 0) + likesAdded,
        todayDate: todayDate
      };
      
      if (likesAdded > 0) {
        console.log(`[AUTOLIKE] Added ${likesAdded} likes`);
      }
    }
  }
  
  saveData();
  
  if (data.taskHistory.length > 1000) {
    data.taskHistory = data.taskHistory.slice(-1000);
  }
});

// Очистка выполненных задач
cron.schedule('0 * * * *', () => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  
  data.scheduledPosts = data.scheduledPosts.filter(p => 
    p.status === 'pending' || p.completedAt > oneDayAgo
  );
  
  data.scheduledComments = data.scheduledComments.filter(c => 
    c.status === 'pending' || c.completedAt > oneDayAgo
  );
  
  data.scheduledDeletions = data.scheduledDeletions.filter(d => 
    d.status === 'pending' || d.completedAt > oneDayAgo
  );
  
  data.scheduledStories = data.scheduledStories.filter(s => 
    s.status === 'pending' || s.completedAt > oneDayAgo
  );
  
  saveData();
  console.log('[CRON] Cleaned up old tasks');
});

// ==================== START SERVER ====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 VK Automation Server running on port ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}`);
  console.log(`🔑 Accounts: ${data.accounts.length}`);
  console.log(`📋 Scheduled posts: ${data.scheduledPosts.filter(p => p.status === 'pending').length}`);
  console.log(`📸 Scheduled stories: ${data.scheduledStories.filter(s => s.status === 'pending').length}`);
});

process.on('SIGINT', () => {
  saveData();
  console.log('Data saved. Exiting...');
  process.exit(0);
});
