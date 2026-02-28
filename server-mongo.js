/**
 * VK Automation Server - MongoDB Version
 * Сервер для автоматизации VK Reposter Pro
 * Работает 24/7 даже когда браузер выключен
 * Поддержка: посты, комментарии, удаления, автолайки, истории
 * Хранение данных: MongoDB Atlas (бесплатно 512MB)
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const FormData = require('form-data');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// VK API версия
const VK_VERSION = '5.199';

// ==================== MONGODB CONNECTION ====================

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set! Data will NOT be persisted.');
  console.error('Set MONGODB_URI environment variable in Render dashboard.');
}

// MongoDB Schemas
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
  sourcePost: {
    ownerId: Number,
    postId: Number
  },
  autoDeleteAfter: Number,
  autoCommentText: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  result: String,
  publishedPostId: Number
});

const scheduledStorySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  groupId: { type: Number, required: true },
  groupName: String,
  fileData: String,
  fileType: { type: String, default: 'photo' },
  publishDate: { type: Number, required: true },
  caption: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  result: String,
  storyId: String
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

// Models
let Account, ScheduledPost, ScheduledStory, ScheduledComment, ScheduledDeletion, AutolikeSettings, TaskHistory;

// In-memory fallback for when MongoDB is not available
let memoryData = {
  accounts: [],
  scheduledPosts: [],
  scheduledStories: [],
  scheduledComments: [],
  scheduledDeletions: [],
  autolikeSettings: null,
  taskHistory: []
};

// Connect to MongoDB
async function connectDB() {
  if (!MONGODB_URI) {
    console.log('⚠️ Running in memory-only mode (no persistence)');
    return false;
  }
  
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ MongoDB connected');
    
    // Initialize models
    Account = mongoose.model('Account', accountSchema);
    ScheduledPost = mongoose.model('ScheduledPost', scheduledPostSchema);
    ScheduledStory = mongoose.model('ScheduledStory', scheduledStorySchema);
    ScheduledComment = mongoose.model('ScheduledComment', scheduledCommentSchema);
    ScheduledDeletion = mongoose.model('ScheduledDeletion', scheduledDeletionSchema);
    AutolikeSettings = mongoose.model('AutolikeSettings', autolikeSettingsSchema);
    TaskHistory = mongoose.model('TaskHistory', taskHistorySchema);
    
    return true;
  } catch (e) {
    console.error('❌ MongoDB connection failed:', e.message);
    console.log('⚠️ Running in memory-only mode');
    return false;
  }
}

let useMongoDB = false;

// ==================== VK API ====================

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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== API ROUTES ====================

// Статус сервера
app.get('/', async (req, res) => {
  try {
    let accountsCount, postsCount, commentsCount, deletionsCount, storiesCount;
    
    if (useMongoDB) {
      accountsCount = await Account.countDocuments();
      postsCount = await ScheduledPost.countDocuments({ status: 'pending' });
      commentsCount = await ScheduledComment.countDocuments({ status: 'pending' });
      deletionsCount = await ScheduledDeletion.countDocuments({ status: 'pending' });
      storiesCount = await ScheduledStory.countDocuments({ status: 'pending' });
    } else {
      accountsCount = memoryData.accounts.length;
      postsCount = memoryData.scheduledPosts.filter(p => p.status === 'pending').length;
      commentsCount = memoryData.scheduledComments.filter(c => c.status === 'pending').length;
      deletionsCount = memoryData.scheduledDeletions.filter(d => d.status === 'pending').length;
      storiesCount = memoryData.scheduledStories.filter(s => s.status === 'pending').length;
    }
    
    res.json({
      status: 'online',
      version: '3.0.0-mongo',
      uptime: Math.floor(process.uptime()),
      database: useMongoDB ? 'MongoDB' : 'Memory (no persistence)',
      accounts: accountsCount,
      scheduledPosts: postsCount,
      scheduledComments: commentsCount,
      scheduledDeletions: deletionsCount,
      scheduledStories: storiesCount
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Проверка здоровья
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
      userId,
      token,
      name: name || `User ${userId}`,
      photo: photo || 'https://vk.com/images/camera_50.png',
      addedAt: Date.now()
    };
    
    if (useMongoDB) {
      await Account.findOneAndUpdate(
        { userId },
        account,
        { upsert: true, new: true }
      );
    } else {
      const existingIndex = memoryData.accounts.findIndex(a => a.userId === userId);
      if (existingIndex >= 0) {
        memoryData.accounts[existingIndex] = account;
      } else {
        memoryData.accounts.push(account);
      }
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
      accounts = await Account.find({}, { token: 0 });
      accounts = accounts.map(a => ({
        userId: a.userId,
        name: a.name,
        photo: a.photo,
        addedAt: a.addedAt
      }));
    } else {
      accounts = memoryData.accounts.map(a => ({
        userId: a.userId,
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
    const { userId } = req.params;
    
    if (useMongoDB) {
      await Account.deleteOne({ userId: parseInt(userId) });
    } else {
      memoryData.accounts = memoryData.accounts.filter(a => a.userId !== parseInt(userId));
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== ОТЛОЖЕННЫЕ ПОСТЫ ====================

app.post('/api/scheduled-posts', async (req, res) => {
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
      createdAt: Date.now()
    };
    
    if (useMongoDB) {
      await ScheduledPost.create(task);
    } else {
      memoryData.scheduledPosts.push(task);
    }
    
    console.log(`[POST] Scheduled post for group ${groupId} at ${new Date(publishDate).toISOString()}`);
    
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/scheduled-posts', async (req, res) => {
  try {
    let posts;
    
    if (useMongoDB) {
      posts = await ScheduledPost.find({ status: 'pending' });
    } else {
      posts = memoryData.scheduledPosts.filter(p => p.status === 'pending');
    }
    
    res.json({ ok: true, posts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/scheduled-posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (useMongoDB) {
      await ScheduledPost.deleteOne({ id });
    } else {
      memoryData.scheduledPosts = memoryData.scheduledPosts.filter(p => p.id !== id);
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== ОТЛОЖЕННЫЕ ИСТОРИИ ====================

app.post('/api/scheduled-stories', async (req, res) => {
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
      fileType: fileType || 'photo',
      publishDate,
      caption: caption || '',
      status: 'pending',
      createdAt: Date.now()
    };
    
    if (useMongoDB) {
      await ScheduledStory.create(task);
    } else {
      memoryData.scheduledStories.push(task);
    }
    
    console.log(`[STORY] Scheduled story for group ${groupId} at ${new Date(publishDate).toISOString()}`);
    
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/scheduled-stories', async (req, res) => {
  try {
    let stories;
    
    if (useMongoDB) {
      stories = await ScheduledStory.find({ status: 'pending' });
    } else {
      stories = memoryData.scheduledStories.filter(s => s.status === 'pending');
    }
    
    res.json({ ok: true, stories });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/scheduled-stories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (useMongoDB) {
      await ScheduledStory.deleteOne({ id });
    } else {
      memoryData.scheduledStories = memoryData.scheduledStories.filter(s => s.id !== id);
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== ОТЛОЖЕННЫЕ КОММЕНТАРИИ ====================

app.post('/api/scheduled-comments', async (req, res) => {
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
    
    if (useMongoDB) {
      await ScheduledComment.create(task);
    } else {
      memoryData.scheduledComments.push(task);
    }
    
    console.log(`[COMMENT] Scheduled comment for post ${ownerId}_${postId}`);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/scheduled-comments', async (req, res) => {
  try {
    let comments;
    
    if (useMongoDB) {
      comments = await ScheduledComment.find({ status: 'pending' });
    } else {
      comments = memoryData.scheduledComments.filter(c => c.status === 'pending');
    }
    
    res.json({ ok: true, comments });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/scheduled-comments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (useMongoDB) {
      await ScheduledComment.deleteOne({ id });
    } else {
      memoryData.scheduledComments = memoryData.scheduledComments.filter(c => c.id !== id);
    }
    
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
      ownerId,
      postId,
      deleteAt,
      status: 'pending',
      createdAt: Date.now()
    };
    
    if (useMongoDB) {
      await ScheduledDeletion.create(task);
    } else {
      memoryData.scheduledDeletions.push(task);
    }
    
    console.log(`[DELETE] Scheduled deletion for post ${ownerId}_${postId}`);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== АВТОЛАЙКИ ====================

app.post('/api/autolike-settings', async (req, res) => {
  try {
    const settings = {
      ...req.body,
      id: 'main',
      lastUpdate: Date.now()
    };
    
    if (useMongoDB) {
      await AutolikeSettings.findOneAndUpdate(
        { id: 'main' },
        settings,
        { upsert: true, new: true }
      );
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
    let settings;
    
    if (useMongoDB) {
      settings = await AutolikeSettings.findOne({ id: 'main' });
    } else {
      settings = memoryData.autolikeSettings;
    }
    
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== ИСТОРИЯ ====================

app.get('/api/history', async (req, res) => {
  try {
    let history;
    
    if (useMongoDB) {
      history = await TaskHistory.find().sort({ timestamp: -1 }).limit(100);
    } else {
      history = memoryData.taskHistory.slice(-100).reverse();
    }
    
    res.json({ ok: true, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== SCHEDULER (CRON) ====================

// Helper to get accounts
async function getAccounts() {
  if (useMongoDB) {
    return await Account.find();
  }
  return memoryData.accounts;
}

// Helper to get first account
async function getFirstAccount() {
  const accounts = await getAccounts();
  return accounts[0];
}

// Каждую минуту проверяем задачи
cron.schedule('* * * * *', async () => {
  const now = Date.now();
  
  try {
    // ===== Отложенные истории =====
    let pendingStories;
    if (useMongoDB) {
      pendingStories = await ScheduledStory.find({ status: 'pending', publishDate: { $lte: now } });
    } else {
      pendingStories = memoryData.scheduledStories.filter(s => s.status === 'pending' && s.publishDate <= now);
    }
    
    for (const task of pendingStories) {
      console.log(`[CRON] Processing scheduled story ${task.id}`);
      
      const account = await getFirstAccount();
      if (!account) {
        if (useMongoDB) {
          await ScheduledStory.updateOne({ id: task.id }, { status: 'error', result: 'No accounts' });
        } else {
          task.status = 'error';
          task.result = 'No accounts';
        }
        continue;
      }
      
      try {
        // Get upload server with add_to_news parameter
        // IMPORTANT: add_to_news must be passed to getUploadServer, not to stories.save!
        let uploadServer;
        if (task.fileType === 'video') {
          uploadServer = await vkApi('stories.getVideoUploadServer', { 
            group_id: task.groupId,
            add_to_news: 1
          }, account.token);
        } else {
          uploadServer = await vkApi('stories.getPhotoUploadServer', { 
            group_id: task.groupId,
            add_to_news: 1
          }, account.token);
        }
        
        if (!uploadServer?.upload_url) {
          throw new Error('Failed to get upload URL');
        }
        
        const fileData = task.fileData.split(',')[1] || task.fileData;
        const fileBuffer = Buffer.from(fileData, 'base64');
        
        const form = new FormData();
        form.append('file', fileBuffer, {
          filename: task.fileType === 'video' ? 'video.mp4' : 'photo.jpg',
          contentType: task.fileType === 'video' ? 'video/mp4' : 'image/jpeg'
        });
        
        // Upload file - VK automatically saves the story after upload!
        // No need to call stories.save separately
        const uploadResp = await fetch(uploadServer.upload_url, {
          method: 'POST',
          body: form,
          headers: form.getHeaders()
        });
        const uploadResult = await uploadResp.json();
        
        console.log(`[CRON] Story upload result:`, JSON.stringify(uploadResult));
        
        // Check if upload was successful
        if (uploadResult.error) {
          throw new Error(uploadResult.error.error_msg || 'Upload failed');
        }
        
        // The response contains the story info directly
        const storyId = uploadResult.response?.items?.[0]?.id || uploadResult.id || 'unknown';
        
        if (useMongoDB) {
          await ScheduledStory.updateOne({ id: task.id }, {
            status: 'completed',
            result: 'Story published',
            completedAt: now,
            storyId: storyId
          });
          await TaskHistory.create({
            type: 'story', taskId: task.id, groupId: task.groupId,
            storyId: storyId, success: true, timestamp: now
          });
        } else {
          task.status = 'completed';
          task.result = 'Story published';
          task.completedAt = now;
          memoryData.taskHistory.push({
            type: 'story', taskId: task.id, groupId: task.groupId,
            storyId: storyId, success: true, timestamp: now
          });
        }
        
        console.log(`[CRON] Story ${task.id} published successfully`);
      } catch (e) {
        if (useMongoDB) {
          await ScheduledStory.updateOne({ id: task.id }, { status: 'error', result: e.message });
          await TaskHistory.create({
            type: 'story', taskId: task.id, groupId: task.groupId,
            success: false, error: e.message, timestamp: now
          });
        } else {
          task.status = 'error';
          task.result = e.message;
          memoryData.taskHistory.push({
            type: 'story', taskId: task.id, groupId: task.groupId,
            success: false, error: e.message, timestamp: now
          });
        }
        console.error(`[CRON] Story ${task.id} error:`, e.message);
      }
      
      await delay(1000);
    }
    
    // ===== Отложенные посты =====
    let pendingPosts;
    if (useMongoDB) {
      pendingPosts = await ScheduledPost.find({ status: 'pending', publishDate: { $lte: now } });
    } else {
      pendingPosts = memoryData.scheduledPosts.filter(p => p.status === 'pending' && p.publishDate <= now);
    }
    
    for (const task of pendingPosts) {
      console.log(`[CRON] Processing scheduled post ${task.id}`);
      
      const account = await getFirstAccount();
      if (!account) {
        if (useMongoDB) {
          await ScheduledPost.updateOne({ id: task.id }, { status: 'error', result: 'No accounts' });
        } else {
          task.status = 'error';
          task.result = 'No accounts';
        }
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
                    
                    const uploadServer = await vkApi('photos.getWallUploadServer', { group_id: task.groupId }, account.token);
                    
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
        
        // Auto-comment
        if (task.autoCommentText && publishedPostId) {
          const commentTask = {
            id: Date.now().toString() + '_comment',
            ownerId: `-${task.groupId}`,
            postId: publishedPostId,
            commentText: task.autoCommentText,
            commentAt: now + 5000,
            fromGroup: true,
            status: 'pending',
            createdAt: now,
            retries: 0
          };
          
          if (useMongoDB) {
            await ScheduledComment.create(commentTask);
          } else {
            memoryData.scheduledComments.push(commentTask);
          }
        }
        
        // Auto-delete
        if (task.autoDeleteAfter && publishedPostId) {
          const deleteTask = {
            id: Date.now().toString() + '_delete',
            ownerId: `-${task.groupId}`,
            postId: publishedPostId,
            deleteAt: now + task.autoDeleteAfter,
            status: 'pending',
            createdAt: now
          };
          
          if (useMongoDB) {
            await ScheduledDeletion.create(deleteTask);
          } else {
            memoryData.scheduledDeletions.push(deleteTask);
          }
        }
        
        if (useMongoDB) {
          await ScheduledPost.updateOne({ id: task.id }, {
            status: 'completed',
            result: 'Posted successfully',
            completedAt: now,
            publishedPostId
          });
          await TaskHistory.create({
            type: 'post', taskId: task.id, groupId: task.groupId,
            postId: publishedPostId, success: true, timestamp: now
          });
        } else {
          task.status = 'completed';
          task.result = 'Posted successfully';
          task.completedAt = now;
          task.publishedPostId = publishedPostId;
          memoryData.taskHistory.push({
            type: 'post', taskId: task.id, groupId: task.groupId,
            postId: publishedPostId, success: true, timestamp: now
          });
        }
        
        console.log(`[CRON] Post ${task.id} completed`);
      } catch (e) {
        if (useMongoDB) {
          await ScheduledPost.updateOne({ id: task.id }, { status: 'error', result: e.message });
          await TaskHistory.create({
            type: 'post', taskId: task.id, groupId: task.groupId,
            success: false, error: e.message, timestamp: now
          });
        } else {
          task.status = 'error';
          task.result = e.message;
          memoryData.taskHistory.push({
            type: 'post', taskId: task.id, groupId: task.groupId,
            success: false, error: e.message, timestamp: now
          });
        }
      }
      
      await delay(1000);
    }
    
    // ===== Отложенные комментарии =====
    let pendingComments;
    if (useMongoDB) {
      pendingComments = await ScheduledComment.find({ status: 'pending', commentAt: { $lte: now } });
    } else {
      pendingComments = memoryData.scheduledComments.filter(c => c.status === 'pending' && c.commentAt <= now);
    }
    
    for (const task of pendingComments) {
      const account = await getFirstAccount();
      if (!account) {
        if (useMongoDB) {
          await ScheduledComment.updateOne({ id: task.id }, { status: 'error', result: 'No accounts' });
        } else {
          task.status = 'error';
          task.result = 'No accounts';
        }
        continue;
      }
      
      try {
        await vkApi('wall.createComment', {
          owner_id: task.ownerId,
          post_id: task.postId,
          message: task.commentText,
          from_group: task.fromGroup ? Math.abs(parseInt(task.ownerId)) : 0
        }, account.token);
        
        if (useMongoDB) {
          await ScheduledComment.updateOne({ id: task.id }, { status: 'completed', completedAt: now });
        } else {
          task.status = 'completed';
          task.completedAt = now;
        }
        
        console.log(`[CRON] Comment ${task.id} completed`);
      } catch (e) {
        if (task.retries < 3) {
          if (useMongoDB) {
            await ScheduledComment.updateOne({ id: task.id }, {
              retries: task.retries + 1,
              commentAt: now + 60000
            });
          } else {
            task.retries++;
            task.commentAt = now + 60000;
          }
        } else {
          if (useMongoDB) {
            await ScheduledComment.updateOne({ id: task.id }, { status: 'error', result: e.message });
          } else {
            task.status = 'error';
            task.result = e.message;
          }
        }
      }
      
      await delay(1000);
    }
    
    // ===== Автоудаление =====
    let pendingDeletions;
    if (useMongoDB) {
      pendingDeletions = await ScheduledDeletion.find({ status: 'pending', deleteAt: { $lte: now } });
    } else {
      pendingDeletions = memoryData.scheduledDeletions.filter(d => d.status === 'pending' && d.deleteAt <= now);
    }
    
    for (const task of pendingDeletions) {
      const account = await getFirstAccount();
      if (!account) {
        if (useMongoDB) {
          await ScheduledDeletion.updateOne({ id: task.id }, { status: 'error', result: 'No accounts' });
        } else {
          task.status = 'error';
          task.result = 'No accounts';
        }
        continue;
      }
      
      try {
        await vkApi('wall.delete', {
          owner_id: task.ownerId,
          post_id: task.postId
        }, account.token);
        
        if (useMongoDB) {
          await ScheduledDeletion.updateOne({ id: task.id }, { status: 'completed', completedAt: now });
        } else {
          task.status = 'completed';
          task.completedAt = now;
        }
        
        console.log(`[CRON] Deletion ${task.id} completed`);
      } catch (e) {
        if (useMongoDB) {
          await ScheduledDeletion.updateOne({ id: task.id }, { status: 'error', result: e.message });
        } else {
          task.status = 'error';
          task.result = e.message;
        }
      }
      
      await delay(500);
    }
    
    // ===== Автолайки =====
    let settings;
    if (useMongoDB) {
      settings = await AutolikeSettings.findOne({ id: 'main' });
    } else {
      settings = memoryData.autolikeSettings;
    }
    
    if (settings?.enabled && settings.groups?.length > 0) {
      const accounts = await getAccounts();
      if (accounts.length > 0) {
        const intervalMs = (settings.intervalMinutes || 10) * 60 * 1000;
        
        if (!settings.lastCheck || (now - settings.lastCheck) >= intervalMs) {
          console.log(`[AUTOLIKE] Starting autolike check`);
          
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
          
          const todayDate = new Date().toISOString().split('T')[0];
          const isNewDay = settings.stats?.todayDate !== todayDate;
          
          const newSettings = {
            ...settings,
            processedPosts: [...(settings.processedPosts || []), ...newProcessed].slice(-500),
            lastCheck: now,
            stats: {
              total: (settings.stats?.total || 0) + likesAdded,
              today: isNewDay ? likesAdded : (settings.stats?.today || 0) + likesAdded,
              todayDate
            },
            lastUpdate: now
          };
          
          if (useMongoDB) {
            await AutolikeSettings.updateOne({ id: 'main' }, newSettings);
          } else {
            memoryData.autolikeSettings = newSettings;
          }
          
          if (likesAdded > 0) {
            console.log(`[AUTOLIKE] Added ${likesAdded} likes`);
          }
        }
      }
    }
    
  } catch (e) {
    console.error('[CRON] Scheduler error:', e.message);
  }
});

// Очистка старых задач (каждый час)
cron.schedule('0 * * * *', async () => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  
  try {
    if (useMongoDB) {
      await ScheduledPost.deleteMany({ status: { $ne: 'pending' }, completedAt: { $lt: oneDayAgo } });
      await ScheduledComment.deleteMany({ status: { $ne: 'pending' }, completedAt: { $lt: oneDayAgo } });
      await ScheduledDeletion.deleteMany({ status: { $ne: 'pending' }, completedAt: { $lt: oneDayAgo } });
      await ScheduledStory.deleteMany({ status: { $ne: 'pending' }, completedAt: { $lt: oneDayAgo } });
    } else {
      memoryData.scheduledPosts = memoryData.scheduledPosts.filter(p => p.status === 'pending' || p.completedAt > oneDayAgo);
      memoryData.scheduledComments = memoryData.scheduledComments.filter(c => c.status === 'pending' || c.completedAt > oneDayAgo);
      memoryData.scheduledDeletions = memoryData.scheduledDeletions.filter(d => d.status === 'pending' || d.completedAt > oneDayAgo);
      memoryData.scheduledStories = memoryData.scheduledStories.filter(s => s.status === 'pending' || s.completedAt > oneDayAgo);
    }
    
    console.log('[CRON] Cleaned up old tasks');
  } catch (e) {
    console.error('[CRON] Cleanup error:', e.message);
  }
});

// ==================== START SERVER ====================

async function start() {
  useMongoDB = await connectDB();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 VK Automation Server running on port ${PORT}`);
    console.log(`📊 Database: ${useMongoDB ? 'MongoDB ✅' : 'Memory (no persistence) ⚠️'}`);
    console.log(`🔗 Health: http://localhost:${PORT}/health`);
  });
}

start();

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (useMongoDB) {
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
  }
  process.exit(0);
});
