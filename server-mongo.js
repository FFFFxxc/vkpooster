/**
 * VK Automation Server v3.0 - MongoDB Version
 * ИСПРАВЛЕНО: публикация историй ВК
 * v3.0 - Добавлена поддержка рекламных историй с кнопками-ссылками
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const FormData = require('form-data');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('=== VK AUTOMATION SERVER v3.0 (MongoDB) ===');
console.log('=== AD STORIES WITH LINK BUTTONS ENABLED ===');

app.use(cors());
app.use(express.json({ limit: '100mb' }));

const VK_VERSION = '5.199';

// ==================== MONGODB ====================

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set!');
}

const accountSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  token: { type: String, required: true },
  name: String,
  photo: String,
  addedAt: { type: Date, default: Date.now }
});

const scheduledPostSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  groupId: { type: Number, required: true },
  message: String,
  attachments: [String],
  publishDate: { type: Number, required: true },
  sourcePost: { ownerId: Number, postId: Number },
  autoDeleteAfter: Number,
  autoCommentText: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  result: String,
  publishedPostId: Number,
  failedAt: Number,
  retryCount: { type: Number, default: 0 }
});

const scheduledStorySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  groupId: { type: Number, required: true },
  groupName: String,
  fileData: String,        // base64
  fileType: { type: String, default: 'photo' },
  publishDate: { type: Number, required: true },
  caption: String,
  linkUrl: { type: String, default: null },
  linkText: { type: String, default: 'go_to' },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  result: String,
  storyId: String,
  failedAt: Number,
  retryCount: { type: Number, default: 0 }
});

const scheduledCommentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  ownerId: { type: Number, required: true },
  postId: { type: Number, required: true },
  commentText: { type: String, required: true },
  commentAt: { type: Number, required: true },
  fromGroup: { type: Boolean, default: false },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  retries: { type: Number, default: 0 }
});

const scheduledDeletionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  ownerId: { type: Number, required: true },
  postId: { type: Number, required: true },
  deleteAt: { type: Number, required: true },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  completedAt: Date
});

const autolikeSettingsSchema = new mongoose.Schema({
  id: { type: String, default: 'main', unique: true },
  enabled: { type: Boolean, default: false },
  intervalMinutes: { type: Number, default: 10 },
  onlyFromGroup: { type: Boolean, default: true },
  groups: [String],
  processedPosts: [String],
  lastCheck: Number,
  stats: {
    today: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    todayDate: String
  },
  lastUpdate: { type: Date, default: Date.now }
});

const taskHistorySchema = new mongoose.Schema({
  type: String,
  taskId: String,
  groupId: Number,
  postId: Number,
  storyId: String,
  success: Boolean,
  error: String,
  timestamp: { type: Date, default: Date.now }
});

let Account, ScheduledPost, ScheduledStory, ScheduledComment, 
    ScheduledDeletion, AutolikeSettings, TaskHistory;

let memoryData = {
  accounts: [],
  scheduledPosts: [],
  scheduledStories: [],
  scheduledComments: [],
  scheduledDeletions: [],
  autolikeSettings: null,
  taskHistory: []
};

async function connectDB() {
  if (!MONGODB_URI) {
    console.log('⚠️ Memory-only mode');
    return false;
  }
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('✅ MongoDB connected');
    Account = mongoose.model('Account', accountSchema);
    ScheduledPost = mongoose.model('ScheduledPost', scheduledPostSchema);
    ScheduledStory = mongoose.model('ScheduledStory', scheduledStorySchema);
    ScheduledComment = mongoose.model('ScheduledComment', scheduledCommentSchema);
    ScheduledDeletion = mongoose.model('ScheduledDeletion', scheduledDeletionSchema);
    AutolikeSettings = mongoose.model('AutolikeSettings', autolikeSettingsSchema);
    TaskHistory = mongoose.model('TaskHistory', taskHistorySchema);
    return true;
  } catch (e) {
    console.error('❌ MongoDB failed:', e.message);
    return false;
  }
}

let useMongoDB = false;

// ==================== VK API (GET - для обычных методов) ====================

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

// ==================== VK API (POST - для stories.save и других) ====================
// ИСПРАВЛЕНИЕ #1: stories.save нужен POST с телом, а не GET через URL

async function vkApiPost(method, params, token) {
  const url = `https://api.vk.com/method/${method}`;

  // Собираем тело запроса
  const body = new URLSearchParams();
  body.set('access_token', token);
  body.set('v', VK_VERSION);

  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') {
      body.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const result = await response.json();

  if (result.error) {
    const error = new Error(result.error.error_msg);
    error.code = result.error.error_code;
    throw error;
  }

  return result.response;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== ROUTES ====================

app.get('/', async (req, res) => {
  try {
    let counts = { accounts: 0, posts: 0, comments: 0, deletions: 0, stories: 0 };

    if (useMongoDB) {
      counts.accounts   = await Account.countDocuments();
      counts.posts      = await ScheduledPost.countDocuments({ status: 'pending' });
      counts.comments   = await ScheduledComment.countDocuments({ status: 'pending' });
      counts.deletions  = await ScheduledDeletion.countDocuments({ status: 'pending' });
      counts.stories    = await ScheduledStory.countDocuments({ status: 'pending' });
    } else {
      counts.accounts   = memoryData.accounts.length;
      counts.posts      = memoryData.scheduledPosts.filter(p => p.status === 'pending').length;
      counts.comments   = memoryData.scheduledComments.filter(c => c.status === 'pending').length;
      counts.deletions  = memoryData.scheduledDeletions.filter(d => d.status === 'pending').length;
      counts.stories    = memoryData.scheduledStories.filter(s => s.status === 'pending').length;
    }

    res.json({
      status: 'online',
      version: '3.2.0-fixed-stories',
      uptime: Math.floor(process.uptime()),
      database: useMongoDB ? 'MongoDB' : 'Memory',
      accounts: counts.accounts,
      scheduledPosts: counts.posts,
      scheduledComments: counts.comments,
      scheduledDeletions: counts.deletions,
      scheduledStories: counts.stories
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', database: useMongoDB ? 'MongoDB' : 'Memory' });
});

// ==================== АККАУНТЫ ====================

app.post('/api/accounts', async (req, res) => {
  try {
    const { token, userId, name, photo } = req.body;
    if (!token || !userId) {
      return res.status(400).json({ ok: false, error: 'Token and userId required' });
    }
    const account = {
      userId, token,
      name: name || `User ${userId}`,
      photo: photo || 'https://vk.com/images/camera_50.png',
      addedAt: Date.now()
    };
    if (useMongoDB) {
      await Account.findOneAndUpdate({ userId }, account, { upsert: true, new: true });
    } else {
      const idx = memoryData.accounts.findIndex(a => a.userId === userId);
      if (idx >= 0) memoryData.accounts[idx] = account;
      else memoryData.accounts.push(account);
    }
    res.json({ ok: true, account: { ...account, token: '***' } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    let accounts;
    if (useMongoDB) {
      const docs = await Account.find({});
      accounts = docs.map(a => ({ userId: a.userId, name: a.name, photo: a.photo, addedAt: a.addedAt }));
    } else {
      accounts = memoryData.accounts.map(a => ({ userId: a.userId, name: a.name, photo: a.photo, addedAt: a.addedAt }));
    }
    res.json({ ok: true, accounts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Получить все аккаунты С ТОКЕНАМИ (для синхронизации расширения)
app.get('/api/accounts/full', async (req, res) => {
  try {
    let accounts;
    if (useMongoDB) {
      const docs = await Account.find({});
      accounts = docs.map(a => ({
        userId: a.userId,
        token: a.token,
        name: a.name,
        photo: a.photo,
        addedAt: a.addedAt
      }));
    } else {
      accounts = memoryData.accounts.map(a => ({
        userId: a.userId,
        token: a.token,
        name: a.name,
        photo: a.photo,
        addedAt: a.addedAt
      }));
    }
    res.json({ ok: true, accounts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/accounts/:userId', async (req, res) => {
  try {
    if (useMongoDB) await Account.deleteOne({ userId: parseInt(req.params.userId) });
    else memoryData.accounts = memoryData.accounts.filter(a => a.userId !== parseInt(req.params.userId));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== ПОСТЫ ====================

app.post('/api/scheduled-posts', async (req, res) => {
  try {
    const { groupId, message, attachments, publishDate, ownerId, postId, autoDeleteAfter, autoCommentText } = req.body;
    if (!groupId || !publishDate) return res.status(400).json({ ok: false, error: 'groupId and publishDate required' });
    const task = {
      id: Date.now().toString(),
      groupId, message: message || '',
      attachments: attachments || [],
      publishDate,
      sourcePost: (ownerId && postId) ? { ownerId, postId } : null,
      autoDeleteAfter: autoDeleteAfter || null,
      autoCommentText: autoCommentText || null,
      status: 'pending', createdAt: Date.now()
    };
    if (useMongoDB) await ScheduledPost.create(task);
    else memoryData.scheduledPosts.push(task);
    console.log(`[POST] Scheduled for group ${groupId} at ${new Date(publishDate).toISOString()}`);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/scheduled-posts', async (req, res) => {
  try {
    // Включаем error/processing, чтобы клиент мог показать упавшие задачи и кнопку «Выложить ещё раз»
    const visibleStatuses = ['pending', 'error', 'processing'];
    const posts = useMongoDB
      ? await ScheduledPost.find({ status: { $in: visibleStatuses } })
      : memoryData.scheduledPosts.filter(p => visibleStatuses.includes(p.status));
    res.json({ ok: true, posts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/scheduled-posts/:id', async (req, res) => {
  try {
    if (useMongoDB) await ScheduledPost.deleteOne({ id: req.params.id });
    else memoryData.scheduledPosts = memoryData.scheduledPosts.filter(p => p.id !== req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Редактировать отложенный пост (текст и/или автокоммент)
app.patch('/api/scheduled-posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { message, autoCommentText } = req.body || {};

    const update = {};
    if (typeof message === 'string') update.message = message;
    if (autoCommentText === null || autoCommentText === '') {
      update.autoCommentText = null;
    } else if (typeof autoCommentText === 'string') {
      update.autoCommentText = autoCommentText;
    }

    if (useMongoDB) {
      const task = await ScheduledPost.findOne({ id });
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
      if (task.status !== 'pending') {
        return res.status(400).json({ ok: false, error: 'Task already processed' });
      }
      await ScheduledPost.updateOne({ id }, { $set: update });
      const updated = await ScheduledPost.findOne({ id });
      res.json({ ok: true, task: updated });
    } else {
      const task = memoryData.scheduledPosts.find(p => p.id === id);
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
      if (task.status !== 'pending') {
        return res.status(400).json({ ok: false, error: 'Task already processed' });
      }
      Object.assign(task, update);
      res.json({ ok: true, task });
    }
    console.log(`[PATCH] Updated post ${id}`);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Перенести отложенный пост в нативную отложку VK
app.post('/api/scheduled-posts/:id/move-to-vk', async (req, res) => {
  try {
    const { id } = req.params;

    let task;
    if (useMongoDB) {
      task = await ScheduledPost.findOne({ id });
    } else {
      task = memoryData.scheduledPosts.find(p => p.id === id);
    }
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
    if (task.status !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Task already processed' });
    }

    const account = await getFirstAccount();
    if (!account) return res.status(400).json({ ok: false, error: 'No accounts on server' });

    const publishUnix = Math.floor(task.publishDate / 1000);
    if (publishUnix <= Math.floor(Date.now() / 1000)) {
      return res.status(400).json({ ok: false, error: 'Publish date is in the past' });
    }

    let attachments = [];
    let messageText = task.message || '';

    if (task.sourcePost) {
      const postData = await vkApi('wall.getById', {
        posts: `${task.sourcePost.ownerId}_${task.sourcePost.postId}`
      }, account.token);
      const src = postData.items?.[0];
      if (!src) throw new Error('Source post not found');

      if (!messageText) messageText = src.text || '';

      if (src.attachments) {
        for (const att of src.attachments) {
          const type = att.type;
          const obj = att[type];
          if (type === 'photo') {
            try {
              const sizes = obj.sizes || [];
              const best = sizes[sizes.length - 1];
              if (best?.url) {
                const imgResp = await fetch(best.url);
                const imgBuffer = await imgResp.buffer();
                const uploadServer = await vkApi('photos.getWallUploadServer', {
                  group_id: task.groupId
                }, account.token);
                const form = new FormData();
                form.append('photo', imgBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
                const upResp = await fetch(uploadServer.upload_url, {
                  method: 'POST', body: form, headers: form.getHeaders()
                });
                const upResult = await upResp.json();
                if (upResult.photo && upResult.server !== undefined && upResult.hash) {
                  const saved = await vkApi('photos.saveWallPhoto', {
                    group_id: task.groupId,
                    photo: upResult.photo,
                    server: upResult.server,
                    hash: upResult.hash
                  }, account.token);
                  if (saved?.[0]) attachments.push(`photo${saved[0].owner_id}_${saved[0].id}`);
                }
                await delay(400);
              }
            } catch (photoErr) {
              console.error('[MOVE] photo re-upload error:', photoErr.message);
            }
          } else if (type === 'video') {
            const ak = obj.access_key ? `_${obj.access_key}` : '';
            attachments.push(`video${obj.owner_id}_${obj.id}${ak}`);
          } else if (type === 'doc') {
            attachments.push(`doc${obj.owner_id}_${obj.id}`);
          }
        }
      }
    } else if (Array.isArray(task.attachments)) {
      attachments = task.attachments;
    }

    const result = await vkApi('wall.post', {
      owner_id: `-${task.groupId}`,
      from_group: 1,
      message: messageText,
      attachments: attachments.join(','),
      publish_date: publishUnix
    }, account.token);

    if (useMongoDB) {
      await ScheduledPost.deleteOne({ id });
    } else {
      memoryData.scheduledPosts = memoryData.scheduledPosts.filter(p => p.id !== id);
    }

    console.log(`[MOVE] Post ${id} -> VK native scheduled (post_id=${result.post_id})`);
    res.json({ ok: true, postId: result.post_id });
  } catch (e) {
    console.error('[MOVE] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Перевыложить упавший / висящий пост
app.post('/api/scheduled-posts/:id/reschedule', async (req, res) => {
  try {
    const { id } = req.params;
    let { publishDate } = req.body || {};

    // Если время не передали или оно в прошлом — публикуем максимально скоро (через минуту)
    const minDate = Date.now() + 60 * 1000;
    if (!publishDate || publishDate < minDate) {
      publishDate = minDate;
    }

    const update = {
      status: 'pending',
      publishDate,
      result: null,
      completedAt: null,
      failedAt: null
    };

    if (useMongoDB) {
      const task = await ScheduledPost.findOne({ id });
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
      if (task.status === 'completed') {
        return res.status(400).json({ ok: false, error: 'Task already published' });
      }
      await ScheduledPost.updateOne({ id }, {
        $set: update,
        $inc: { retryCount: 1 }
      });
      const updated = await ScheduledPost.findOne({ id });
      console.log(`[RESCHEDULE] Post ${id} -> ${new Date(publishDate).toISOString()} (retry #${updated.retryCount})`);
      res.json({ ok: true, task: updated });
    } else {
      const task = memoryData.scheduledPosts.find(p => p.id === id);
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
      if (task.status === 'completed') {
        return res.status(400).json({ ok: false, error: 'Task already published' });
      }
      Object.assign(task, update);
      task.retryCount = (task.retryCount || 0) + 1;
      console.log(`[RESCHEDULE] Post ${id} -> ${new Date(publishDate).toISOString()} (retry #${task.retryCount})`);
      res.json({ ok: true, task });
    }
  } catch (e) {
    console.error('[RESCHEDULE] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== ИСТОРИИ ====================

app.post('/api/scheduled-stories', async (req, res) => {
  try {
    const { groupId, groupName, fileData, fileType, publishDate, caption, linkUrl, linkText } = req.body;
    
    // ДОБАВЛЕНО: Логирование запроса
    console.log('[API] Received scheduled story request:', {
      groupId,
      groupName,
      fileType,
      publishDate,
      hasFileData: !!fileData,
      fileDataLength: fileData?.length,
      caption,
      linkUrl,
      linkText
    });
    
    if (!groupId || !fileData || !publishDate) {
      return res.status(400).json({ ok: false, error: 'groupId, fileData and publishDate required' });
    }
    const task = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      groupId, groupName: groupName || '',
      fileData, fileType: fileType || 'photo',
      publishDate, caption: caption || '',
      linkUrl: linkUrl || null,
      linkText: linkText || 'go_to',
      status: 'pending', createdAt: Date.now()
    };
    if (useMongoDB) await ScheduledStory.create(task);
    else memoryData.scheduledStories.push(task);
    console.log(`[STORY] Scheduled for group ${groupId} at ${new Date(publishDate).toISOString()}${linkUrl ? ' with link: ' + linkUrl : ''}`);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/scheduled-stories', async (req, res) => {
  try {
    const visibleStatuses = ['pending', 'error', 'processing'];
    const stories = useMongoDB
      ? await ScheduledStory.find({ status: { $in: visibleStatuses } })
      : memoryData.scheduledStories.filter(s => visibleStatuses.includes(s.status));
    res.json({ ok: true, stories });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/scheduled-stories/:id', async (req, res) => {
  try {
    if (useMongoDB) await ScheduledStory.deleteOne({ id: req.params.id });
    else memoryData.scheduledStories = memoryData.scheduledStories.filter(s => s.id !== req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Перевыложить упавшую историю
app.post('/api/scheduled-stories/:id/reschedule', async (req, res) => {
  try {
    const { id } = req.params;
    let { publishDate } = req.body || {};

    const minDate = Date.now() + 60 * 1000;
    if (!publishDate || publishDate < minDate) {
      publishDate = minDate;
    }

    const update = {
      status: 'pending',
      publishDate,
      result: null,
      completedAt: null,
      failedAt: null
    };

    if (useMongoDB) {
      const task = await ScheduledStory.findOne({ id });
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
      if (task.status === 'completed') {
        return res.status(400).json({ ok: false, error: 'Story already published' });
      }
      await ScheduledStory.updateOne({ id }, {
        $set: update,
        $inc: { retryCount: 1 }
      });
      const updated = await ScheduledStory.findOne({ id });
      console.log(`[RESCHEDULE] Story ${id} -> ${new Date(publishDate).toISOString()} (retry #${updated.retryCount})`);
      res.json({ ok: true, task: updated });
    } else {
      const task = memoryData.scheduledStories.find(s => s.id === id);
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
      if (task.status === 'completed') {
        return res.status(400).json({ ok: false, error: 'Story already published' });
      }
      Object.assign(task, update);
      task.retryCount = (task.retryCount || 0) + 1;
      console.log(`[RESCHEDULE] Story ${id} -> ${new Date(publishDate).toISOString()} (retry #${task.retryCount})`);
      res.json({ ok: true, task });
    }
  } catch (e) {
    console.error('[RESCHEDULE story] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== ТЕСТ ИСТОРИИ (для отладки) ====================
// Вызови: POST /api/test-story { "groupId": 123456 }

app.post('/api/test-story', async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ ok: false, error: 'groupId required' });

  const account = await getFirstAccount();
  if (!account) return res.status(400).json({ ok: false, error: 'No accounts configured' });

  try {
    const uploadServer = await vkApi('stories.getPhotoUploadServer', {
      group_id: groupId,
      add_to_news: 1
    }, account.token);

    res.json({
      ok: true,
      message: 'Upload server received successfully',
      hasUploadUrl: !!uploadServer?.upload_url,
      uploadUrlPreview: uploadServer?.upload_url?.substring(0, 80) + '...',
      fullResponse: uploadServer
    });
  } catch (e) {
    res.json({
      ok: false,
      error: e.message,
      errorCode: e.code,
      hint: e.code === 15 ? 'Нет прав на истории (нужен токен с правом stories)' :
            e.code === 7  ? 'Нет прав администратора в группе' :
            e.code === 5  ? 'Токен недействителен' : 'Неизвестная ошибка'
    });
  }
});

// ==================== ПОЛНЫЙ ТЕСТ ЗАГРУЗКИ ИСТОРИИ ====================
app.post('/api/test-story-upload', async (req, res) => {
  const { groupId, fileData, fileType } = req.body;
  if (!groupId || !fileData) {
    return res.status(400).json({ ok: false, error: 'groupId and fileData required' });
  }

  const account = await getFirstAccount();
  if (!account) {
    return res.status(400).json({ ok: false, error: 'No accounts' });
  }

  const log = []; // Собираем лог каждого шага

  try {
    // ШАГ 1: Получаем upload URL
    log.push('Step 1: Getting upload URL...');
    const uploadServer = await vkApi('stories.getPhotoUploadServer', {
      group_id: groupId,
      add_to_news: 1
    }, account.token);
    log.push(`Step 1 OK: upload_url received`);

    // ШАГ 2: Декодируем файл
    log.push('Step 2: Decoding base64...');
    let base64Data = fileData;
    if (base64Data.includes(',')) {
      base64Data = base64Data.split(',')[1];
    }
    const fileBuffer = Buffer.from(base64Data, 'base64');
    log.push(`Step 2 OK: buffer size = ${fileBuffer.length} bytes`);

    // ШАГ 3: Загружаем на VK
    log.push('Step 3: Uploading to VK...');
    const form = new FormData();
    form.append('photo', fileBuffer, {
      filename: 'story.jpg',
      contentType: 'image/jpeg'
    });

    const uploadResp = await fetch(uploadServer.upload_url, {
      method: 'POST',
      body: form,
      headers: form.getHeaders()
    });

    const uploadResultText = await uploadResp.text();
    log.push(`Step 3 response: ${uploadResultText.substring(0, 300)}`);

    let uploadResult;
    try {
      uploadResult = JSON.parse(uploadResultText);
    } catch(e) {
      return res.json({ ok: false, log, error: 'Upload response is not JSON', raw: uploadResultText.substring(0, 300) });
    }

    if (uploadResult.error) {
      return res.json({ ok: false, log, error: 'Upload error', detail: uploadResult.error });
    }

    // ИСПРАВЛЕНИЕ: VK оборачивает upload_result в response
    const actualUploadResult = uploadResult.upload_result 
      || uploadResult.response?.upload_result;

    if (!actualUploadResult) {
      return res.json({ 
        ok: false, log, 
        error: 'No upload_result field',
        uploadResultKeys: Object.keys(uploadResult),
        responseKeys: uploadResult.response ? Object.keys(uploadResult.response) : 'no response',
        uploadResult: uploadResult
      });
    }

    log.push(`Step 3 OK: upload_result length = ${actualUploadResult.length}`);

    // ШАГ 4: Сохраняем историю
    log.push('Step 4: Calling stories.save (POST)...');
    const saveResult = await vkApiPost('stories.save', {
      upload_results: actualUploadResult
    }, account.token);
    log.push(`Step 4 result: ${JSON.stringify(saveResult).substring(0, 300)}`);

    const storyId = saveResult?.items?.[0]?.id || 'unknown';
    log.push(`Step 4 OK: storyId = ${storyId}`);

    return res.json({ 
      ok: true, 
      log,
      storyId,
      message: 'Story published successfully!'
    });

  } catch (e) {
    log.push(`ERROR: ${e.message} (code: ${e.code})`);
    return res.json({ 
      ok: false, 
      log, 
      error: e.message,
      errorCode: e.code
    });
  }
});

// ==================== КОММЕНТАРИИ ====================

app.post('/api/scheduled-comments', async (req, res) => {
  try {
    const { ownerId, postId, commentText, commentAt, fromGroup } = req.body;
    if (!ownerId || !postId || !commentText || !commentAt) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    const task = {
      id: Date.now().toString(),
      ownerId, postId, commentText, commentAt,
      fromGroup: fromGroup || false,
      status: 'pending', createdAt: Date.now(), retries: 0
    };
    if (useMongoDB) await ScheduledComment.create(task);
    else memoryData.scheduledComments.push(task);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/scheduled-comments', async (req, res) => {
  try {
    const comments = useMongoDB
      ? await ScheduledComment.find({ status: 'pending' })
      : memoryData.scheduledComments.filter(c => c.status === 'pending');
    res.json({ ok: true, comments });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/scheduled-comments/:id', async (req, res) => {
  try {
    if (useMongoDB) await ScheduledComment.deleteOne({ id: req.params.id });
    else memoryData.scheduledComments = memoryData.scheduledComments.filter(c => c.id !== req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== АВТОУДАЛЕНИЕ ====================

app.post('/api/scheduled-deletions', async (req, res) => {
  try {
    const { ownerId, postId, deleteAt } = req.body;
    if (!ownerId || !postId || !deleteAt) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    const task = {
      id: Date.now().toString(),
      ownerId, postId, deleteAt,
      status: 'pending', createdAt: Date.now()
    };
    if (useMongoDB) await ScheduledDeletion.create(task);
    else memoryData.scheduledDeletions.push(task);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== АВТОЛАЙКИ ====================

app.post('/api/autolike-settings', async (req, res) => {
  try {
    const settings = { ...req.body, id: 'main', lastUpdate: Date.now() };
    if (useMongoDB) {
      await AutolikeSettings.findOneAndUpdate({ id: 'main' }, settings, { upsert: true, new: true });
    } else {
      memoryData.autolikeSettings = settings;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/autolike-settings', async (req, res) => {
  try {
    const settings = useMongoDB
      ? await AutolikeSettings.findOne({ id: 'main' })
      : memoryData.autolikeSettings;
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== ИСТОРИЯ ====================

app.get('/api/history', async (req, res) => {
  try {
    const history = useMongoDB
      ? await TaskHistory.find().sort({ timestamp: -1 }).limit(100)
      : memoryData.taskHistory.slice(-100).reverse();
    res.json({ ok: true, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== HELPERS ====================

async function getAccounts() {
  return useMongoDB ? await Account.find() : memoryData.accounts;
}

async function getFirstAccount() {
  const accounts = await getAccounts();
  return accounts[0] || null;
}

// ==================== ГЛАВНАЯ ФУНКЦИЯ ПУБЛИКАЦИИ ИСТОРИИ ====================
// ИСПРАВЛЕНО: VK возвращает upload_result внутри response!

async function publishStory(task, account) {
  const isVideo = task.fileType === 'video';

  console.log(`[STORY] Starting publish for group ${task.groupId}, type: ${task.fileType}`);
  console.log(`[STORY] Task data:`, {
    groupId: task.groupId,
    fileType: task.fileType,
    hasLinkUrl: !!task.linkUrl,
    linkUrl: task.linkUrl,
    linkText: task.linkText
  });

  // ШАГ 1: Получаем upload URL (БЕЗ параметров ссылки!)
  const uploadServerMethod = isVideo
    ? 'stories.getVideoUploadServer'
    : 'stories.getPhotoUploadServer';

  const uploadServer = await vkApi(uploadServerMethod, {
    group_id: task.groupId,
    add_to_news: 1
  }, account.token);

  console.log(`[STORY] Got upload server: ${!!uploadServer?.upload_url}`);

  if (!uploadServer?.upload_url) {
    throw new Error(`No upload_url: ${JSON.stringify(uploadServer)}`);
  }

  // ШАГ 2: Декодируем base64
  let base64Data = task.fileData;
  if (base64Data.includes(',')) {
    base64Data = base64Data.split(',')[1];
  }
  const fileBuffer = Buffer.from(base64Data, 'base64');
  console.log(`[STORY] File buffer: ${fileBuffer.length} bytes`);

  if (fileBuffer.length < 1000) {
    throw new Error(`File too small: ${fileBuffer.length} bytes`);
  }

  // ШАГ 3: Загружаем файл
  const form = new FormData();
  if (isVideo) {
    form.append('video_file', fileBuffer, {
      filename: 'story.mp4',
      contentType: 'video/mp4'
    });
  } else {
    form.append('photo', fileBuffer, {
      filename: 'story.jpg',
      contentType: 'image/jpeg'
    });
  }

  const uploadResp = await fetch(uploadServer.upload_url, {
    method: 'POST',
    body: form,
    headers: form.getHeaders()
  });

  const uploadResultText = await uploadResp.text();
  console.log(`[STORY] Upload response: ${uploadResultText.substring(0, 300)}`);

  let uploadResult;
  try {
    uploadResult = JSON.parse(uploadResultText);
  } catch (e) {
    throw new Error(`Not JSON: ${uploadResultText.substring(0, 200)}`);
  }

  // Проверяем ошибку
  if (uploadResult.error) {
    const errMsg = typeof uploadResult.error === 'object'
      ? (uploadResult.error.error_msg || JSON.stringify(uploadResult.error))
      : uploadResult.error;
    throw new Error(`Upload error: ${errMsg}`);
  }

  // Получаем upload_result
  const actualUploadResult = uploadResult.upload_result
    || uploadResult.response?.upload_result;

  console.log(`[STORY] upload_result found: ${!!actualUploadResult}`);

  if (!actualUploadResult) {
    // Проверяем автосохранение
    if (uploadResult.response?.items?.length > 0) {
      const storyId = uploadResult.response.items[0].id;
      console.log(`[STORY] Auto-published, storyId: ${storyId}`);
      return String(storyId);
    }
    throw new Error(
      `Нет upload_result. Ключи: ${Object.keys(uploadResult).join(', ')}. ` +
      `Response ключи: ${Object.keys(uploadResult.response || {}).join(', ')}`
    );
  }

  // ШАГ 4: Подготавливаем параметры для stories.save
  console.log(`[STORY] Calling stories.save...`);
  
  const saveParams = {
    upload_results: actualUploadResult
  };
  
  // ДОБАВЛЯЕМ ССЫЛКУ С МАРКИРОВКОЙ КАК РЕКЛАМА
  if (task.linkUrl) {
    try {
      // Валидация URL
      new URL(task.linkUrl);
      
      // Маркируем как рекламу и добавляем кнопку
      saveParams.mark_as_ads = 1;
      saveParams.link_url = task.linkUrl;
      saveParams.link_text = task.linkText || 'go_to';
      
      // === ОБЯЗАТЕЛЬНЫЙ ПАРАМЕТР ads_items (Данные ОРД) ===
      // VK требует эти данные для рекламных историй. Без этого is_ads будет false.
      saveParams.ads_items = JSON.stringify({
        "type": "physical", // Тип: physical (физлицо), ip (ИП), legal (юрлицо)
        "fio": "Мищенко Никита Андреевич",
        "inn": "503127946895",
        "stories_summ": "0", // Сумма (можно 0)
        "person": ["advertiser"],
        "foreign": "false"
      });
      
      console.log(`[STORY] Adding AD story with link and ads_items: ${saveParams.link_url} (${saveParams.link_text})`);
    } catch (e) {
      console.error('[STORY] Invalid URL, skipping link:', task.linkUrl);
    }
  }
  
  console.log('[STORY] Calling stories.save with params:', Object.keys(saveParams));

  const saveResult = await vkApiPost('stories.save', saveParams, account.token);

  console.log(`[STORY] stories.save result: ${JSON.stringify(saveResult)}`);

  const storyId = saveResult?.items?.[0]?.id
    || saveResult?.[0]?.id
    || saveResult?.id
    || 'published';

  console.log(`[STORY] ✅ Done, storyId: ${storyId}`);
  return String(storyId);
}

// ==================== CRON SCHEDULER ====================

cron.schedule('* * * * *', async () => {
  const now = Date.now();

  try {
    // ===== ИСТОРИИ =====
    let pendingStories;
    if (useMongoDB) {
      pendingStories = await ScheduledStory.find({ status: 'pending', publishDate: { $lte: now } });
    } else {
      pendingStories = memoryData.scheduledStories.filter(
        s => s.status === 'pending' && s.publishDate <= now
      );
    }

    for (const task of pendingStories) {
      console.log(`[CRON] Processing story ${task.id} for group ${task.groupId}`);

      const account = await getFirstAccount();
      if (!account) {
        console.error(`[CRON] No accounts! Cannot publish story ${task.id}`);
        await markStoryError(task, 'No accounts configured', now);
        continue;
      }

      try {
        const storyId = await publishStory(task, account);

        // Успех
        if (useMongoDB) {
          await ScheduledStory.updateOne({ id: task.id }, {
            status: 'completed',
            result: `Published, storyId: ${storyId}`,
            completedAt: now,
            storyId
          });
          await TaskHistory.create({
            type: 'story', taskId: task.id, groupId: task.groupId,
            storyId, success: true, timestamp: now
          });
        } else {
          task.status = 'completed';
          task.result = `Published, storyId: ${storyId}`;
          task.completedAt = now;
          task.storyId = storyId;
          memoryData.taskHistory.push({
            type: 'story', taskId: task.id, groupId: task.groupId,
            storyId, success: true, timestamp: now
          });
        }

        console.log(`[CRON] ✅ Story ${task.id} published`);

      } catch (e) {
        console.error(`[CRON] ❌ Story ${task.id} FAILED: ${e.message}`);
        await markStoryError(task, e.message, now);
      }

      await delay(2000);
    }

    // ===== ПОСТЫ =====
    let pendingPosts;
    if (useMongoDB) {
      pendingPosts = await ScheduledPost.find({ status: 'pending', publishDate: { $lte: now } });
    } else {
      pendingPosts = memoryData.scheduledPosts.filter(
        p => p.status === 'pending' && p.publishDate <= now
      );
    }

    for (const task of pendingPosts) {
      console.log(`[CRON] Processing post ${task.id}`);

      // 🔒 ФИКС ДУБЛИРОВАНИЯ: помечаем как 'processing' ДО любых async-операций
      // Без этого следующий тик cron (через 1 мин) снова видит статус 'pending'
      // и публикует тот же пост повторно, пока первый тик ещё не завершил wall.post
      if (useMongoDB) {
        const claimed = await ScheduledPost.findOneAndUpdate(
          { id: task.id, status: 'pending' },
          { status: 'processing' },
          { new: false }
        );
        if (!claimed) {
          console.warn(`[CRON] Post ${task.id} already claimed by another process, skipping`);
          continue;
        }
      } else {
        if (task.status !== 'pending') continue; // уже обрабатывается
        task.status = 'processing';
      }

      const account = await getFirstAccount();
      if (!account) {
        if (useMongoDB) await ScheduledPost.updateOne({ id: task.id }, { status: 'error', result: 'No accounts' });
        else { task.status = 'error'; task.result = 'No accounts'; }
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
                  if (best?.url) {
                    const imgResp = await fetch(best.url);
                    const imgBuffer = await imgResp.buffer();
                    const uploadServer = await vkApi('photos.getWallUploadServer', { group_id: task.groupId }, account.token);
                    const form = new FormData();
                    form.append('photo', imgBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
                    const upResp = await fetch(uploadServer.upload_url, { method: 'POST', body: form, headers: form.getHeaders() });
                    const upResult = await upResp.json();
                    if (upResult.photo && upResult.server !== undefined && upResult.hash) {
                      const saved = await vkApi('photos.saveWallPhoto', {
                        group_id: task.groupId,
                        photo: upResult.photo,
                        server: upResult.server,
                        hash: upResult.hash
                      }, account.token);
                      if (saved?.[0]) attachments.push(`photo${saved[0].owner_id}_${saved[0].id}`);
                    }
                    await delay(400);
                  }
                } catch (photoErr) {
                  console.error(`[CRON] Photo error:`, photoErr.message);
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

        // Автокомментарий
        if (task.autoCommentText && publishedPostId) {
          const commentTask = {
            id: `${Date.now()}_comment`,
            ownerId: `-${task.groupId}`,
            postId: publishedPostId,
            commentText: task.autoCommentText,
            commentAt: now + 5000,
            fromGroup: true,
            status: 'pending', createdAt: now, retries: 0
          };
          if (useMongoDB) await ScheduledComment.create(commentTask);
          else memoryData.scheduledComments.push(commentTask);
        }

        // Автоудаление
        if (task.autoDeleteAfter && publishedPostId) {
          const deleteTask = {
            id: `${Date.now()}_delete`,
            ownerId: `-${task.groupId}`,
            postId: publishedPostId,
            deleteAt: now + task.autoDeleteAfter,
            status: 'pending', createdAt: now
          };
          if (useMongoDB) await ScheduledDeletion.create(deleteTask);
          else memoryData.scheduledDeletions.push(deleteTask);
        }

        if (useMongoDB) {
          // ✅ Пост выложен — сразу удаляем из MongoDB, не копим мусор
          // История сохраняется в TaskHistory
          await ScheduledPost.deleteOne({ id: task.id });
          await TaskHistory.create({ type: 'post', taskId: task.id, groupId: task.groupId, postId: publishedPostId, success: true, timestamp: now });
        } else {
          task.status = 'completed'; task.result = 'Posted successfully';
          task.completedAt = now; task.publishedPostId = publishedPostId;
          memoryData.taskHistory.push({ type: 'post', taskId: task.id, groupId: task.groupId, postId: publishedPostId, success: true, timestamp: now });
        }
        console.log(`[CRON] ✅ Post ${task.id} completed`);

      } catch (e) {
        console.error(`[CRON] ❌ Post ${task.id} failed:`, e.message);
        if (useMongoDB) {
          await ScheduledPost.updateOne({ id: task.id }, { status: 'error', result: e.message, failedAt: now });
          await TaskHistory.create({ type: 'post', taskId: task.id, groupId: task.groupId, success: false, error: e.message, timestamp: now });
        } else {
          task.status = 'error'; task.result = e.message; task.failedAt = now;
          memoryData.taskHistory.push({ type: 'post', taskId: task.id, groupId: task.groupId, success: false, error: e.message, timestamp: now });
        }
      }
      await delay(1000);
    }

    // ===== КОММЕНТАРИИ =====
    let pendingComments;
    if (useMongoDB) {
      pendingComments = await ScheduledComment.find({ status: 'pending', commentAt: { $lte: now } });
    } else {
      pendingComments = memoryData.scheduledComments.filter(c => c.status === 'pending' && c.commentAt <= now);
    }

    for (const task of pendingComments) {
      // 🔒 ФИКС ДУБЛИРОВАНИЯ: захватываем задачу атомарно
      if (useMongoDB) {
        const claimed = await ScheduledComment.findOneAndUpdate(
          { id: task.id, status: 'pending' },
          { status: 'processing' },
          { new: false }
        );
        if (!claimed) {
          console.warn(`[CRON] Comment ${task.id} already claimed, skipping`);
          continue;
        }
      } else {
        if (task.status !== 'pending') continue;
        task.status = 'processing';
      }

      const account = await getFirstAccount();
      if (!account) {
        if (useMongoDB) await ScheduledComment.updateOne({ id: task.id }, { status: 'error', result: 'No accounts' });
        else { task.status = 'error'; task.result = 'No accounts'; }
        continue;
      }
      try {
        await vkApi('wall.createComment', {
          owner_id: task.ownerId,
          post_id: task.postId,
          message: task.commentText,
          from_group: task.fromGroup ? Math.abs(parseInt(task.ownerId)) : 0
        }, account.token);
        if (useMongoDB) await ScheduledComment.updateOne({ id: task.id }, { status: 'completed', completedAt: now });
        else { task.status = 'completed'; task.completedAt = now; }
        console.log(`[CRON] ✅ Comment ${task.id} completed`);
      } catch (e) {
        if (task.retries < 3) {
          if (useMongoDB) await ScheduledComment.updateOne({ id: task.id }, { retries: task.retries + 1, commentAt: now + 60000 });
          else { task.retries++; task.commentAt = now + 60000; }
        } else {
          if (useMongoDB) await ScheduledComment.updateOne({ id: task.id }, { status: 'error', result: e.message });
          else { task.status = 'error'; task.result = e.message; }
        }
      }
      await delay(1000);
    }

    // ===== АВТОУДАЛЕНИЕ =====
    let pendingDeletions;
    if (useMongoDB) {
      pendingDeletions = await ScheduledDeletion.find({ status: 'pending', deleteAt: { $lte: now } });
    } else {
      pendingDeletions = memoryData.scheduledDeletions.filter(d => d.status === 'pending' && d.deleteAt <= now);
    }

    for (const task of pendingDeletions) {
      const account = await getFirstAccount();
      if (!account) {
        if (useMongoDB) await ScheduledDeletion.updateOne({ id: task.id }, { status: 'error', result: 'No accounts' });
        else { task.status = 'error'; task.result = 'No accounts'; }
        continue;
      }
      try {
        await vkApi('wall.delete', { owner_id: task.ownerId, post_id: task.postId }, account.token);
        if (useMongoDB) await ScheduledDeletion.updateOne({ id: task.id }, { status: 'completed', completedAt: now });
        else { task.status = 'completed'; task.completedAt = now; }
        console.log(`[CRON] ✅ Deletion ${task.id} completed`);
      } catch (e) {
        if (useMongoDB) await ScheduledDeletion.updateOne({ id: task.id }, { status: 'error', result: e.message });
        else { task.status = 'error'; task.result = e.message; }
      }
      await delay(500);
    }

    // ===== АВТОЛАЙКИ =====
    const settings = useMongoDB
      ? await AutolikeSettings.findOne({ id: 'main' })
      : memoryData.autolikeSettings;

    if (settings?.enabled && settings.groups?.length > 0) {
      const accounts = await getAccounts();
      if (accounts.length > 0) {
        const intervalMs = (settings.intervalMinutes || 10) * 60 * 1000;
        if (!settings.lastCheck || (now - settings.lastCheck) >= intervalMs) {
          console.log(`[AUTOLIKE] Starting check`);
          const processedSet = new Set(settings.processedPosts || []);
          const newProcessed = [];
          let likesAdded = 0;

          for (const groupId of settings.groups) {
            try {
              const result = await vkApi('wall.get', {
                owner_id: `-${groupId}`,
                count: 10,
                filter: settings.onlyFromGroup ? 'owner' : 'all'
              }, accounts[0].token);

              for (const post of (result.items || [])) {
                const postKey = `wall${post.owner_id}_${post.id}`;
                if (processedSet.has(postKey) || post.marked_as_ads || post.is_pinned === 1) continue;
                if (post.date < (now / 1000) - (14 * 24 * 60 * 60)) continue;

                for (const acc of accounts) {
                  try {
                    await vkApi('likes.add', { type: 'post', owner_id: post.owner_id, item_id: post.id }, acc.token);
                    likesAdded++;
                    await delay(Math.random() * 1500 + 1500);
                  } catch (e) {
                    if (!e.message.includes('Already liked')) console.log(`[AUTOLIKE] ${e.message}`);
                  }
                }
                newProcessed.push(postKey);
                await delay(1000);
              }
            } catch (e) {
              console.error(`[AUTOLIKE] Group ${groupId}: ${e.message}`);
            }
          }

          const todayDate = new Date().toISOString().split('T')[0];
          const isNewDay = settings.stats?.todayDate !== todayDate;
          const newSettings = {
            ...settings._doc || settings,
            processedPosts: [...(settings.processedPosts || []), ...newProcessed].slice(-500),
            lastCheck: now,
            stats: {
              total: (settings.stats?.total || 0) + likesAdded,
              today: isNewDay ? likesAdded : (settings.stats?.today || 0) + likesAdded,
              todayDate
            },
            lastUpdate: now
          };

          if (useMongoDB) await AutolikeSettings.updateOne({ id: 'main' }, newSettings);
          else memoryData.autolikeSettings = newSettings;

          if (likesAdded > 0) console.log(`[AUTOLIKE] Added ${likesAdded} likes`);
        }
      }
    }

  } catch (e) {
    console.error('[CRON] Fatal error:', e.message);
  }
});

// ==================== HELPER: пометить историю как ошибку ====================

async function markStoryError(task, errorMsg, now) {
  const safeMsg = String(errorMsg).substring(0, 500);
  if (useMongoDB) {
    await ScheduledStory.updateOne({ id: task.id }, { status: 'error', result: safeMsg, failedAt: now });
    await TaskHistory.create({
      type: 'story', taskId: task.id, groupId: task.groupId,
      success: false, error: safeMsg, timestamp: now
    });
  } else {
    task.status = 'error';
    task.result = safeMsg;
    task.failedAt = now;
    memoryData.taskHistory.push({
      type: 'story', taskId: task.id, groupId: task.groupId,
      success: false, error: safeMsg, timestamp: now
    });
  }
}

// ==================== ОЧИСТКА ====================

cron.schedule('0 * * * *', async () => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  try {
    if (useMongoDB) {
      // Удаляем только успешно завершённые задачи. Упавшие ('error') оставляем — у пользователя
      // должна быть возможность перевыложить их через кнопку в интерфейсе.
      const doneStatuses = { status: 'completed', completedAt: { $lt: oneDayAgo } };
      const r1 = await ScheduledPost.deleteMany(doneStatuses);
      const r2 = await ScheduledComment.deleteMany(doneStatuses);
      const r3 = await ScheduledDeletion.deleteMany(doneStatuses);
      const r4 = await ScheduledStory.deleteMany(doneStatuses);

      // Комментарии и автоудаления — служебные задачи, упавшие 24+ часов назад чистим
      const errOld = { status: 'error', completedAt: { $lt: oneDayAgo } };
      await ScheduledComment.deleteMany(errOld);
      await ScheduledDeletion.deleteMany(errOld);

      // Зависшие 'processing' задачи (не завершились за 10+ минут) — откатываем в 'pending'
      const stuckThreshold = Date.now() - 10 * 60 * 1000;
      await ScheduledPost.updateMany(
        { status: 'processing', createdAt: { $lt: stuckThreshold } },
        { status: 'pending' }
      );

      console.log(`[CRON] Cleanup done. Deleted: posts=${r1.deletedCount}, comments=${r2.deletedCount}, deletions=${r3.deletedCount}, stories=${r4.deletedCount}`);
    } else {
      const keepPost = p => p.status === 'pending' || p.status === 'processing' || p.status === 'error' || (p.completedAt || 0) > oneDayAgo;
      const keepAux = x => x.status === 'pending' || x.status === 'processing' || (x.completedAt || 0) > oneDayAgo;
      memoryData.scheduledPosts = memoryData.scheduledPosts.filter(keepPost);
      memoryData.scheduledStories = memoryData.scheduledStories.filter(keepPost);
      memoryData.scheduledComments = memoryData.scheduledComments.filter(keepAux);
      memoryData.scheduledDeletions = memoryData.scheduledDeletions.filter(keepAux);
      console.log('[CRON] Cleanup done (memory mode)');
    }
  } catch (e) {
    console.error('[CRON] Cleanup error:', e.message);
  }
});

// ==================== СТАРТ ====================

async function start() {
  useMongoDB = await connectDB();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server on port ${PORT}`);
    console.log(`📊 DB: ${useMongoDB ? 'MongoDB ✅' : 'Memory ⚠️'}`);
    console.log(`🔗 Health: http://localhost:${PORT}/health`);
  });
}

start();

process.on('SIGINT', async () => {
  if (useMongoDB) await mongoose.disconnect();
  process.exit(0);
});
