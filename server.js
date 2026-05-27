const express   = require('express');
const http      = require('http');
const path      = require('path');
const { Server } = require('socket.io');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const db        = require('./database');
const {
  createAuditLogger,
  createLoginThrottle,
  verifyAuthToken,
} = require('./server/auth');
const {
  createHttpAuthMiddleware,
  createSocketAuthMiddleware,
  resolveAuthSession,
} = require('./server/auth-middleware');
const { createAuthRouter } = require('./server/auth-routes');
const config    = require('./server/config');
const { createLogger } = require('./server/logger');
const { createRealtimeState } = require('./server/realtime-state');
const { createSoundCloudService } = require('./server/soundcloud');
const { bootstrapAdminRole } = require('./server/admin-bootstrap');

const log = createLogger('server');
const socketLog = log.child('socket');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: config.socketPingInterval,
  pingTimeout: config.socketPingTimeout,
});

// Railway requests arrive through a reverse proxy, and express-rate-limit
// expects forwarded IPs to be trusted to key clients correctly.
app.set('trust proxy', 1);

if (!config.authSecret) {
  log.error('missing_auth_secret');
  process.exit(1);
}
if (Buffer.byteLength(config.authSecret, 'utf8') < 32) {
  log.error('weak_auth_secret');
  process.exit(1);
}
if (!config.registrationInviteCode) {
  log.warn('registration_invite_disabled');
}

const audit = createAuditLogger({ db });

const { requireAuth } = createHttpAuthMiddleware({
  verifyAuthToken,
  secret: config.authSecret,
  db,
  audit,
  legacyTokenGraceUntil: config.legacyAuthTokenGraceUntil,
});
io.use(createSocketAuthMiddleware({
  verifyAuthToken,
  secret: config.authSecret,
  db,
  audit,
  legacyTokenGraceUntil: config.legacyAuthTokenGraceUntil,
}));

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
app.use(express.json({ limit: '16kb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: config.apiRateWindowMs,
  max: config.apiRateMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla istek. Lütfen bekleyin.' },
});
app.use('/api/', limiter);

// Socket.io için bağlantı rate limiting
const socketConnections = new Map(); // ip → timestamp[]
function isRateLimited(ip) {
  const now = Date.now();
  const times = (socketConnections.get(ip) || []).filter(
    (timestamp) => now - timestamp < config.socketRateWindowMs,
  );
  times.push(now);
  socketConnections.set(ip, times);
  return times.length > config.socketRateMax;
}

app.use(express.static(config.staticDir));
app.get('/reset-password', (_req, res) => {
  res.sendFile(path.join(config.staticDir, 'index.html'));
});
app.get('/confirm-email', (_req, res) => {
  res.sendFile(path.join(config.staticDir, 'index.html'));
});
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(config.staticDir, 'index.html'));
});
const loginThrottle = createLoginThrottle({ db, audit });
bootstrapAdminRole({ db, config, audit, logger: log });

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/channels', requireAuth, (_req, res) => res.json(db.getChannels()));
app.get('/api/client-config', (_req, res) => res.json({
  iceServers: config.rtcIceServers,
  registrationEnabled: true,
}));

const soundCloud = createSoundCloudService({
  fetchImpl: fetch,
  logger: log.child('soundcloud'),
  refreshMs: config.soundcloudRefreshMs,
  userAgent: config.soundcloudUserAgent,
});

db.pruneRevokedTokens();
const pruneRevokedTokensTimer = setInterval(() => db.pruneRevokedTokens(), 6 * 60 * 60 * 1000);
pruneRevokedTokensTimer.unref?.();
const pruneLoginAttemptsTimer = setInterval(() => loginThrottle.prune(), 5 * 60 * 1000);
pruneLoginAttemptsTimer.unref?.();

log.info('rtc_config_loaded', {
  iceServerCount: config.rtcIceServers.length,
  custom: config.hasCustomRtcIceServers,
});

// ─── SoundCloud arama ────────────────────────────────────────────────────────
app.get('/api/music/search', requireAuth, limiter, async (req, res) => {
  const payload = await soundCloud.searchTracks(req.query.q);
  res.json(payload);
});

