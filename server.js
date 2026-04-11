const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const db        = require('./database');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

// ─── Oda şifresi ─────────────────────────────────────────────────────────────
function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
const ROOM_PASSWORD = process.env.PASSWORD || 'akif31';

// ─── Güvenlik başlıkları ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", 'https://w.soundcloud.com'],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      connectSrc:  ["'self'", 'wss:', 'ws:', 'https://soundcloud.com', 'https://api.soundcloud.com'],
      mediaSrc:    ["'self'", 'blob:', 'https://*.sndcdn.com'],
      imgSrc:      ["'self'", 'data:', 'https://*.sndcdn.com', 'https://i1.sndcdn.com'],
      frameSrc:    ['https://w.soundcloud.com'],
      workerSrc:   ["'self'", 'blob:'],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 100,                  // IP başına 100 istek
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla istek. Lütfen bekleyin.' },
});
app.use('/api/', limiter);

// Socket.io için bağlantı rate limiting
const socketConnections = new Map(); // ip → timestamp[]
function isRateLimited(ip) {
  const now = Date.now();
  const times = (socketConnections.get(ip) || []).filter(t => now - t < 60_000);
  times.push(now);
  socketConnections.set(ip, times);
  return times.length > 10; // dakikada 10'dan fazla bağlantı
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/channels', (_req, res) => res.json(db.getChannels()));

// ─── SoundCloud client_id (başlangıçta çek, 12 saatte bir yenile) ─────────────
const SC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let scClientId = null;

async function fetchScClientId() {
  try {
    const r    = await fetch('https://soundcloud.com', { headers: { 'User-Agent': SC_UA } });
    const html = await r.text();
    const m    = html.match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
    if (!m) return;
    const h   = JSON.parse(m[1]);
    const api = h.find(x => x.hydratable === 'apiClient');
    if (api?.data?.id) {
      scClientId = api.data.id;
      console.log(`[SC] client_id güncellendi: ${scClientId}`);
    }
  } catch (e) {
    console.error('[SC] client_id alınamadı:', e.message);
  }
}
fetchScClientId();
setInterval(fetchScClientId, 12 * 60 * 60 * 1000);

// ─── SoundCloud arama ────────────────────────────────────────────────────────
app.get('/api/music/search', limiter, async (req, res) => {
  const q = (req.query.q || '').trim().slice(0, 200);
  if (!q) return res.json({ results: [] });
  if (!scClientId) return res.json({ results: [], error: 'SC henüz hazır değil' });
  try {
    const r    = await fetch(
      `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=5&client_id=${scClientId}`,
      { headers: { 'User-Agent': SC_UA } }
    );
    const data = await r.json();
    const results = (data.collection || []).slice(0, 5).map(t => ({
      trackUrl:  t.permalink_url,
      title:     t.title,
      thumbnail: (t.artwork_url || t.user?.avatar_url || '').replace('-large', '-t300x300'),
      artist:    t.user?.username || '',
    }));
    res.json({ results });
  } catch (e) {
    console.error('SC search hatası:', e.message);
    res.json({ results: [] });
  }
});

// ─── Müzik durumu ────────────────────────────────────────────────────────────
// channelId → { current, queue, isPlaying, startedAt, elapsed }
const musicState = new Map();

function createMusicState() {
  return { current: null, queue: [], isPlaying: false, startedAt: 0, elapsed: 0 };
}

function advanceMusicQueue(voiceRoom) {
  const state = musicState.get(voiceRoom) || createMusicState();
  if (state.queue.length === 0) {
    state.current   = null;
    state.isPlaying = false;
    state.elapsed   = 0;
  } else {
    state.current   = state.queue.shift();
    state.isPlaying = true;
    state.startedAt = Date.now();
    state.elapsed   = 0;
  }
  musicState.set(voiceRoom, state);
  io.to(`voice:${voiceRoom}`).emit('music_state', getMusicPayload(voiceRoom));
}

function getMusicPayload(voiceRoom) {
  const state = musicState.get(voiceRoom) || createMusicState();
  const elapsed = state.isPlaying
    ? (Date.now() - state.startedAt) / 1000
    : state.elapsed;
  return {
    current:    state.current,
    queue:      state.queue,
    isPlaying:  state.isPlaying,
    elapsed,
    serverTime: Date.now(),
  };
}

// ─── Metin kanalı durumu ─────────────────────────────────────────────────────
// socketId → { username, channelId }
const connectedUsers = new Map();

function getRoomName(channelId) { return `channel:${channelId}`; }

function getUsersInChannel(channelId) {
  const seen = new Set();
  for (const [, u] of connectedUsers) {
    if (u.channelId === channelId) seen.add(u.username);
  }
  return [...seen];
}

function broadcastUserList(channelId) {
  io.to(getRoomName(channelId)).emit('user_list', {
    users: getUsersInChannel(channelId),
  });
}

// Tüm bağlı kullanıcıları listele (DM için)
function getAllOnlineUsers() {
  const seen = new Set();
  for (const [, u] of connectedUsers) seen.add(u.username);
  return [...seen];
}

function isUsernameTaken(username) {
  for (const [, u] of connectedUsers) {
    if (u.username.toLowerCase() === username.toLowerCase()) return true;
  }
  return false;
}

function getSocketIdByUsername(username) {
  for (const [id, u] of connectedUsers) {
    if (u.username === username) return id;
  }
  return null;
}

// ─── Sesli kanal durumu ──────────────────────────────────────────────────────
// roomName → Map<socketId, { username }>
const VOICE_ROOMS = ['sesli-genel', 'sesli-oyun'];
const voiceRooms  = new Map();
for (const r of VOICE_ROOMS) voiceRooms.set(r, new Map());

function broadcastVoiceRooms() {
  const state = {};
  for (const [name, members] of voiceRooms) {
    state[name] = [...members.values()].map(u => u.username);
  }
  io.emit('voice_rooms_state', state);
}

function leaveAllVoiceRooms(socket) {
  for (const [roomName, members] of voiceRooms) {
    if (members.has(socket.id)) {
      members.delete(socket.id);
      socket.to(`voice:${roomName}`).emit('voice_peer_left', { socketId: socket.id });
      socket.leave(`voice:${roomName}`);
    }
  }
  broadcastVoiceRooms();
}

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  if (isRateLimited(ip)) {
    socket.emit('auth_error', { message: 'Çok fazla bağlantı denemesi. Lütfen bekleyin.' });
    socket.disconnect(true);
    return;
  }

  // ── Giriş ──────────────────────────────────────────────────────────────────
  socket.on('join', ({ username, password, channelId }) => {
    username = username?.trim();
    if (!username || username.length < 2 || username.length > 20) {
      return socket.emit('auth_error', { message: 'Kullanıcı adı 2-20 karakter arasında olmalı.' });
    }
    if (password !== ROOM_PASSWORD) {
      return socket.emit('auth_error', { message: 'Yanlış şifre.' });
    }
    if (isUsernameTaken(username)) {
      return socket.emit('auth_error', { message: `"${username}" kullanıcı adı zaten alınmış.` });
    }
    if (!db.getChannelById(channelId)) {
      return socket.emit('auth_error', { message: 'Kanal bulunamadı.' });
    }

    db.ensureUser(username);
    connectedUsers.set(socket.id, { username, channelId });
    socket.join(getRoomName(channelId));

    socket.emit('message_history', {
      messages: db.getMessages(channelId),
      channelId,
    });
    socket.emit('voice_rooms_state', Object.fromEntries(
      [...voiceRooms].map(([n, m]) => [n, [...m.values()].map(u => u.username)])
    ));

    broadcastUserList(channelId);
    io.emit('global_user_list', { users: getAllOnlineUsers() });

    socket.to(getRoomName(channelId)).emit('system_message', {
      text: `${username} katıldı.`, channelId,
    });
  });

  // ── Kanal değiştir ─────────────────────────────────────────────────────────
  socket.on('switch_channel', ({ channelId }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    if (!db.getChannelById(channelId)) return;

    const old = user.channelId;
    socket.leave(getRoomName(old));
    socket.to(getRoomName(old)).emit('system_message', {
      text: `${user.username} kanaldan ayrıldı.`, channelId: old,
    });
    broadcastUserList(old);

    user.channelId = channelId;
    connectedUsers.set(socket.id, user);
    socket.join(getRoomName(channelId));

    socket.emit('message_history', {
      messages: db.getMessages(channelId),
      channelId,
    });
    broadcastUserList(channelId);
    socket.to(getRoomName(channelId)).emit('system_message', {
      text: `${user.username} katıldı.`, channelId,
    });
  });

  // ── Mesaj gönder ───────────────────────────────────────────────────────────
  socket.on('send_message', ({ channelId, content }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    content = content?.trim();
    if (!content || content.length > 2000) return;
    if (user.channelId !== channelId) return;

    const msg = db.insertMessage(channelId, user.username, content);
    io.to(getRoomName(channelId)).emit('new_message', { message: msg });
  });

  // ── Tepki ──────────────────────────────────────────────────────────────────
  socket.on('toggle_reaction', ({ messageId, emoji, channelId }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const ALLOWED = ['👍','❤️','😂','😮','😢','🔥','🎉','👎'];
    if (!ALLOWED.includes(emoji)) return;

    const msg = db.toggleReaction(messageId, user.username, emoji);
    if (msg) {
      io.to(getRoomName(channelId)).emit('reaction_updated', {
        messageId, reactions: msg.reactions,
      });
    }
  });

  // ── DM gönder ──────────────────────────────────────────────────────────────
  socket.on('send_dm', ({ to, content }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    content = content?.trim();
    if (!content || content.length > 2000 || to === user.username) return;

    const msg = db.insertDm(user.username, to, content);

    socket.emit('new_dm', { message: msg });

    const toSocketId = getSocketIdByUsername(to);
    if (toSocketId) {
      io.to(toSocketId).emit('new_dm', { message: msg });
      io.to(toSocketId).emit('dm_notification', { from: user.username });
    }
  });

  socket.on('get_dm_history', ({ with: peer }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    socket.emit('dm_history', {
      messages: db.getDms(user.username, peer),
      peer,
    });
  });

  // ── Yazıyor ────────────────────────────────────────────────────────────────
  socket.on('typing_start', ({ channelId }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || user.channelId !== channelId) return;
    socket.to(getRoomName(channelId)).emit('user_typing', {
      username: user.username, channelId,
    });
  });

  socket.on('typing_stop', ({ channelId }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    socket.to(getRoomName(channelId)).emit('user_stop_typing', {
      username: user.username, channelId,
    });
  });

  socket.on('dm_typing_start', ({ to }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const toId = getSocketIdByUsername(to);
    if (toId) io.to(toId).emit('dm_user_typing', { from: user.username });
  });

  socket.on('dm_typing_stop', ({ to }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const toId = getSocketIdByUsername(to);
    if (toId) io.to(toId).emit('dm_user_stop_typing', { from: user.username });
  });

  // ── Sesli kanal ────────────────────────────────────────────────────────────
  socket.on('voice_join', ({ room }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !voiceRooms.has(room)) return;

    // Önceki sesli kanaldan çık
    leaveAllVoiceRooms(socket);

    const members = voiceRooms.get(room);
    const existingPeers = [...members.entries()].map(([id, u]) => ({
      socketId: id,
      username: u.username,
    }));

    members.set(socket.id, { username: user.username });
    socket.join(`voice:${room}`);

    // Yeni kullanıcıya mevcut katılımcıları bildir
    socket.emit('voice_peers', { peers: existingPeers });

    // Mevcut katılımcılara yeni kullanıcıyı bildir
    socket.to(`voice:${room}`).emit('voice_peer_joined', {
      socketId: socket.id,
      username: user.username,
    });

    broadcastVoiceRooms();
  });

  socket.on('voice_leave', () => leaveAllVoiceRooms(socket));

  // WebRTC sinyalleme — sadece yönlendir
  socket.on('voice_offer',     ({ to, offer })     =>
    io.to(to).emit('voice_offer',     { from: socket.id, offer }));
  socket.on('voice_answer',    ({ to, answer })    =>
    io.to(to).emit('voice_answer',    { from: socket.id, answer }));
  socket.on('voice_ice',       ({ to, candidate }) =>
    io.to(to).emit('voice_ice',       { from: socket.id, candidate }));

  // ── Ekran paylaşımı ────────────────────────────────────────────────────────
  // socketId → { username, channelId }
  // screenSharers: hangi socket ekran paylaşıyor
  socket.on('screen_share_start', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    // Aynı kanalda başka biri paylaşıyorsa engelle
    for (const [sid,] of connectedUsers) {
      if (io.sockets.sockets.get(sid)?._screenSharing && sid !== socket.id) return;
    }
    const sock = io.sockets.sockets.get(socket.id);
    if (sock) sock._screenSharing = true;

    // Kanaldaki herkese bildir, onlar viewer isteği gönderecek
    socket.to(getRoomName(user.channelId)).emit('screen_share_available', {
      sharerId: socket.id,
      username: user.username,
    });
  });

  // Viewer, paylaşımcıya bağlanmak için request gönderir
  socket.on('screen_view_request', ({ sharerId }) => {
    io.to(sharerId).emit('screen_viewer_joined', { viewerId: socket.id });
  });

  // Screen share WebRTC sinyalleme
  socket.on('screen_offer',  ({ to, offer })     => io.to(to).emit('screen_offer',  { from: socket.id, offer }));
  socket.on('screen_answer', ({ to, answer })    => io.to(to).emit('screen_answer', { from: socket.id, answer }));
  socket.on('screen_ice',    ({ to, candidate }) => io.to(to).emit('screen_ice',    { from: socket.id, candidate }));

  socket.on('screen_share_stop', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const sock = io.sockets.sockets.get(socket.id);
    if (sock) sock._screenSharing = false;
    io.to(getRoomName(user.channelId)).emit('screen_share_ended', { sharerId: socket.id });
  });

  // ── Müzik botu (sesli kanal bazlı) ─────────────────────────────────────────
  socket.on('music_add', async ({ trackUrl, title, thumbnail, addedBy, voiceRoom }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const members = voiceRooms.get(voiceRoom);
    if (!members?.has(socket.id)) return; // sadece o sesli kanaldakiler ekleyebilir

    const state = musicState.get(voiceRoom) || createMusicState();
    state.queue.push({ trackUrl, title, thumbnail, addedBy });

    if (!state.current) {
      advanceMusicQueue(voiceRoom);
    } else {
      io.to(`voice:${voiceRoom}`).emit('music_state', getMusicPayload(voiceRoom));
    }
    musicState.set(voiceRoom, state);
  });

  socket.on('music_play', ({ voiceRoom }) => {
    const state = musicState.get(voiceRoom);
    if (!state || !state.current) return;
    state.isPlaying = true;
    state.startedAt = Date.now() - state.elapsed * 1000;
    io.to(`voice:${voiceRoom}`).emit('music_play', { serverTime: Date.now() });
  });

  socket.on('music_pause', ({ voiceRoom }) => {
    const state = musicState.get(voiceRoom);
    if (!state || !state.current) return;
    state.isPlaying = false;
    state.elapsed = (Date.now() - state.startedAt) / 1000;
    io.to(`voice:${voiceRoom}`).emit('music_pause', { elapsed: state.elapsed });
  });

  socket.on('music_error_skip', ({ voiceRoom, reason }) => {
    advanceMusicQueue(voiceRoom);
    const members = voiceRooms.get(voiceRoom);
    if (members) {
      for (const sid of members.keys()) {
        const u = connectedUsers.get(sid);
        if (u) io.to(getRoomName(u.channelId)).emit('system_message', {
          text: `🎵 ${reason} — başka bir şarkı deneniyor.`, channelId: u.channelId,
        });
      }
    }
  });

  socket.on('music_skip', ({ voiceRoom }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    advanceMusicQueue(voiceRoom);
    io.to(`voice:${voiceRoom}`).emit('music_system', { text: `${user.username} şarkıyı geçti.` });
  });

  socket.on('music_sync_request', ({ voiceRoom }) => {
    socket.emit('music_state', getMusicPayload(voiceRoom));
  });

  // Sessize al bildirimi
  socket.on('voice_mute_state', ({ muted }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    for (const [roomName, members] of voiceRooms) {
      if (members.has(socket.id)) {
        socket.to(`voice:${roomName}`).emit('voice_peer_muted', {
          socketId: socket.id, muted,
        });
        break;
      }
    }
  });

  // ── Bağlantı kesildi ───────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      const { username, channelId } = user;
      connectedUsers.delete(socket.id);
      leaveAllVoiceRooms(socket);
      // Ekran paylaşımı varsa durdur
      const sock = io.sockets.sockets.get(socket.id);
      if (sock?._screenSharing) {
        io.to(getRoomName(channelId)).emit('screen_share_ended', { sharerId: socket.id });
      }

      socket.to(getRoomName(channelId)).emit('user_stop_typing', { username, channelId });
      socket.to(getRoomName(channelId)).emit('system_message', {
        text: `${username} çevrimdışı oldu.`, channelId,
      });
      broadcastUserList(channelId);
      io.emit('global_user_list', { users: getAllOnlineUsers() });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n✓ Sunucu çalışıyor → http://localhost:${PORT}`);
  console.log(`🔑 Oda şifresi: ${ROOM_PASSWORD}`);
  console.log(`   (Kendi şifren için: PASSWORD=şifren npm start)\n`);
});
