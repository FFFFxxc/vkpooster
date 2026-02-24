const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const VK_VERSION = '5.199';
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('[DATA] Error:', e.message); }
  return { accounts: [], scheduledPosts: [], scheduledComments: [], scheduledDeletions: [], autolikeSettings: null, taskHistory: [] };
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

let data = loadData();

async function vkApi(method, params, token) {
  const url = new URL(`https://api.vk.com/method/${method}`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('v', VK_VERSION);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString());
  const d = await r.json();
  if (d.error) throw new Error(d.error.error_msg);
  return d.response;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get('/', (req, res) => {
  res.json({ status: 'online', version: '1.0.0', uptime: Math.floor(process.uptime()), accounts: data.accounts.length });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/accounts', (req, res) => {
  const { token, userId, name, photo } = req.body;
  if (!token || !userId) return res.status(400).json({ ok: false, error: 'Token and userId required' });
  const idx = data.accounts.findIndex(a => a.userId === userId);
  const acc = { userId, token, name: name || `User ${userId}`, photo: photo || 'https://vk.com/images/camera_50.png', addedAt: Date.now() };
  if (idx >= 0) data.accounts[idx] = acc; else data.accounts.push(acc);
  saveData();
  res.json({ ok: true, account: { userId, name: acc.name, photo: acc.photo } });
});

app.get('/api/accounts', (req, res) => {
  res.json({ ok: true, accounts: data.accounts.map(a => ({ userId: a.userId, name: a.name, photo: a.photo })) });
});

app.delete('/api/accounts/:userId', (req, res) => {
  data.accounts = data.accounts.filter(a => a.userId !== parseInt(req.params.userId));
  saveData();
  res.json({ ok: true });
});

app.post('/api/scheduled-posts', (req, res) => {
  const { groupId, message, attachments, publishDate, ownerId, postId } = req.body;
  if (!groupId || !publishDate) return res.status(400).json({ ok: false, error: 'groupId and publishDate required' });
  const task = { id: Date.now().toString(), groupId, message: message || '', attachments: attachments || [], publishDate, sourcePost: ownerId && postId ? { ownerId, postId } : null, status: 'pending', createdAt: Date.now() };
  data.scheduledPosts.push(task);
  saveData();
  res.json({ ok: true, task });
});

app.get('/api/scheduled-posts', (req, res) => res.json({ ok: true, posts: data.scheduledPosts.filter(p => p.status === 'pending') }));

app.post('/api/scheduled-comments', (req, res) => {
  const { ownerId, postId, commentText, commentAt, fromGroup } = req.body;
  if (!ownerId || !postId || !commentText || !commentAt) return res.status(400).json({ ok: false, error: 'Missing fields' });
  const task = { id: Date.now().toString(), ownerId, postId, commentText, commentAt, fromGroup: fromGroup || false, status: 'pending', createdAt: Date.now(), retries: 0 };
  data.scheduledComments.push(task);
  saveData();
  res.json({ ok: true, task });
});

app.get('/api/scheduled-comments', (req, res) => res.json({ ok: true, comments: data.scheduledComments.filter(c => c.status === 'pending') }));

app.post('/api/scheduled-deletions', (req, res) => {
  const { ownerId, postId, deleteAt } = req.body;
  if (!ownerId || !postId || !deleteAt) return res.status(400).json({ ok: false, error: 'Missing fields' });
  const task = { id: Date.now().toString(), ownerId, postId, deleteAt, status: 'pending', createdAt: Date.now() };
  data.scheduledDeletions.push(task);
  saveData();
  res.json({ ok: true, task });
});

app.post('/api/autolike-settings', (req, res) => {
  data.autolikeSettings = { ...req.body, lastUpdate: Date.now() };
  saveData();
  res.json({ ok: true });
});

app.get('/api/autolike-settings', (req, res) => res.json({ ok: true, settings: data.autolikeSettings }));

app.get('/api/history', (req, res) => res.json({ ok: true, history: data.taskHistory.slice(-100).reverse() }));

cron.schedule('* * * * *', async () => {
  const now = Date.now();
  
  for (const task of data.scheduledPosts.filter(p => p.status === 'pending' && p.publishDate <= now)) {
    const acc = data.accounts[0];
    if (!acc) { task.status = 'error'; task.result = 'No accounts'; continue; }
    try {
      if (task.sourcePost) {
        const pd = await vkApi('wall.getById', { posts: `${task.sourcePost.ownerId}_${task.sourcePost.postId}` }, acc.token);
        const post = pd.items?.[0];
        if (!post) throw new Error('Post not found');
        let atts = [];
        if (post.attachments) {
          for (const a of post.attachments) {
            if (a.type === 'photo') atts.push(`photo${a.photo.owner_id}_${a.photo.id}`);
            else if (a.type === 'video') atts.push(`video${a.video.owner_id}_${a.video.id}${a.video.access_key ? '_' + a.video.access_key : ''}`);
          }
        }
        await vkApi('wall.post', { owner_id: `-${task.groupId}`, from_group: 1, message: task.message || post.text || '', attachments: atts.join(',') }, acc.token);
      } else {
        await vkApi('wall.post', { owner_id: `-${task.groupId}`, from_group: 1, message: task.message, attachments: task.attachments?.join(',') }, acc.token);
      }
      task.status = 'completed';
      task.result = 'OK';
      data.taskHistory.push({ type: 'post', taskId: task.id, success: true, timestamp: now });
    } catch (e) {
      task.status = 'error';
      task.result = e.message;
      data.taskHistory.push({ type: 'post', taskId: task.id, success: false, error: e.message, timestamp: now });
    }
    await delay(1000);
  }
  
  for (const task of data.scheduledComments.filter(c => c.status === 'pending' && c.commentAt <= now)) {
    const acc = data.accounts[0];
    if (!acc) { task.status = 'error'; continue; }
    try {
      await vkApi('wall.createComment', { owner_id: task.ownerId, post_id: task.postId, message: task.commentText, from_group: task.fromGroup ? Math.abs(parseInt(task.ownerId)) : 0 }, acc.token);
      task.status = 'completed';
      data.taskHistory.push({ type: 'comment', taskId: task.id, success: true, timestamp: now });
    } catch (e) {
      if (task.retries < 3) { task.retries++; task.commentAt = now + 60000; }
      else { task.status = 'error'; task.result = e.message; }
    }
    await delay(1000);
  }
  
  for (const task of data.scheduledDeletions.filter(d => d.status === 'pending' && d.deleteAt <= now)) {
    const acc = data.accounts[0];
    if (!acc) { task.status = 'error'; continue; }
    try {
      await vkApi('wall.delete', { owner_id: task.ownerId, post_id: task.postId }, acc.token);
      task.status = 'completed';
    } catch (e) { task.status = 'error'; task.result = e.message; }
    await delay(500);
  }
  
  if (data.autolikeSettings?.enabled && data.accounts.length > 0) {
    const proc = new Set(data.autolikeSettings.processedPosts || []);
    const newProc = [];
    for (const gid of (data.autolikeSettings.groups || [])) {
      try {
        const res = await vkApi('wall.get', { owner_id: `-${gid}`, count: 10, filter: data.autolikeSettings.onlyFromGroup ? 'owner' : 'all' }, data.accounts[0].token);
        for (const post of (res.items || [])) {
          const key = `wall${post.owner_id}_${post.id}`;
          if (proc.has(key) || post.marked_as_ads || post.is_pinned === 1) continue;
          if (post.date < (now / 1000) - 1209600) continue;
          for (const a of data.accounts) {
            try { await vkApi('likes.add', { type: 'post', owner_id: post.owner_id, item_id: post.id }, a.token); await delay(1500); } catch (e) {}
          }
          newProc.push(key);
          await delay(1000);
        }
      } catch (e) {}
    }
    data.autolikeSettings.processedPosts = [...proc, ...newProc].slice(-500);
  }
  
  saveData();
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 VK Server running on port ${PORT}`));

process.on('SIGINT', () => { saveData(); process.exit(0); });