const realtime = createRealtimeState({
  io,
  defaultVoiceRooms: config.defaultVoiceRooms,
});
const {
  connectedUsers,
  voiceRooms,
  screenShares,
  musicState,
  createMusicState,
  getRoomName,
  broadcastUserList,
  getAllOnlineUsers,
  isUsernameTaken,
  getSocketIdByUsername,
  broadcastVoiceChannelList,
  broadcastVoiceRooms,
  leaveAllVoiceRooms,
  getActiveScreenShare,
  emitActiveScreenShareToSocket,
  endScreenShare,
  disconnectSocket,
  forceDisconnectUser,
  getMusicPayload,
  advanceMusicQueue,
} = realtime;

function disconnectSocketsMatching(predicate, reason = 'auth_revoked', message = 'Oturumun sonlandırıldı. Tekrar giriş yap.') {
  let disconnected = 0;
  for (const socket of io.of('/').sockets.values()) {
    if (!predicate(socket)) continue;
    disconnectSocket(socket, reason, message);
    disconnected += 1;
  }
  return disconnected;
}

const authRouter = createAuthRouter({
  db,
  config,
  requireAuth,
  audit,
  forceDisconnectUser,
  disconnectSocketsMatching,
  ensureAdminBootstrap: () => bootstrapAdminRole({ db, config, audit, logger: log }),
  loginThrottle,
  logger: socketLog,
});
app.use('/api', authRouter);

function pruneDeletedAccounts(now = Date.now()) {
  const deleted = db.deleteExpiredPendingAccounts(now);
  if (deleted.length) {
    log.info('expired_accounts_deleted', {
      count: deleted.length,
      usernames: deleted,
    });
  }
}

pruneDeletedAccounts();
const pruneDeletedAccountsTimer = setInterval(() => pruneDeletedAccounts(), 24 * 60 * 60 * 1000);
pruneDeletedAccountsTimer.unref?.();

// ─── POKER ───────────────────────────────────────────────────────────────────
const SMALL_BLIND      = 10;
const BIG_BLIND        = 20;
const START_CHIPS      = 1000;
const MAX_POKER_SEATS  = 6;
let poker              = null;

