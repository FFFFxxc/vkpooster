/**
 * VK Automation Server
 * Сервер для автоматизации VK Reposter Pro
 * Работает 24/7 даже когда браузер выключен
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    accounts: data.accounts.length,
    scheduledPosts: data.scheduledPosts.length,
    scheduledComments: data.scheduledComments.length,
    scheduledDeletions: data.scheduledDeletions.length
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
    if (autoDeleteAfter) console.log(`[POST] Auto-delete after ${autoDeleteAfter}ms`);
    if (autoCommentText) console.log(`[POST] Auto-comment: "${autoCommentText.substring(0, 30)}..."`);
    
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

// ==================== ОТЛОЖЕННЫЕ КОММЕНТАРИИ ====================

// Добавить отложенный комментарий
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
    
    console.log(`[COMMENT] Scheduled comment for post ${ownerId}_${postId} at ${new Date(commentAt).toISOString()}`);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Получить все отложенные комментарии
app.get('/api/scheduled-comments', (req, res) => {
  const comments = data.scheduledComments.filter(c => c.status === 'pending');
  res.json({ ok: true, comments });
});

// Удалить отложенный комментарий
app.delete('/api/scheduled-comments/:id', (req, res) => {
  const { id } = req.params;
  data.scheduledComments = data.scheduledComments.filter(c => c.id !== id);
  saveData();
  res.json({ ok: true });
});

// ==================== АВТОУДАЛЕНИЕ ====================

// Добавить задачу на автоудаление
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
    
    console.log(`[DELETE] Scheduled deletion for post ${ownerId}_${postId} at ${new Date(deleteAt).toISOString()}`);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== АВТОЛАЙКИ ====================

// Сохранить настройки автолайков
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

// Получить настройки автолайков
app.get('/api/autolike-settings', (req, res) => {
  res.json({ ok: true, settings: data.autolikeSettings });
});

// ==================== VK API PROXY ====================

// Прокси для VK API запросов (для обхода CORS)
app.post('/api/vk/:method', async (req, res) => {
  try {
    const { method } = req.params;
    const { token, ...params } = req.body;
    
    if (!token) {
      return res.status(400).json({ ok: false, error: 'Token required' });
    }
    
    const result = await vkApi(method, params, token);
    res.json({ ok: true, response: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, code: e.code });
  }
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
  
  // ===== Отложенные посты =====
  const pendingPosts = data.scheduledPosts.filter(p => 
    p.status === 'pending' && p.publishDate <= now
  );
  
  for (const task of pendingPosts) {
    console.log(`[CRON] Processing scheduled post ${task.id}`);
    
    const account = data.accounts[0]; // Используем первый аккаунт
    if (!account) {
      task.status = 'error';
      task.result = 'No accounts available';
      continue;
    }
    
    try {
      let publishedPostId = null;
      
      // Если есть исходный пост - копируем его
      if (task.sourcePost) {
        // Получаем пост
        const postData = await vkApi('wall.getById', {
          posts: `${task.sourcePost.ownerId}_${task.sourcePost.postId}`
        }, account.token);
        
        const post = postData.items?.[0];
        if (!post) throw new Error('Source post not found');
        
        // Копируем вложения
        let attachments = [];
        if (post.attachments) {
          for (const att of post.attachments) {
            const type = att.type;
            const obj = att[type];
            if (type === 'photo') {
              attachments.push(`photo${obj.owner_id}_${obj.id}`);
            } else if (type === 'video') {
              const ak = obj.access_key ? `_${obj.access_key}` : '';
              attachments.push(`video${obj.owner_id}_${obj.id}${ak}`);
            }
          }
        }
        
        // Публикуем
        const result = await vkApi('wall.post', {
          owner_id: `-${task.groupId}`,
          from_group: 1,
          message: task.message || post.text || '',
          attachments: attachments.join(',')
        }, account.token);
        publishedPostId = result.post_id;
      } else {
        // Обычный пост
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
      
      // Создаём задачу на автокомментарий
      if (task.autoCommentText && publishedPostId) {
        const commentTask = {
          id: Date.now().toString() + '_comment',
          ownerId: `-${task.groupId}`,
          postId: publishedPostId,
          commentText: task.autoCommentText,
          commentAt: now + 5000, // Через 5 секунд после публикации
          fromGroup: true,
          status: 'pending',
          createdAt: now
        };
        data.scheduledComments.push(commentTask);
        console.log(`[CRON] Auto-comment scheduled for post ${publishedPostId}`);
      }
      
      // Создаём задачу на автоудаление
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
        console.log(`[CRON] Auto-delete scheduled for post ${publishedPostId} at ${new Date(deleteTask.deleteAt).toISOString()}`);
      }
      
      // Добавляем в историю
      data.taskHistory.push({
        type: 'post',
        taskId: task.id,
        groupId: task.groupId,
        postId: publishedPostId,
        success: true,
        timestamp: now
      });
      
      console.log(`[CRON] Post ${task.id} completed, postId: ${publishedPostId}`);
    } catch (e) {
      task.status = 'error';
      task.result = e.message;
      console.error(`[CRON] Post ${task.id} error:`, e.message);
      
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
    console.log(`[CRON] Processing scheduled comment ${task.id}`);
    
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
      task.result = 'Comment posted';
      task.completedAt = now;
      
      data.taskHistory.push({
        type: 'comment',
        taskId: task.id,
        postId: `${task.ownerId}_${task.postId}`,
        success: true,
        timestamp: now
      });
      
      console.log(`[CRON] Comment ${task.id} completed`);
    } catch (e) {
      // Повторяем до 3 раз
      if (task.retries < 3) {
        task.retries++;
        task.commentAt = now + 60000; // Через минуту
        console.log(`[CRON] Comment ${task.id} retry ${task.retries}`);
      } else {
        task.status = 'error';
        task.result = e.message;
        console.error(`[CRON] Comment ${task.id} error:`, e.message);
      }
      
      data.taskHistory.push({
        type: 'comment',
        taskId: task.id,
        success: false,
        error: e.message,
        timestamp: now
      });
    }
    
    await delay(1000);
  }
  
  // ===== Автоудаление =====
  const pendingDeletions = data.scheduledDeletions.filter(d => 
    d.status === 'pending' && d.deleteAt <= now
  );
  
  for (const task of pendingDeletions) {
    console.log(`[CRON] Processing scheduled deletion ${task.id}`);
    
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
      task.result = 'Post deleted';
      task.completedAt = now;
      
      data.taskHistory.push({
        type: 'deletion',
        taskId: task.id,
        postId: `${task.ownerId}_${task.postId}`,
        success: true,
        timestamp: now
      });
      
      console.log(`[CRON] Deletion ${task.id} completed`);
    } catch (e) {
      task.status = 'error';
      task.result = e.message;
      console.error(`[CRON] Deletion ${task.id} error:`, e.message);
    }
    
    await delay(500);
  }
  
  // ===== Автолайки =====
  if (data.autolikeSettings?.enabled && data.accounts.length > 0) {
    const settings = data.autolikeSettings;
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
    
    // Обновляем настройки
    settings.processedPosts = [...(settings.processedPosts || []), ...newProcessed].slice(-500);
    settings.lastCheck = now;
    settings.stats = {
      total: (settings.stats?.total || 0) + likesAdded,
      today: (settings.stats?.today || 0) + likesAdded,
      todayDate: new Date().toISOString().split('T')[0]
    };
    
    if (likesAdded > 0) {
      console.log(`[AUTOLIKE] Added ${likesAdded} likes`);
    }
  }
  
  // Сохраняем изменения
  saveData();
  
  // Очищаем старую историю (оставляем последние 1000 записей)
  if (data.taskHistory.length > 1000) {
    data.taskHistory = data.taskHistory.slice(-1000);
  }
});

// Очистка выполненных задач (каждый час)
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
  
  saveData();
  console.log('[CRON] Cleaned up old tasks');
});

// ==================== START SERVER ====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 VK Automation Server running on port ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}`);
  console.log(`🔑 Accounts: ${data.accounts.length}`);
  console.log(`📋 Scheduled posts: ${data.scheduledPosts.filter(p => p.status === 'pending').length}`);
  console.log(`💬 Scheduled comments: ${data.scheduledComments.filter(c => c.status === 'pending').length}`);
});

// Сохраняем данные при завершении
process.on('SIGINT', () => {
  saveData();
  console.log('Data saved. Exiting...');
  process.exit(0);
});