function createDeck() {
  const d = [];
  for (const s of ['S','H','D','C']) for (let v=2;v<=14;v++) d.push({v,s});
  return d;
}
function shuffle(d) {
  for (let i=d.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

function evalFive(cards) {
  const v=cards.map(c=>c.v).sort((a,b)=>b-a);
  const flush=new Set(cards.map(c=>c.s)).size===1;
  const freq={};
  for (const x of v) freq[x]=(freq[x]||0)+1;
  const g=Object.entries(freq).sort((a,b)=>b[1]-a[1]||b[0]-a[0]).map(([x,c])=>({v:+x,c}));
  const strHi=(()=>{
    if (new Set(v).size<5) return 0;
    if (v[0]-v[4]===4) return v[0];
    if (v[0]===14&&v[1]===5&&v[2]===4&&v[3]===3&&v[4]===2) return 5;
    return 0;
  })();
  if (flush&&strHi) return [8,strHi];
  if (g[0].c===4) return [7,g[0].v,g[1].v];
  if (g[0].c===3&&g[1]?.c===2) return [6,g[0].v,g[1].v];
  if (flush) return [5,...v];
  if (strHi) return [4,strHi];
  if (g[0].c===3) return [3,g[0].v,g[1].v,g[2].v];
  if (g[0].c===2&&g[1]?.c===2) return [2,g[0].v,g[1].v,g[2].v];
  if (g[0].c===2) return [1,g[0].v,g[1].v,g[2].v,g[3].v];
  return [0,...v];
}
function bestHand(hole,comm) {
  const all=[...hole,...comm];
  let best=null;
  for (let i=0;i<all.length;i++) for (let j=i+1;j<all.length;j++) {
    const five=all.filter((_,k)=>k!==i&&k!==j);
    const h=evalFive(five);
    if (!best||cmpH(h,best)>0) best=h;
  }
  return best;
}
function cmpH(a,b) {
  for (let i=0;i<Math.max(a.length,b.length);i++) {
    if ((a[i]||0)!==(b[i]||0)) return (a[i]||0)-(b[i]||0);
  }
  return 0;
}
const HAND_NAMES=['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush'];

function pokerActive(p)      { return p.seats.filter(s=>!s.folded); }
function pokerActiveNonAllIn(p) { return p.seats.filter(s=>!s.folded&&!s.allIn); }

function broadcastPoker() {
  if (!poker) { io.emit('poker_state', null); return; }
  const pub = {
    seats: poker.seats.map(s=>({
      socketId:s.socketId, username:s.username,
      chips:s.chips, bet:s.bet, folded:s.folded, allIn:s.allIn, hand:null,
      handName: (poker.phase==='showdown' && !s.folded && s._handRank!=null)
        ? HAND_NAMES[s._handRank[0]] : null,
      isWinner: poker.winner ? poker.winner.includes(s.socketId) : false,
    })),
    community: poker.community,
    pot:        poker.pot,
    phase:      poker.phase,
    turn:       poker.turn,
    currentBet: poker.currentBet,
    minRaise:   poker.minRaise,
    dealer:     poker.dealer,
    toAct:      [...poker.toAct],
    winner:     poker.winner   || null,
    winnerHand: poker.winnerHand || null,
  };
  for (const seat of poker.seats) {
    const state = { ...pub, seats: pub.seats.map((s,i)=>({
      ...s,
      hand: (s.socketId===seat.socketId||poker.phase==='showdown')
        ? poker.seats[i].hand : poker.seats[i].hand.map(()=>null),
    }))};
    io.to(seat.socketId).emit('poker_state', state);
  }
}

function pokerNextTurn() {
  if (!poker || poker.toAct.size===0) { pokerEndRound(); return; }
  const seats=poker.seats;
  const cur=seats.findIndex(s=>s.socketId===poker.turn);
  for (let i=1;i<=seats.length;i++) {
    const next=seats[(cur+i)%seats.length];
    if (poker.toAct.has(next.socketId)) { poker.turn=next.socketId; broadcastPoker(); return; }
  }
  pokerEndRound();
}

function pokerEndRound() {
  if (!poker) return;
  for (const s of poker.seats) s.bet=0;
  poker.currentBet=0; poker.minRaise=BIG_BLIND;

  const active=pokerActive(poker);
  if (active.length===1) {
    active[0].chips+=poker.pot;
    poker.phase='showdown'; poker.winner=[active[0].socketId]; poker.winnerHand='Herkes fold yaptı!';
    broadcastPoker(); setTimeout(pokerNextHand,4000); return;
  }

  if      (poker.phase==='preflop') { poker.phase='flop';  poker.community=[poker.deck.pop(),poker.deck.pop(),poker.deck.pop()]; pokerStartRound(); }
  else if (poker.phase==='flop')    { poker.phase='turn';  poker.community.push(poker.deck.pop()); pokerStartRound(); }
  else if (poker.phase==='turn')    { poker.phase='river'; poker.community.push(poker.deck.pop()); pokerStartRound(); }
  else if (poker.phase==='river')   { pokerShowdown(); }
}

function pokerStartRound() {
  const seats=poker.seats;
  let idx=(poker.dealer+1)%seats.length;
  for (let i=0;i<seats.length;i++) { if (!seats[idx].folded&&!seats[idx].allIn) break; idx=(idx+1)%seats.length; }
  poker.turn=seats[idx].socketId;
  poker.toAct=new Set(pokerActiveNonAllIn(poker).map(s=>s.socketId));
  broadcastPoker();
  if (poker.toAct.size===0) setTimeout(pokerEndRound, 1200);
}

function pokerShowdown() {
  poker.phase='showdown';
  const active=pokerActive(poker);
  let bestH=null, winners=[];
  for (const s of active) {
    const h=poker.community.length>=3 ? bestHand(s.hand,poker.community) : evalFive(s.hand.slice(0,5));
    s._handRank=h;
    if (!bestH||cmpH(h,bestH)>0) { bestH=h; winners=[s]; }
    else if (cmpH(h,bestH)===0) winners.push(s);
  }
  const share=Math.floor(poker.pot/winners.length);
  for (const w of winners) w.chips+=share;
  poker.winner=winners.map(w=>w.socketId);
  poker.winnerHand=HAND_NAMES[bestH?.[0]??0] || 'High Card';
  broadcastPoker();
  setTimeout(pokerNextHand,5000);
}

function pokerNextHand() {
  if (!poker) return;
  poker.seats=poker.seats.filter(s=>s.chips>0);
  if (poker.seats.length<2) {
    poker.phase='waiting';
    for (const s of poker.seats) { s.hand=[]; s.bet=0; s.folded=false; s.allIn=false; }
    broadcastPoker(); return;
  }
  poker.dealer=(poker.dealer+1)%poker.seats.length;
  pokerDeal();
}

function pokerDeal() {
  const p=poker;
  p.deck=shuffle(createDeck()); p.community=[]; p.pot=0;
  p.phase='preflop'; p.winner=null; p.winnerHand=null;
  p.currentBet=BIG_BLIND; p.minRaise=BIG_BLIND;
  for (const s of p.seats) { s.hand=[p.deck.pop(),p.deck.pop()]; s.bet=0; s.folded=false; s.allIn=false; }
  const n=p.seats.length;
  const sbIdx=(p.dealer+1)%n, bbIdx=(p.dealer+2)%n;
  const sb=p.seats[sbIdx], bb=p.seats[bbIdx];
  const sbAmt=Math.min(SMALL_BLIND,sb.chips), bbAmt=Math.min(BIG_BLIND,bb.chips);
  sb.chips-=sbAmt; sb.bet=sbAmt; p.pot+=sbAmt;
  bb.chips-=bbAmt; bb.bet=bbAmt; p.pot+=bbAmt;
  if (sb.chips===0) sb.allIn=true;
  if (bb.chips===0) bb.allIn=true;
  p.turn=p.seats[(bbIdx+1)%n].socketId;
  p.toAct=new Set(pokerActiveNonAllIn(p).map(s=>s.socketId));
  broadcastPoker();
  if (p.toAct.size===0) setTimeout(pokerEndRound, 1200);
}

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  const connectedAt = Date.now();
  if (isRateLimited(ip)) {
    socketLog.warn('connection_rate_limited', { socketId: socket.id, ip });
    socket.emit('auth_error', { message: 'Çok fazla bağlantı denemesi. Lütfen bekleyin.' });
    socket.disconnect(true);
    return;
  }
  socketLog.info('connected', {
    socketId: socket.id,
    ip,
    transport: socket.conn?.transport?.name || null,
  });
  socket.conn?.on('upgrade', () => {
    socketLog.info('transport_upgraded', {
      socketId: socket.id,
      username: socket.data?.auth?.username || null,
      transport: socket.conn?.transport?.name || null,
    });
  });
  socket.conn?.on('close', (reason) => {
    socketLog.warn('transport_closed', {
      socketId: socket.id,
      username: socket.data?.auth?.username || null,
      reason: reason || null,
      transport: socket.conn?.transport?.name || null,
      connectedForMs: Date.now() - connectedAt,
    });
  });
  const authRecheckTimer = setInterval(() => {
    const token = socket.data?.auth?.token;
    if (!token) return;
    const resolved = resolveAuthSession({
      token,
      verifyAuthToken,
      secret: config.authSecret,
      db,
    });
    if (resolved.ok) return;
    socketLog.warn('socket_session_invalidated', {
      socketId: socket.id,
      username: socket.data?.auth?.username || null,
      code: resolved.code,
    });
    socket.emit('auth_error', { code: resolved.code, message: resolved.message });
    socket.disconnect(true);
  }, 5 * 60 * 1000);
  authRecheckTimer.unref?.();

  socket.on('session_refresh', ({ token }) => {
    const resolved = resolveAuthSession({
      token,
      verifyAuthToken,
      secret: config.authSecret,
      db,
    });
    if (!resolved.ok) {
      socketLog.warn('socket_session_refresh_rejected', {
        socketId: socket.id,
        username: socket.data?.auth?.username || null,
        code: resolved.code,
      });
      socket.emit('auth_error', { code: resolved.code, message: resolved.message });
      socket.disconnect(true);
      return;
    }

    const previousUsername = socket.data?.auth?.username || null;
    if (previousUsername && previousUsername !== resolved.session.username) {
      socketLog.warn('socket_session_refresh_username_mismatch', {
        socketId: socket.id,
        previousUsername,
        nextUsername: resolved.session.username,
      });
      socket.emit('auth_error', {
        code: 'invalid_session',
        message: 'Oturumun geçersiz. Tekrar giriş yap.',
      });
      socket.disconnect(true);
      return;
    }

    socket.data.auth = {
      ...resolved.session,
      token,
    };
    socketLog.info('socket_session_refreshed', {
      socketId: socket.id,
      username: resolved.session.username,
    });
  });

  socket.on('client_debug_events', ({ events }) => {
    if (!Array.isArray(events) || !events.length) return;
    for (const event of events.slice(0, 20)) {
      if (!event || typeof event !== 'object') continue;
      socketLog.warn('client_realtime_event', {
        socketId: socket.id,
        username: socket.data?.auth?.username || null,
        ip,
        event: event.event || 'unknown',
        clientTime: event.time || null,
        reason: event.reason || null,
        code: event.code || null,
        message: event.message || null,
        description: event.description || null,
        clientTransport: event.transport || null,
        clientConnected: typeof event.connected === 'boolean' ? event.connected : null,
        channelId: event.channelId || null,
        voiceRoom: event.voiceRoom || null,
        attempt: Number.isFinite(event.attempt) ? event.attempt : null,
        status: Number.isFinite(event.status) ? event.status : null,
      });
    }
  });

  // ── Giriş ──────────────────────────────────────────────────────────────────
  socket.on('join', ({ channelId, sessionId }) => {
    sessionId = typeof sessionId === 'string' ? sessionId.trim().slice(0, 128) : '';
    const username = socket.data.auth?.username;
    let sameSessionReconnect = false;
    if (!username) {
      socketLog.warn('join_missing_socket_auth', { socketId: socket.id, ip });
      return socket.emit('auth_error', {
        code: 'invalid_session',
        message: 'Oturumun geçersiz. Tekrar giriş yap.',
      });
    }

    if (isUsernameTaken(username)) {
      const oldId = getSocketIdByUsername(username);
      const oldSocket = oldId ? io.sockets.sockets.get(oldId) : null;
      const oldUser = oldId ? connectedUsers.get(oldId) : null;
      sameSessionReconnect = Boolean(sessionId && oldUser?.sessionId && oldUser.sessionId === sessionId);

      if (oldSocket && !sameSessionReconnect) {
        socketLog.warn('join_username_taken', { socketId: socket.id, username, ip });
        return socket.emit('auth_error', {
          code: 'username_taken',
          message: `"${username}" hesabı başka bir cihazda açık.`,
        });
      }
      if (oldSocket && sameSessionReconnect) {
        socketLog.info('join_replacing_stale_socket', { socketId: socket.id, username, oldSocketId: oldId });
        endScreenShare(oldId, oldUser?.channelId);
        leaveAllVoiceRooms(oldSocket);
        connectedUsers.delete(oldId);
        oldSocket.disconnect(true);
      } else if (oldId) {
        connectedUsers.delete(oldId);
      }
    }
    if (!db.getChannelById(channelId)) {
      return socket.emit('auth_error', { code: 'channel_missing', message: 'Kanal bulunamadı.' });
    }

    connectedUsers.set(socket.id, { username, channelId, sessionId });
    socket.join(getRoomName(channelId));
    socketLog.info('joined_channel', { socketId: socket.id, username, channelId });

    socket.emit('message_history', {
      messages: db.getMessages(channelId),
      channelId,
    });
    socket.emit('voice_channels_list', [...voiceRooms.keys()]);
    socket.emit('voice_rooms_state', Object.fromEntries(
      [...voiceRooms].map(([n, m]) => [n, [...m.values()].map(u => u.username)])
    ));
    emitActiveScreenShareToSocket(socket, channelId);

    broadcastUserList(channelId);
    io.emit('global_user_list', { users: getAllOnlineUsers() });

    if (!sameSessionReconnect) {
      socket.to(getRoomName(channelId)).emit('system_message', {
        text: `${username} katıldı.`, channelId,
      });
    }
  });

  // ── Kanal değiştir ─────────────────────────────────────────────────────────
  socket.on('switch_channel', ({ channelId }) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    if (!db.getChannelById(channelId)) return;

    const old = user.channelId;
    socketLog.info('switched_channel', { socketId: socket.id, username: user.username, fromChannelId: old, toChannelId: channelId });
    endScreenShare(socket.id, old);
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
    emitActiveScreenShareToSocket(socket, channelId);
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
      socketId: socket.id, username: user.username,
    });

    socketLog.info('voice_joined', { socketId: socket.id, username: user.username, room });
    broadcastVoiceRooms();
  });

  socket.on('voice_leave', () => leaveAllVoiceRooms(socket));

  socket.on('create_voice_channel', ({ name }) => {
    if (!connectedUsers.get(socket.id)) return;
    name = name?.trim().toLowerCase().replace(/[^a-z0-9ğüşıöç-]/g, '-').slice(0, 24);
    if (!name || voiceRooms.has(name) || voiceRooms.size >= 10) return;
    voiceRooms.set(name, new Map());
    broadcastVoiceChannelList();
    broadcastVoiceRooms();
  });

  socket.on('delete_voice_channel', ({ name }) => {
    if (!connectedUsers.get(socket.id)) return;
    if (!voiceRooms.has(name)) return;
    if (['sesli-genel', 'sesli-oyun'].includes(name)) return; // varsayılanlar silinemez
    if ((voiceRooms.get(name)?.size ?? 0) > 0) return; // dolu kanal silinemez
    voiceRooms.delete(name);
    broadcastVoiceChannelList();
    broadcastVoiceRooms();
  });

  // WebRTC sinyalleme — sadece yönlendir
  socket.on('voice_offer', ({ to, offer }) => {
    const user = connectedUsers.get(socket.id);
    io.to(to).emit('voice_offer', {
      from: socket.id,
      offer,
      fromUsername: user?.username,
    });
  });
  socket.on('voice_answer', ({ to, answer }) => {
    const user = connectedUsers.get(socket.id);
    io.to(to).emit('voice_answer', {
      from: socket.id,
      answer,
      fromUsername: user?.username,
    });
  });
  socket.on('voice_ice',       ({ to, candidate }) =>
    io.to(to).emit('voice_ice',       { from: socket.id, candidate }));

  // ── Ekran paylaşımı ────────────────────────────────────────────────────────
  // socketId → { username, channelId }
  // screenSharers: hangi socket ekran paylaşıyor
  socket.on('screen_share_start', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const activeShare = getActiveScreenShare(user.channelId);
    if (activeShare && activeShare.sharerId !== socket.id) return;
    screenShares.set(user.channelId, {
      sharerId: socket.id,
      username: user.username,
    });

    // Kanaldaki herkese bildir, onlar viewer isteği gönderecek
    socket.to(getRoomName(user.channelId)).emit('screen_share_available', {
      sharerId: socket.id,
      username: user.username,
    });
    socketLog.info('screen_share_started', { socketId: socket.id, username: user.username, channelId: user.channelId });
  });

  // Viewer, paylaşımcıya bağlanmak için request gönderir
  socket.on('screen_view_request', ({ sharerId }) => {
    const viewer = connectedUsers.get(socket.id);
    if (!viewer) return;
    const activeShare = getActiveScreenShare(viewer.channelId);
    if (!activeShare || activeShare.sharerId !== sharerId) return;
    io.to(sharerId).emit('screen_viewer_joined', { viewerId: socket.id });
  });

  // Screen share WebRTC sinyalleme
  socket.on('screen_offer',  ({ to, offer })     => io.to(to).emit('screen_offer',  { from: socket.id, offer }));
  socket.on('screen_answer', ({ to, answer })    => io.to(to).emit('screen_answer', { from: socket.id, answer }));
  socket.on('screen_ice',    ({ to, candidate }) => io.to(to).emit('screen_ice',    { from: socket.id, candidate }));

  socket.on('screen_share_stop', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    endScreenShare(socket.id, user.channelId);
    socketLog.info('screen_share_stopped', { socketId: socket.id, username: user.username, channelId: user.channelId });
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

  // ── Poker ──────────────────────────────────────────────────────────────────
  socket.on('poker_join', () => {
    const user=connectedUsers.get(socket.id);
    if (!user) return;
    if (!poker) poker={seats:[],deck:[],community:[],pot:0,phase:'waiting',turn:null,dealer:0,currentBet:0,minRaise:BIG_BLIND,toAct:new Set(),winner:null,winnerHand:null};
    if (poker.seats.find(s=>s.socketId===socket.id)) return;
    if (poker.seats.length>=MAX_POKER_SEATS) return socket.emit('poker_error','Masa dolu (max 6 oyuncu)');
    if (poker.phase!=='waiting') return socket.emit('poker_error','El devam ediyor, bir sonraki ele bekleyin');
    poker.seats.push({socketId:socket.id,username:user.username,chips:START_CHIPS,hand:[],bet:0,folded:false,allIn:false});
    socket.join('poker');
    broadcastPoker();
  });

  socket.on('poker_leave', () => {
    if (!poker) return;
    poker.seats=poker.seats.filter(s=>s.socketId!==socket.id);
    socket.leave('poker');
    if (poker.seats.length===0) { poker=null; io.emit('poker_state',null); return; }
    broadcastPoker();
  });

  socket.on('poker_start', () => {
    if (!poker||poker.phase!=='waiting') return;
    if (poker.seats.length<2) return socket.emit('poker_error','En az 2 oyuncu gerekli');
    pokerDeal();
  });

  socket.on('poker_request_state', () => {
    if (!poker) { socket.emit('poker_state', null); return; }
    // Send private state to this socket
    const mySeat = poker.seats.find(s=>s.socketId===socket.id);
    const state = {
      seats: poker.seats.map((s,i)=>({
        socketId:s.socketId, username:s.username, chips:s.chips,
        bet:s.bet, folded:s.folded, allIn:s.allIn,
        hand: (s.socketId===socket.id||poker.phase==='showdown') ? s.hand : s.hand.map(()=>null),
        handName: (poker.phase==='showdown' && !s.folded && s._handRank!=null)
          ? HAND_NAMES[s._handRank[0]] : null,
        isWinner: poker.winner ? poker.winner.includes(s.socketId) : false,
      })),
      community: poker.community, pot: poker.pot, phase: poker.phase,
      turn: poker.turn, currentBet: poker.currentBet, minRaise: poker.minRaise,
      dealer: poker.dealer, toAct: [...poker.toAct],
      winner: poker.winner||null, winnerHand: poker.winnerHand||null,
    };
    socket.emit('poker_state', state);
  });

  socket.on('poker_action', ({ action, amount }) => {
    if (!poker||poker.phase==='waiting'||poker.phase==='showdown') return;
    if (poker.turn!==socket.id) return;
    if (!poker.toAct.has(socket.id)) return;
    const seat=poker.seats.find(s=>s.socketId===socket.id);
    if (!seat) return;
    poker.toAct.delete(socket.id);

    if (action==='fold') {
      seat.folded=true;
      const active=pokerActive(poker);
      if (active.length===1) {
        active[0].chips+=poker.pot;
        poker.phase='showdown'; poker.winner=[active[0].socketId]; poker.winnerHand='Herkes fold yaptı!';
        broadcastPoker(); setTimeout(pokerNextHand,4000); return;
      }
      if (poker.toAct.size===0) pokerEndRound(); else pokerNextTurn();
    } else if (action==='check') {
      if (seat.bet!==poker.currentBet) { poker.toAct.add(socket.id); return socket.emit('poker_error','Check yapamazsın'); }
      if (poker.toAct.size===0) pokerEndRound(); else pokerNextTurn();
    } else if (action==='call') {
      const callAmt=Math.min(poker.currentBet-seat.bet,seat.chips);
      seat.chips-=callAmt; seat.bet+=callAmt; poker.pot+=callAmt;
      if (seat.chips===0) seat.allIn=true;
      if (poker.toAct.size===0) pokerEndRound(); else pokerNextTurn();
    } else if (action==='raise') {
      const total=Math.max(amount||0,poker.currentBet+poker.minRaise);
      const raiseAmt=Math.min(total-seat.bet,seat.chips);
      seat.chips-=raiseAmt; seat.bet+=raiseAmt; poker.pot+=raiseAmt;
      if (seat.chips===0) seat.allIn=true;
      poker.minRaise=Math.max(BIG_BLIND,seat.bet-poker.currentBet);
      poker.currentBet=Math.max(poker.currentBet,seat.bet);
      poker.toAct=new Set(pokerActiveNonAllIn(poker).map(s=>s.socketId));
      poker.toAct.delete(socket.id);
      if (poker.toAct.size===0) pokerEndRound(); else { poker.turn=socket.id; pokerNextTurn(); }
    }
  });

  // ── Bağlantı kesildi ───────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    clearInterval(authRecheckTimer);
    const user = connectedUsers.get(socket.id);
    if (user) {
      const { username, channelId } = user;
      socketLog.info('disconnected', {
        socketId: socket.id,
        username,
        channelId,
        reason: reason || null,
        transport: socket.conn?.transport?.name || null,
        connectedForMs: Date.now() - connectedAt,
      });
      endScreenShare(socket.id, channelId);
      connectedUsers.delete(socket.id);
      leaveAllVoiceRooms(socket);

      socket.to(getRoomName(channelId)).emit('user_stop_typing', { username, channelId });
      socket.to(getRoomName(channelId)).emit('system_message', {
        text: `${username} çevrimdışı oldu.`, channelId,
      });
      broadcastUserList(channelId);
      io.emit('global_user_list', { users: getAllOnlineUsers() });

      // Poker: kendi koltuktan çıkar
      if (poker) {
        const seat=poker.seats.find(s=>s.socketId===socket.id);
        if (seat) {
          if (poker.phase!=='waiting'&&poker.turn===socket.id) {
            seat.folded=true; poker.toAct.delete(socket.id);
            const active=pokerActive(poker);
            if (active.length===1) {
              active[0].chips+=poker.pot;
              poker.phase='showdown'; poker.winner=[active[0].socketId]; poker.winnerHand='Oyuncu ayrıldı';
              broadcastPoker(); setTimeout(pokerNextHand,4000);
            } else if (poker.toAct.size===0) pokerEndRound(); else pokerNextTurn();
          } else {
            poker.seats=poker.seats.filter(s=>s.socketId!==socket.id);
            if (poker.seats.length===0) poker=null;
            else broadcastPoker();
          }
        }
      }
    } else {
      socketLog.info('disconnected_unauthed', {
        socketId: socket.id,
        reason: reason || null,
        transport: socket.conn?.transport?.name || null,
        connectedForMs: Date.now() - connectedAt,
      });
    }
  });
});

let startPromise = null;

function startServer({ port = config.defaultPort, host = '0.0.0.0', silent = false } = {}) {
  if (server.listening) return Promise.resolve(server.address());
  if (startPromise) return startPromise;
  soundCloud.start();

  startPromise = new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      soundCloud.stop();
      startPromise = null;
      reject(err);
    };

    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!silent) {
        const actualPort = typeof address === 'object' && address ? address.port : port;
        const printableHost = host === '0.0.0.0' ? 'localhost' : host;
        log.info('started', {
          host: printableHost,
          port: actualPort,
          mode: 'server',
          desktopCommand: 'npm run desktop',
        });
      }
      resolve(address);
    };

    server.once('error', onError);
    server.listen(port, host, onListening);
  });

  return startPromise;
}

function stopServer() {
  if (!server.listening) {
    startPromise = null;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((err) => {
      startPromise = null;
      soundCloud.stop();
      if (err) reject(err);
      else {
        log.info('stopped');
        resolve();
      }
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    log.error('start_failed', { error: err });
    process.exit(1);
  });
}

module.exports = {
  app,
  bootstrapAdminRole,
  io,
  server,
  startServer,
  stopServer,
};
