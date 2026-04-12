'use strict';

// ═══════════════ DURUM ═══════════════
let socket;
let currentUser     = null;
let currentChannelId = null;
let currentChannels  = [];
let currentView      = 'channel'; // 'channel' | 'dm'
let currentDmPeer    = null;
let typingTimer      = null;
let isTyping         = false;
let dmTypingTimer    = null;
let isDmTyping       = false;
const typingUsers    = new Set();
const dmNotifCounts  = {};        // username → unread count

// Müzik
let audioUnlocked   = false;
let pendingState    = null;   // ses açılana kadar bekleyen state
let musicDuration   = 0;
let progressTimer   = null;

// Ekran paylaşımı
let screenStream         = null;
let isSharing            = false;
const screenPeerConns    = new Map(); // viewerId → RTCPeerConnection (paylaşımcı tarafı)
let screenViewConn       = null;      // viewer tarafı tek bağlantı

// Sesli kanal
let localStream       = null;
let currentVoiceRoom  = null;
let isMuted           = false;
const peerConnections = new Map(); // socketId → RTCPeerConnection
const mutedPeers      = new Set();
const voicePeerIds    = new Map(); // socketId → username
const locallyMuted    = new Set(); // username → kendi tarafından susturulmuş
const peerVolumes     = {};        // username → 0-1
const audioAnalysers  = new Map(); // socketId|'local' → AnalyserNode
let   speakingTimer   = null;
const SPEAKING_THR    = 12;        // 0-255 eşik

const ICE = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]};

// ═══════════════ DOM ═══════════════
const $ = id => document.getElementById(id);

const loginScreen    = $('login-screen');
const loginForm      = $('login-form');
const usernameInput  = $('username-input');
const passwordInput  = $('password-input');
const loginError     = $('login-error');
const appEl          = $('app');
const channelList    = $('channel-list');
const dmUserList     = $('dm-user-list');
const messagesEl     = $('messages-container');
const typingEl       = $('typing-indicator');
const messageForm    = $('message-form');
const messageInput   = $('message-input');
const channelNameEl  = $('channel-name-display');
const channelDescEl  = $('channel-desc-display');
const chIconEl       = $('ch-icon');
const selfAvatar     = $('self-avatar');
const selfUsername   = $('self-username');
const micBtn          = $('mic-btn');
const vcLeaveBtn      = null;
const musicPanel      = $('music-panel');
const musicTitle      = $('music-title');
const musicAddedBy    = $('music-added-by');
const musicThumb      = $('music-thumb');
const musicPlayBtn    = $('music-play-btn');
const musicPlayIcon   = $('music-play-icon');
const musicSkipBtn    = $('music-skip-btn');
const musicVolume     = $('music-volume');
const musicVolumeLabel= $('music-volume-label');
const musicProgressFill = $('music-progress-fill');
const musicElapsed    = $('music-elapsed');
const musicDurationEl = $('music-duration');
const musicQueueWrap    = $('music-queue-wrap');
const musicQueueList    = $('music-queue-list');
const audioUnlockBanner = $('audio-unlock-banner');
const audioUnlockBtn    = $('audio-unlock-btn');
const screenShareBtn      = $('screen-share-btn');
const screenShareLabel    = $('screen-share-label');
const screenPanel         = $('screen-panel');
const screenVideo         = $('screen-video');
const screenPanelTitle    = $('screen-panel-title');
const screenPanelClose    = $('screen-panel-close');
const screenFullscreenBtn = $('screen-fullscreen-btn');
const qualityOverlay      = $('quality-modal-overlay');
const voiceControls  = $('voice-controls');
const vcMuteBtn      = $('vc-mute-btn');
const emojiPicker    = $('emoji-picker');

// ═══════════════ YARDIMCI FONKSİYONLAR ═══════════════
function usernameToHue(u) {
  let h = 0;
  for (const c of u) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return Math.abs(h) % 360;
}
function avatarColor(u) { return `hsl(${usernameToHue(u)},65%,55%)`; }

function formatTime(unix) {
  return new Date(unix * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}
function formatDate(unix) {
  const d  = new Date(unix * 1000);
  const td = new Date();
  const yd = new Date(td); yd.setDate(td.getDate() - 1);
  if (d.toDateString() === td.toDateString()) return 'Bugün';
  if (d.toDateString() === yd.toDateString()) return 'Dün';
  return d.toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric' });
}

function isAtBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}
function scrollToBottom(force = false) {
  if (force || isAtBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ═══════════════ MESAJ RENDER ═══════════════
function buildMessageEl(msg, isDm = false) {
  const wrap = document.createElement('div');
  wrap.className = 'message';
  wrap.dataset.msgId = msg.id;
  if (!isDm) wrap.dataset.channelId = msg.channel_id;

  // Avatar
  const av = document.createElement('div');
  av.className = 'msg-avatar';
  av.style.background = avatarColor(msg.username || msg.from);
  av.textContent = (msg.username || msg.from)[0].toUpperCase();

  // Body
  const body   = document.createElement('div');
  body.className = 'msg-body';

  const header = document.createElement('div');
  header.className = 'msg-header';

  const uname = document.createElement('span');
  uname.className = 'msg-username';
  uname.style.color = avatarColor(msg.username || msg.from);
  uname.textContent = msg.username || msg.from;

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.created_at);

  const content = document.createElement('div');
  content.className = 'msg-content';
  content.textContent = msg.content; // XSS koruması

  header.append(uname, time);
  body.append(header, content);

  // Tepkiler
  if (!isDm) {
    const reactRow = document.createElement('div');
    reactRow.className = 'msg-reactions';
    reactRow.dataset.msgId = msg.id;
    renderReactions(reactRow, msg.reactions || {});
    body.append(reactRow);

    // Tepki ekle butonu
    const reactBtn = document.createElement('button');
    reactBtn.className = 'msg-react-btn';
    reactBtn.innerHTML = '😊 <span style="font-size:.75rem">+</span>';
    reactBtn.addEventListener('click', (e) => showEmojiPicker(e, msg.id, msg.channel_id));
    wrap.append(reactBtn);
  }

  wrap.append(av, body);
  return wrap;
}

function renderReactions(container, reactions) {
  container.innerHTML = '';
  for (const [emoji, users] of Object.entries(reactions)) {
    if (!users || users.length === 0) continue;
    const chip = document.createElement('button');
    chip.className = 'reaction-chip' + (users.includes(currentUser) ? ' mine' : '');
    chip.innerHTML = `${emoji} <span class="reaction-count">${users.length}</span>`;
    chip.title = users.join(', ');
    const msgId = parseInt(container.dataset.msgId);
    const channelId = parseInt(container.closest('.message')?.dataset.channelId);
    chip.addEventListener('click', () => {
      socket.emit('toggle_reaction', { messageId: msgId, emoji, channelId });
    });
    container.append(chip);
  }
}

function appendDateSep(label) {
  const d = document.createElement('div');
  d.className = 'date-sep';
  d.textContent = label;
  messagesEl.append(d);
}

function appendSystemMsg(text) {
  const d = document.createElement('div');
  d.className = 'system-msg';
  d.textContent = text;
  messagesEl.append(d);
}

let lastDateLabel = null;

function appendMessage(msg, isDm = false) {
  const shouldScroll = isAtBottom();
  const label = formatDate(msg.created_at);
  if (label !== lastDateLabel) {
    appendDateSep(label);
    lastDateLabel = label;
  }
  messagesEl.append(buildMessageEl(msg, isDm));
  if (shouldScroll) scrollToBottom(true);
}

function renderHistory(messages, isDm = false) {
  messagesEl.innerHTML = '';
  lastDateLabel = null;
  let prevLabel = null;
  for (const msg of messages) {
    const label = formatDate(msg.created_at);
    if (label !== prevLabel) { appendDateSep(label); prevLabel = label; }
    messagesEl.append(buildMessageEl(msg, isDm));
  }
  lastDateLabel = prevLabel;
  scrollToBottom(true);
}

// ═══════════════ KANAL LİSTESİ ═══════════════
function renderChannelList(channels) {
  channelList.innerHTML = '';
  for (const ch of channels) {
    const li = document.createElement('li');
    li.dataset.channelId = ch.id;
    if (ch.id === currentChannelId && currentView === 'channel') li.classList.add('active');
    li.innerHTML = `<span class="ch-hash">#</span><span>${ch.name}</span>`;
    li.addEventListener('click', () => switchToChannel(ch.id));
    channelList.append(li);
  }
}

function setActiveChannelInSidebar(channelId) {
  channelList.querySelectorAll('li').forEach(li =>
    li.classList.toggle('active', parseInt(li.dataset.channelId) === channelId && currentView === 'channel')
  );
  document.querySelectorAll('#dm-user-list li').forEach(li => li.classList.remove('active'));
  const ch = currentChannels.find(c => c.id === channelId);
  if (ch) {
    chIconEl.textContent = '#';
    channelNameEl.textContent = ch.name;
    channelDescEl.textContent = ch.description || '';
    messageInput.placeholder = `#${ch.name} kanalına mesaj gönder`;
  }
}

function switchToChannel(channelId) {
  if (channelId === currentChannelId && currentView === 'channel') return;
  currentView = 'channel';
  currentChannelId = channelId;
  currentDmPeer = null;
  typingUsers.clear();
  updateTypingIndicator();
  setActiveChannelInSidebar(channelId);
  messagesEl.innerHTML = '';
  socket.emit('switch_channel', { channelId });
  if (currentVoiceRoom) socket.emit('music_sync_request', { voiceRoom: currentVoiceRoom });
}

// ═══════════════ DM ═══════════════
function renderGlobalUserList(users) {
  dmUserList.innerHTML = '';
  for (const username of users) {
    if (username === currentUser) continue;
    const li = document.createElement('li');
    li.dataset.dmUser = username;

    const av = document.createElement('div');
    av.className = 'dm-avatar';
    av.style.background = avatarColor(username);
    av.textContent = username[0].toUpperCase();

    const dot = document.createElement('div');
    dot.className = 'dm-online-dot';
    av.append(dot);

    const name = document.createElement('span');
    name.textContent = username;

    li.append(av, name);

    const count = dmNotifCounts[username] || 0;
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'dm-notif-badge';
      badge.textContent = count;
      li.append(badge);
    }

    if (currentView === 'dm' && currentDmPeer === username) li.classList.add('active');
    li.addEventListener('click', () => openDm(username));
    dmUserList.append(li);
  }
}

function openDm(peer) {
  currentView = 'dm';
  currentDmPeer = peer;
  dmNotifCounts[peer] = 0;

  channelList.querySelectorAll('li').forEach(li => li.classList.remove('active'));
  dmUserList.querySelectorAll('li').forEach(li =>
    li.classList.toggle('active', li.dataset.dmUser === peer)
  );

  chIconEl.textContent = '@';
  channelNameEl.textContent = peer;
  channelDescEl.textContent = '';
  messageInput.placeholder = `${peer} kişisine mesaj gönder`;
  typingEl.innerHTML = '';
  messagesEl.innerHTML = '';
  socket.emit('get_dm_history', { with: peer });
}

// ═══════════════ YAZILIYOR ═══════════════
function updateTypingIndicator() {
  if (typingUsers.size === 0) { typingEl.innerHTML = ''; return; }
  const names = [...typingUsers];
  const text = names.length === 1 ? `${names[0]} yazıyor`
             : names.length === 2 ? `${names[0]} ve ${names[1]} yazıyor`
             : `${names.length} kişi yazıyor`;
  typingEl.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span>${text}...</span>`;
}

// ═══════════════ EMOJİ SEÇİCİ ═══════════════
let emojiTarget = null;

function showEmojiPicker(e, msgId, channelId) {
  e.stopPropagation();
  emojiTarget = { msgId, channelId };
  const rect = e.currentTarget.getBoundingClientRect();
  emojiPicker.style.top  = `${rect.bottom + 6}px`;
  emojiPicker.style.left = `${rect.left}px`;
  emojiPicker.classList.remove('hidden');
}

emojiPicker.addEventListener('click', (e) => {
  const emoji = e.target.dataset.emoji;
  if (!emoji || !emojiTarget) return;
  socket.emit('toggle_reaction', { messageId: emojiTarget.msgId, emoji, channelId: emojiTarget.channelId });
  emojiPicker.classList.add('hidden');
  emojiTarget = null;
});

document.addEventListener('click', () => {
  emojiPicker.classList.add('hidden');
  emojiTarget = null;
});

// ═══════════════ MÜZİK BOTU (SoundCloud) ═══════════════

const SC_REGEX = /soundcloud\.com\/[^\s"']+/i;
let scWidget   = null;
let scReady    = false;
let scDuration = 0;

function fmtTime(sec) {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function loadScApi() {
  if (document.querySelector('script[src*="soundcloud.com/player/api"]')) return;
  const tag = document.createElement('script');
  tag.src = 'https://w.soundcloud.com/player/api.js';
  tag.onload = () => console.log('[Müzik] SoundCloud API yüklendi');
  document.head.appendChild(tag);
}

function initScWidget(trackUrl, seekMs, autoplay) {
  const iframe = $('sc-player');
  const embedUrl = `https://w.soundcloud.com/player/?url=${encodeURIComponent(trackUrl)}&auto_play=${autoplay}&hide_related=true&show_comments=false&show_user=false&show_reposts=false&show_teaser=false&visual=false&color=%235865f2`;
  iframe.src = embedUrl;

  scReady = false;
  scWidget = SC.Widget(iframe);

  scWidget.bind(SC.Widget.Events.READY, () => {
    scReady = true;
    scWidget.setVolume(parseInt(localStorage.getItem('musicVolume') ?? '80'));
    if (seekMs > 0) scWidget.seekTo(seekMs);
    if (autoplay) {
      scWidget.play();
      startProgressTimer();
    } else {
      scWidget.pause();
    }
    audioUnlockBanner.classList.add('hidden');
  });

  scWidget.bind(SC.Widget.Events.PLAY_PROGRESS, (e) => {
    scDuration = e.loadedProgress > 0 ? e.currentPosition / e.loadedProgress : 0;
    if (e.loadedProgress > 0) {
      const dur = e.currentPosition / e.loadedProgress;
      musicProgressFill.style.width = `${(e.currentPosition / dur) * 100}%`;
      musicElapsed.textContent    = fmtTime(e.currentPosition / 1000);
      musicDurationEl.textContent = fmtTime(dur / 1000);
    }
  });

  scWidget.bind(SC.Widget.Events.FINISH, () => {
    socket?.emit('music_skip', { channelId: currentChannelId });
  });

  scWidget.bind(SC.Widget.Events.ERROR, () => {
    if (currentVoiceRoom) socket?.emit('music_error_skip', { voiceRoom: currentVoiceRoom, reason: 'Bu parça SoundCloud\'da çalınamıyor' });
  });
}

function startProgressTimer() {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (!scWidget || !scReady) return;
    scWidget.getPosition(pos => {
      scWidget.getDuration(dur => {
        if (dur > 0) {
          musicProgressFill.style.width = `${(pos / dur) * 100}%`;
          musicElapsed.textContent    = fmtTime(pos / 1000);
          musicDurationEl.textContent = fmtTime(dur / 1000);
        }
      });
    });
  }, 1000);
}

function applyMusicState(state) {
  if (!state.current) {
    musicPanel.classList.add('hidden');
    audioUnlockBanner.classList.add('hidden');
    clearInterval(progressTimer);
    if (scWidget) { try { scWidget.pause(); } catch {} }
    $('sc-player').src = '';
    return;
  }

  musicPanel.classList.remove('hidden');
  musicTitle.textContent   = state.current.title;
  musicAddedBy.textContent = `${state.current.addedBy} ekledi`;
  musicThumb.src           = state.current.thumbnail || '';

  const playPath = state.isPlaying ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z' : 'M8 5v14l11-7z';
  musicPlayIcon.querySelector('path').setAttribute('d', playPath);

  if (state.queue.length > 0) {
    musicQueueWrap.classList.remove('hidden');
    musicQueueList.innerHTML = '';
    state.queue.forEach(song => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = song.title;
      li.append(span);
      musicQueueList.append(li);
    });
  } else {
    musicQueueWrap.classList.add('hidden');
  }

  if (typeof SC === 'undefined') {
    pendingState = state;
    return;
  }

  const seekMs = Math.max(0, (state.elapsed + (Date.now() - state.serverTime) / 1000)) * 1000;
  const currentSrc = $('sc-player').src;
  const isSameTrack = currentSrc.includes(encodeURIComponent(state.current.trackUrl));

  if (isSameTrack && scReady) {
    scWidget.seekTo(seekMs);
    if (state.isPlaying) { scWidget.play(); startProgressTimer(); }
    else { scWidget.pause(); clearInterval(progressTimer); }
  } else {
    initScWidget(state.current.trackUrl, seekMs, state.isPlaying);
  }
}

async function getScInfo(trackUrl) {
  try {
    const res  = await fetch(`https://soundcloud.com/oembed?url=${encodeURIComponent(trackUrl)}&format=json`);
    const data = await res.json();
    return {
      title:     data.title || 'Bilinmeyen Parça',
      thumbnail: data.thumbnail_url || '',
    };
  } catch {
    return { title: trackUrl.split('/').pop().replace(/-/g, ' '), thumbnail: '' };
  }
}

async function handleMusicCommand(text) {
  if (!currentVoiceRoom) {
    appendSystemMsg('🎵 Müzik çalmak için önce bir sesli kanala gir.', currentChannelId);
    return true;
  }

  audioUnlocked = true; // kullanıcı /play yazdı → etkileşim var

  // Doğrudan SoundCloud URL'si mi?
  const match = text.match(SC_REGEX);
  if (match) {
    const trackUrl = 'https://' + match[0].split('?')[0];
    const info     = await getScInfo(trackUrl);
    socket.emit('music_add', {
      trackUrl,
      title:     info.title,
      thumbnail: info.thumbnail,
      addedBy:   currentUser,
      voiceRoom: currentVoiceRoom,
    });
    return true;
  }

  audioUnlocked = true; // kullanıcı /play yazdı → etkileşim var

  // Başlık araması
  appendSystemMsg(`🔍 Aranıyor: ${text}`, currentChannelId);
  try {
    const res  = await fetch(`/api/music/search?q=${encodeURIComponent(text)}`);
    const data = await res.json();
    if (!data.results?.length) {
      appendSystemMsg('🎵 Şarkı bulunamadı.', currentChannelId);
      return true;
    }
    const track = data.results[0];
    socket.emit('music_add', {
      trackUrl:  track.trackUrl,
      title:     track.title,
      thumbnail: track.thumbnail,
      addedBy:   currentUser,
      voiceRoom: currentVoiceRoom,
    });
  } catch {
    appendSystemMsg('🎵 Arama sırasında hata oluştu.', currentChannelId);
  }
  return true;
}

audioUnlockBtn.addEventListener('click', () => {
  audioUnlocked = true;
  audioUnlockBanner.classList.add('hidden');
  if (pendingState) {
    const state = pendingState;
    pendingState = null;
    applyMusicState(state);
  } else if (scWidget && scReady) {
    scWidget.play();
    startProgressTimer();
  }
});

musicPlayBtn.addEventListener('click', () => {
  if (!scWidget || !scReady || !currentVoiceRoom) return;
  scWidget.isPaused(paused => {
    if (paused) socket.emit('music_play',  { voiceRoom: currentVoiceRoom });
    else        socket.emit('music_pause', { voiceRoom: currentVoiceRoom });
  });
});

musicSkipBtn.addEventListener('click', () => {
  if (!currentVoiceRoom) return;
  socket.emit('music_skip', { voiceRoom: currentVoiceRoom });
});

// Ses ayarı — localStorage'dan yükle
const savedVol = parseInt(localStorage.getItem('musicVolume') ?? '80');
musicVolume.value = savedVol;
musicVolumeLabel.textContent = savedVol + '%';

musicVolume.addEventListener('input', () => {
  const vol = parseInt(musicVolume.value);
  musicVolumeLabel.textContent = vol + '%';
  localStorage.setItem('musicVolume', vol);
  if (scWidget && scReady) scWidget.setVolume(vol);
});

// ═══════════════ EKRAN PAYLAŞIMI ═══════════════
const QUALITY_PRESETS = {
  low:    { video: { width: 1280, height: 720,  frameRate: 15 }, audioBitrate: 64000,   videoBitrate: 500000  },
  normal: { video: { width: 1920, height: 1080, frameRate: 30 }, audioBitrate: 128000,  videoBitrate: 2000000 },
  high:   { video: { width: 2560, height: 1440, frameRate: 60 }, audioBitrate: 128000,  videoBitrate: 6000000 },
};
let selectedQuality = 'normal';

// Kalite modalını göster, seçim sonrası paylaşımı başlat
function startScreenShare() {
  if (isSharing) { stopScreenShare(); return; }
  qualityOverlay.classList.remove('hidden');
}

async function doStartScreenShare() {
  const preset = QUALITY_PRESETS[selectedQuality];
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { ...preset.video, cursor: 'always' },
      audio: true,
    });
  } catch {
    return;
  }

  isSharing = true;
  screenShareBtn.classList.add('sharing');
  screenShareLabel.textContent = 'Paylaşımı Durdur';
  screenStream.getVideoTracks()[0].onended = () => stopScreenShare();
  socket.emit('screen_share_start');
}

// Kalite modal event'leri
document.querySelectorAll('.quality-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.quality-opt').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    selectedQuality = opt.dataset.quality;
  });
});
$('quality-cancel').addEventListener('click', () => qualityOverlay.classList.add('hidden'));
$('quality-start').addEventListener('click', () => {
  qualityOverlay.classList.add('hidden');
  doStartScreenShare();
});

function stopScreenShare() {
  if (!isSharing) return;
  isSharing = false;

  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }

  for (const [, pc] of screenPeerConns) pc.close();
  screenPeerConns.clear();

  socket.emit('screen_share_stop');

  screenShareBtn.classList.remove('sharing');
  screenShareLabel.textContent = 'Ekranı Paylaş';
}

async function createScreenPeerForViewer(viewerId) {
  const pc = new RTCPeerConnection(ICE);
  screenPeerConns.set(viewerId, pc);

  if (screenStream) screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));

  pc.onicecandidate = (ev) => {
    if (ev.candidate) socket.emit('screen_ice', { to: viewerId, candidate: ev.candidate });
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('screen_offer', { to: viewerId, offer });

  // Bitrate limiti uygula
  const preset = QUALITY_PRESETS[selectedQuality];
  pc.getSenders().forEach(sender => {
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    if (sender.track?.kind === 'video') params.encodings[0].maxBitrate = preset.videoBitrate;
    if (sender.track?.kind === 'audio') params.encodings[0].maxBitrate = preset.audioBitrate;
    sender.setParameters(params).catch(() => {});
  });

  return pc;
}

async function createScreenViewConn(sharerId) {
  if (screenViewConn) { screenViewConn.close(); screenViewConn = null; }

  const pc = new RTCPeerConnection(ICE);
  screenViewConn = pc;

  pc.ontrack = (ev) => {
    screenVideo.srcObject = ev.streams[0];
    screenPanel.classList.remove('hidden');
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) socket.emit('screen_ice', { to: sharerId, candidate: ev.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected','failed','closed'].includes(pc.connectionState)) {
      screenPanel.classList.add('hidden');
      screenVideo.srcObject = null;
    }
  };

  return pc;
}

// Paneli sürüklenebilir yap
(function makeDraggable() {
  const header = $('screen-panel-header');
  let ox = 0, oy = 0, startX = 0, startY = 0;

  header.addEventListener('mousedown', (e) => {
    startX = e.clientX; startY = e.clientY;
    const rect = screenPanel.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
    screenPanel.style.right = 'auto';
    screenPanel.style.bottom = 'auto';

    function onMove(e) {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      screenPanel.style.left = (ox + dx) + 'px';
      screenPanel.style.top  = (oy + dy) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

screenPanelClose.addEventListener('click', () => {
  screenPanel.classList.remove('fullscreen-mode');
  screenPanel.classList.add('hidden');
  screenVideo.srcObject = null;
  if (screenViewConn) { screenViewConn.close(); screenViewConn = null; }
});

// Tam ekran
function toggleScreenFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    screenPanel.requestFullscreen().catch(() => {
      // Fallback: CSS fullscreen
      screenPanel.classList.toggle('fullscreen-mode');
    });
  }
}
screenFullscreenBtn.addEventListener('click', toggleScreenFullscreen);
screenVideo.addEventListener('dblclick', toggleScreenFullscreen);
document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  screenFullscreenBtn.textContent = isFs ? '⊠' : '⛶';
});

screenShareBtn.addEventListener('click', startScreenShare);

// ═══════════════ SESLİ KANAL (WebRTC) ═══════════════
async function joinVoiceChannel(room) {
  if (currentVoiceRoom === room) {
    await leaveVoiceChannel();
    return;
  }
  if (currentVoiceRoom) await leaveVoiceChannel();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        noiseSuppression: ($('toggle-noise')?.checked ?? true),
        echoCancellation: ($('toggle-echo')?.checked  ?? true),
        autoGainControl:  ($('toggle-gain')?.checked  ?? true),
      },
      video: false,
    });
  } catch (err) {
    alert('Mikrofona erişim izni reddedildi: ' + err.message);
    return;
  }
  // Local mikrofon analizi (konuşma göstergesi + metre)
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(localStream);
    const an  = ctx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    audioAnalysers.set('local', an);
  } catch {}

  currentVoiceRoom = room;
  audioUnlocked = true;
  socket.emit('voice_join', { room });
  socket.emit('music_sync_request', { voiceRoom: room });
  sounds.voiceJoin();
  updateVoiceUI();
  applyVoiceMode();
  startSpeakingDetection();
}

async function leaveVoiceChannel() {
  if (!currentVoiceRoom) return;
  socket.emit('voice_leave');
  closeAllPeers();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  currentVoiceRoom = null;
  pttActive = false;
  audioAnalysers.clear();
  voicePeerIds.clear();
  clearInterval(speakingTimer);
  speakingTimer = null;
  $('mic-meter')?.classList.add('hidden');
  applyMusicState({ current: null });
  sounds.voiceLeave();
  updateVoiceUI();
  hidePttIndicator();
}

function closeAllPeers() {
  for (const [id, pc] of peerConnections) { pc.close(); removeAudio(id); }
  peerConnections.clear();
  mutedPeers.clear();
}

async function createPeer(peerId, initiator) {
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);

  const pc = new RTCPeerConnection(ICE);
  peerConnections.set(peerId, pc);

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = (ev) => {
    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${peerId}`;
      audio.autoplay = true;
      document.body.append(audio);
    }
    audio.srcObject = ev.streams[0];
    const username = voicePeerIds.get(peerId);
    if (username) {
      audio.volume   = peerVolumes[username] ?? 1;
      audio.muted    = locallyMuted.has(username);
    }
    // Konuşma analizi
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(ev.streams[0]);
      const an  = ctx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      audioAnalysers.set(peerId, an);
    } catch {}
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) socket.emit('voice_ice', { to: peerId, candidate: ev.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected','failed','closed'].includes(pc.connectionState)) {
      pc.close();
      peerConnections.delete(peerId);
      removeAudio(peerId);
    }
  };

  // Bağlantı kalitesi — 5sn'de bir RTT ölç
  const qualityInterval = setInterval(async () => {
    if (!peerConnections.has(peerId)) { clearInterval(qualityInterval); return; }
    try {
      const stats = await pc.getStats();
      stats.forEach(s => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime !== undefined) {
          const rtt = s.currentRoundTripTime * 1000; // ms
          const dot = rtt < 80 ? '🟢' : rtt < 200 ? '🟡' : '🔴';
          const username = voicePeerIds.get(peerId);
          if (username) {
            document.querySelectorAll('.vc-member-item').forEach(li => {
              if (li.dataset.username === username) {
                let badge = li.querySelector('.quality-badge');
                if (!badge) {
                  badge = document.createElement('span');
                  badge.className = 'quality-badge';
                  badge.style.cssText = 'font-size:.7rem;margin-left:2px;';
                  li.querySelector('span')?.after(badge);
                }
                badge.textContent = dot;
                badge.title = `${Math.round(rtt)}ms`;
              }
            });
          }
        }
      });
    } catch {}
  }, 5000);

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('voice_offer', { to: peerId, offer });
  }

  return pc;
}

function removeAudio(peerId) {
  document.getElementById(`audio-${peerId}`)?.remove();
  audioAnalysers.delete(peerId);
  voicePeerIds.delete(peerId);
}

function getLevel(analyser) {
  const d = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(d);
  return d.reduce((a, b) => a + b, 0) / d.length;
}

function setSpeaking(username, on) {
  document.querySelectorAll('.vc-member-item').forEach(li => {
    if (li.dataset.username === username) li.classList.toggle('speaking', on);
  });
  if (username === currentUser) $('self-avatar')?.classList.toggle('speaking', on);
}

function startSpeakingDetection() {
  clearInterval(speakingTimer);
  $('mic-meter')?.classList.remove('hidden');
  speakingTimer = setInterval(() => {
    // Local
    const localAn = audioAnalysers.get('local');
    if (localAn) {
      const lvl = getLevel(localAn);
      const talking = lvl > SPEAKING_THR && (voiceMode === 'vad' || pttActive);
      setSpeaking(currentUser, talking);
      const pct = Math.min(100, lvl * 2);
      const fill = $('mic-meter-fill');
      if (fill) fill.style.width = pct + '%';
    }
    // Remote peers
    for (const [sid, an] of audioAnalysers) {
      if (sid === 'local') continue;
      const uname = voicePeerIds.get(sid);
      if (uname) setSpeaking(uname, getLevel(an) > SPEAKING_THR);
    }
  }, 80);
}

function updateVoiceUI() {
  if (currentVoiceRoom) {
    voiceControls.classList.remove('hidden');
    micBtn.style.display = 'flex';
    updateMuteBtn();
  } else {
    voiceControls.classList.add('hidden');
    micBtn.style.display = 'none';
  }
  // Sesli kanal listesindeki aktif durumu güncelle
  document.querySelectorAll('.voice-channel-item').forEach(li => {
    li.classList.toggle('active', li.dataset.room === currentVoiceRoom);
  });
}

function updateMuteBtn() {
  const muteIcon = isMuted
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.42 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.3 6-6.72h-1.7z"/></svg>`;
  vcMuteBtn.innerHTML = muteIcon;
  vcMuteBtn.classList.toggle('muted', isMuted);
  micBtn.classList.toggle('muted', isMuted);
  micBtn.innerHTML = muteIcon;
}

function toggleMute() {
  isMuted = !isMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  socket.emit('voice_mute_state', { muted: isMuted });
  isMuted ? sounds.mute() : sounds.unmute();
  updateMuteBtn();
}

// ── Ses modu (PTT / VAD) ──────────────────────────────────────────────────────
let pttActive  = false;
let voiceMode  = localStorage.getItem('voiceMode') || 'ptt'; // 'ptt' | 'vad'

function applyVoiceMode() {
  if (!currentVoiceRoom || !localStream) return;
  if (voiceMode === 'vad') {
    // Ses etkinliği: mikrofon her zaman açık
    isMuted = false;
    localStream.getAudioTracks().forEach(t => { t.enabled = true; });
    socket.emit('voice_mute_state', { muted: false });
    hidePttIndicator();
  } else {
    // PTT: başlangıçta kapalı
    isMuted = true;
    localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    socket.emit('voice_mute_state', { muted: true });
    showPttIndicator(false);
  }
  updateMuteBtn();
}

// PTT — Space
document.addEventListener('keydown', (e) => {
  if (!currentVoiceRoom || voiceMode !== 'ptt') return;
  if (e.code !== 'Space') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (pttActive) return;
  pttActive = true;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = true; });
  socket.emit('voice_mute_state', { muted: false });
  showPttIndicator(true);
});

document.addEventListener('keyup', (e) => {
  if (!currentVoiceRoom || voiceMode !== 'ptt') return;
  if (e.code !== 'Space') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  pttActive = false;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
  socket.emit('voice_mute_state', { muted: true });
  showPttIndicator(false);
});

// ── Ayarlar modalı ───────────────────────────────────────────────────────────
const settingsOverlay = $('settings-overlay');

// Kayıtlı toggle değerlerini yükle
['noise','echo','gain'].forEach(key => {
  const el = $(`toggle-${key}`);
  if (!el) return;
  const saved = localStorage.getItem(`audio-${key}`);
  if (saved !== null) el.checked = saved === 'true';
  el.addEventListener('change', () => localStorage.setItem(`audio-${key}`, el.checked));
});

$('settings-btn').addEventListener('click', () => {
  document.querySelectorAll('.settings-opt[data-voice-mode]').forEach(o => {
    o.classList.toggle('selected', o.dataset.voiceMode === voiceMode);
  });
  settingsOverlay.classList.remove('hidden');
});

$('settings-close').addEventListener('click', () => settingsOverlay.classList.add('hidden'));
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden'); });

document.querySelectorAll('.settings-opt[data-voice-mode]').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.settings-opt[data-voice-mode]').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    voiceMode = opt.dataset.voiceMode;
    localStorage.setItem('voiceMode', voiceMode);
    applyVoiceMode();
  });
});

function showPttIndicator(active) {
  let el = $('ptt-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ptt-indicator';
    document.body.append(el);
  }
  el.textContent = active ? '🎙️ Konuşuyor...' : '🔇 Space\'e bas';
  el.className = active ? 'ptt-talking' : 'ptt-muted';
  el.classList.remove('hidden');
}

function hidePttIndicator() {
  $('ptt-indicator')?.classList.add('hidden');
}

function updateVoiceRoomsUI(state) {
  for (const [room, users] of Object.entries(state)) {
    const el = document.getElementById(`vm-${room}`);
    if (!el) continue;
    el.innerHTML = '';
    for (const username of users) {
      const li = document.createElement('li');
      li.className = 'vc-member-item';
      li.dataset.username = username;
      if (locallyMuted.has(username)) li.classList.add('vc-locally-muted');

      const av = document.createElement('div');
      av.className = 'vc-member-avatar';
      av.style.background = avatarColor(username);
      av.textContent = username[0].toUpperCase();

      const name = document.createElement('span');
      name.textContent = username;
      name.style.flex = '1';
      name.style.fontSize = '.82rem';
      name.style.color = 'var(--text-2)';

      li.append(av, name);

      if (mutedPeers.has(username)) {
        const icon = document.createElement('span');
        icon.className = 'vc-muted-icon';
        icon.textContent = '🔇';
        li.append(icon);
      }

      // Kendi satırı değilse ses kontrolleri
      if (username !== currentUser) {
        const controls = document.createElement('div');
        controls.className = 'vc-peer-controls';

        // Ses slider
        const vol = document.createElement('input');
        vol.type = 'range'; vol.min = 0; vol.max = 150; vol.className = 'vc-peer-vol';
        vol.value = Math.round((peerVolumes[username] ?? 1) * 100);
        vol.title = 'Ses seviyesi';
        vol.addEventListener('input', () => {
          const v = parseInt(vol.value) / 100;
          peerVolumes[username] = v;
          // Tüm audio elementleri bul (socketId → username eşleşmesi)
          for (const [sid, uname] of voicePeerIds) {
            if (uname === username) {
              const audio = document.getElementById(`audio-${sid}`);
              if (audio) audio.volume = Math.min(v, 1); // audio.volume max 1
            }
          }
        });

        // Sustur butonu
        const muteBtn = document.createElement('button');
        muteBtn.className = 'vc-peer-mute-btn' + (locallyMuted.has(username) ? ' muted' : '');
        muteBtn.textContent = locallyMuted.has(username) ? '🔇' : '🔊';
        muteBtn.title = 'Beni için sustur/aç';
        muteBtn.addEventListener('click', () => {
          if (locallyMuted.has(username)) {
            locallyMuted.delete(username);
            muteBtn.textContent = '🔊';
            muteBtn.classList.remove('muted');
            li.classList.remove('vc-locally-muted');
          } else {
            locallyMuted.add(username);
            muteBtn.textContent = '🔇';
            muteBtn.classList.add('muted');
            li.classList.add('vc-locally-muted');
          }
          for (const [sid, uname] of voicePeerIds) {
            if (uname === username) {
              const audio = document.getElementById(`audio-${sid}`);
              if (audio) audio.muted = locallyMuted.has(username);
            }
          }
        });

        controls.append(vol, muteBtn);
        li.append(controls);
      }

      el.append(li);
    }
  }
}

// ═══════════════ SOCKET OLAYLARI ═══════════════
function setupSocket() {
  socket.on('auth_error', ({ message }) => {
    // Zaten giriş yapılmışsa (auto-reconnect race condition) sayfayı yenile
    if (currentUser && appEl.classList.contains('_shown')) {
      location.reload();
      return;
    }
    loginError.textContent = message;
    $('join-btn').disabled = false;
    socket.disconnect();
    socket = null;
  });

  socket.on('message_history', ({ messages, channelId }) => {
    // İlk bağlantıda UI'yi aç
    if (!appEl.classList.contains('_shown')) {
      appEl.classList.add('_shown');
      loginScreen.style.display = 'none';
      appEl.classList.remove('hidden');
      selfAvatar.textContent = currentUser[0].toUpperCase();
      selfAvatar.style.background = avatarColor(currentUser);
      selfUsername.textContent = currentUser;
      renderChannelList(currentChannels);
      setActiveChannelInSidebar(currentChannelId);
    }
    if (currentView === 'channel' && channelId === currentChannelId) {
      renderHistory(messages);
    }
  });

  socket.on('new_message', ({ message }) => {
    if (currentView === 'channel' && message.channel_id === currentChannelId) {
      appendMessage(message);
      if (message.username !== currentUser && document.hidden) sounds.message();
    }
  });

  socket.on('reaction_updated', ({ messageId, reactions }) => {
    const msgEl = document.querySelector(`.message[data-msg-id="${messageId}"]`);
    if (!msgEl) return;
    const row = msgEl.querySelector('.msg-reactions');
    if (row) { row.dataset.msgId = messageId; renderReactions(row, reactions); }
  });

  socket.on('user_list', ({ users }) => {
    // kanal içi çevrimiçi — şu an global list yeterli
  });

  socket.on('global_user_list', ({ users }) => {
    renderGlobalUserList(users);
  });

  socket.on('system_message', ({ text, channelId }) => {
    if (currentView === 'channel' && channelId === currentChannelId) {
      appendSystemMsg(text);
      scrollToBottom();
      if (text.includes('katıldı')) sounds.userJoin();
    }
  });

  socket.on('user_typing', ({ username, channelId }) => {
    if (currentView === 'channel' && channelId === currentChannelId && username !== currentUser) {
      typingUsers.add(username);
      updateTypingIndicator();
    }
  });

  socket.on('user_stop_typing', ({ username }) => {
    typingUsers.delete(username);
    updateTypingIndicator();
  });

  // DM
  socket.on('dm_history', ({ messages, peer }) => {
    if (currentView === 'dm' && currentDmPeer === peer) {
      renderHistory(messages, true);
    }
  });

  socket.on('new_dm', ({ message }) => {
    const partner = message.from === currentUser ? message.to : message.from;
    if (currentView === 'dm' && currentDmPeer === partner) {
      appendMessage(message, true);
    } else if (message.from !== currentUser) {
      dmNotifCounts[message.from] = (dmNotifCounts[message.from] || 0) + 1;
      renderGlobalUserList([...Object.keys(dmNotifCounts), ...
        [...dmUserList.querySelectorAll('li')].map(l => l.dataset.dmUser)
      ].filter((v, i, a) => a.indexOf(v) === i));
    }
  });

  socket.on('dm_notification', ({ from }) => {
    if (!(currentView === 'dm' && currentDmPeer === from)) {
      dmNotifCounts[from] = (dmNotifCounts[from] || 0) + 1;
      sounds.dm();
    }
  });

  socket.on('dm_user_typing', ({ from }) => {
    if (currentView === 'dm' && currentDmPeer === from) {
      typingEl.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span>${from} yazıyor...</span>`;
    }
  });

  socket.on('dm_user_stop_typing', ({ from }) => {
    if (currentView === 'dm' && currentDmPeer === from) typingEl.innerHTML = '';
  });

  // Sesli kanal
  socket.on('voice_channels_list', (channels) => renderVoiceChannels(channels));
  socket.on('voice_rooms_state', (state) => updateVoiceRoomsUI(state));

  socket.on('voice_peers', async ({ peers }) => {
    for (const peer of peers) {
      voicePeerIds.set(peer.socketId, peer.username);
      await createPeer(peer.socketId, true);
    }
  });

  socket.on('voice_peer_joined', async ({ socketId, username }) => {
    if (username) voicePeerIds.set(socketId, username);
  });

  socket.on('voice_offer', async ({ from, offer }) => {
    const pc = await createPeer(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('voice_answer', { to: from, answer });
  });

  socket.on('voice_answer', async ({ from, answer }) => {
    const pc = peerConnections.get(from);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('voice_ice', async ({ from, candidate }) => {
    const pc = peerConnections.get(from);
    if (pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });

  socket.on('voice_peer_left', ({ socketId }) => {
    const pc = peerConnections.get(socketId);
    if (pc) { pc.close(); peerConnections.delete(socketId); }
    removeAudio(socketId);
  });

  socket.on('voice_peer_muted', ({ socketId, muted }) => {
    if (muted) mutedPeers.add(socketId);
    else mutedPeers.delete(socketId);
  });

  // ── Müzik ────────────────────────────────────────────────────────────────
  socket.on('music_state', (state) => applyMusicState(state));
  socket.on('music_system', ({ text }) => appendSystemMsg(`🎵 ${text}`, currentChannelId));

  socket.on('music_play', () => {
    if (scWidget && scReady) { scWidget.play(); startProgressTimer(); }
    musicPlayIcon.querySelector('path').setAttribute('d', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
  });

  socket.on('music_pause', () => {
    if (scWidget && scReady) { scWidget.pause(); clearInterval(progressTimer); }
    musicPlayIcon.querySelector('path').setAttribute('d', 'M8 5v14l11-7z');
  });

  // ── Ekran paylaşımı ──────────────────────────────────────────────────────
  socket.on('screen_share_available', ({ sharerId, username }) => {
    screenPanelTitle.textContent = `📺 ${username} ekranını paylaşıyor`;
    // Viewer olarak bağlantı iste
    socket.emit('screen_view_request', { sharerId });
  });

  socket.on('screen_viewer_joined', async ({ viewerId }) => {
    // Biz paylaşımcıyız, yeni bir viewer geldi
    if (isSharing) await createScreenPeerForViewer(viewerId);
  });

  socket.on('screen_offer', async ({ from, offer }) => {
    const pc = await createScreenViewConn(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('screen_answer', { to: from, answer });
  });

  socket.on('screen_answer', async ({ from, answer }) => {
    const pc = screenPeerConns.get(from);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('screen_ice', async ({ from, candidate }) => {
    // Paylaşımcı tarafı
    const pc = screenPeerConns.get(from) || screenViewConn;
    if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {} }
  });

  socket.on('screen_share_ended', () => {
    screenPanel.classList.add('hidden');
    screenVideo.srcObject = null;
    if (screenViewConn) { screenViewConn.close(); screenViewConn = null; }
  });

  socket.on('disconnect', () => {
    leaveVoiceChannel();
    stopScreenShare();
  });

  setupPokerSocket();
}

// ═══════════════ GİRİŞ ═══════════════
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  if (!username) return;
  loginError.textContent = '';
  $('join-btn').disabled = true;

  try {
    const res = await fetch('/api/channels');
    currentChannels = await res.json();
  } catch {
    loginError.textContent = 'Sunucuya bağlanılamadı.';
    $('join-btn').disabled = false;
    return;
  }

  if (!currentChannels.length) {
    loginError.textContent = 'Kanal bulunamadı.';
    $('join-btn').disabled = false;
    return;
  }

  currentUser      = username;
  currentChannelId = currentChannels[0].id;

  const savedCreds = { username, password: passwordInput.value };

  socket = io();
  setupSocket();

  // İlk bağlantı + otomatik yeniden bağlanma — connect her ikisini de kapsar
  socket.on('connect', () => {
    if (!currentUser) return;
    socket.emit('join', { ...savedCreds, channelId: currentChannelId });
    if (currentVoiceRoom) {
      setTimeout(() => socket.emit('voice_join', { room: currentVoiceRoom }), 500);
    }
  });

  // SoundCloud API'yi ancak giriş sonrası yükle
  loadScApi();
});

// ═══════════════ MESAJ GÖNDER ═══════════════
messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = messageInput.value.trim();
  if (!content || !socket) return;
  messageInput.value = '';

  // /play komutu — başlık veya SoundCloud URL
  if (currentView === 'channel' && content.startsWith('/play ')) {
    const text = content.slice(6).trim();
    if (text) { await handleMusicCommand(text); return; }
  }

  if (currentView === 'dm') {
    socket.emit('send_dm', { to: currentDmPeer, content });
    if (isDmTyping) {
      isDmTyping = false;
      clearTimeout(dmTypingTimer);
      socket.emit('dm_typing_stop', { to: currentDmPeer });
    }
  } else {
    socket.emit('send_message', { channelId: currentChannelId, content });
    if (isTyping) {
      isTyping = false;
      clearTimeout(typingTimer);
      socket.emit('typing_stop', { channelId: currentChannelId });
    }
  }
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    messageForm.dispatchEvent(new Event('submit'));
  }
});

// ═══════════════ YAZILIYOR OLAYI ═══════════════
messageInput.addEventListener('input', () => {
  if (!socket) return;

  if (currentView === 'dm') {
    if (!isDmTyping) {
      isDmTyping = true;
      socket.emit('dm_typing_start', { to: currentDmPeer });
    }
    clearTimeout(dmTypingTimer);
    dmTypingTimer = setTimeout(() => {
      isDmTyping = false;
      socket.emit('dm_typing_stop', { to: currentDmPeer });
    }, 1500);
  } else {
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing_start', { channelId: currentChannelId });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      isTyping = false;
      socket.emit('typing_stop', { channelId: currentChannelId });
    }, 1500);
  }
});

// ═══════════════ SESLİ KANAL BUTONLARI (dinamik) ═══════════════
const vcList = $('voice-channel-list');

function buildVoiceChannelItem(room) {
  const li = document.createElement('li');
  li.className = 'voice-channel-item';
  li.dataset.room = room;
  if (room === currentVoiceRoom) li.classList.add('active');

  const row = document.createElement('div');
  row.className = 'vc-row';

  row.innerHTML = `
    <svg class="vc-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
    </svg>
    <span>${room}</span>
  `;

  // Leave butonu
  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'vc-leave-btn';
  leaveBtn.title = 'Kanaldan Ayrıl';
  leaveBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.61 21 3 13.39 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.58a1 1 0 0 1-.25 1.01l-2.2 2.2z"/></svg>`;
  leaveBtn.addEventListener('click', (e) => { e.stopPropagation(); leaveVoiceChannel(); });

  // Sil butonu (varsayılan kanallar hariç)
  if (!['sesli-genel','sesli-oyun'].includes(room)) {
    const delBtn = document.createElement('button');
    delBtn.className = 'vc-leave-btn';
    delBtn.title = 'Kanalı Sil';
    delBtn.style.cssText = 'font-size:.8rem;padding:2px 5px;';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('delete_voice_channel', { name: room });
    });
    row.append(leaveBtn, delBtn);
  } else {
    row.append(leaveBtn);
  }

  const members = document.createElement('ul');
  members.className = 'vc-members';
  members.id = `vm-${room}`;

  li.append(row, members);
  li.addEventListener('click', (e) => {
    if (e.target.closest('.vc-leave-btn')) return;
    joinVoiceChannel(room);
  });
  return li;
}

function renderVoiceChannels(channels) {
  vcList.innerHTML = '';
  channels.forEach(room => vcList.append(buildVoiceChannelItem(room)));
}

// Kanal ekleme
$('add-voice-channel-btn').addEventListener('click', () => {
  const name = prompt('Kanal adı (örn: sesli-müzik):');
  if (name) socket.emit('create_voice_channel', { name });
});

vcMuteBtn.addEventListener('click', toggleMute);
micBtn.addEventListener('click', toggleMute);

// ═══════════════ POKER ═══════════════
let pokerState = null;
let pokerOpen  = false;

const pokerOverlay    = $('poker-overlay');
const pokerPot        = $('poker-pot');
const pokerPhaseLabel = $('poker-phase-label');
const pokerCommunity  = $('poker-community-cards');
const pokerSeats      = $('poker-seats');
const pokerMyArea     = $('poker-my-area');
const pokerHoleCards  = $('poker-hole-cards');
const pokerMyChips    = $('poker-my-chips');
const pokerMyBet      = $('poker-my-bet');
const pokerWinnerBanner = $('poker-winner-banner');
const pokerActions    = $('poker-actions');
const pokerLobby      = $('poker-lobby');
const pokerSeatCount  = $('poker-seat-count');
const pokerLobbyPlayers = $('poker-lobby-players');
const pokerJoinBtn    = $('poker-join-btn');
const pokerLeaveBtn   = $('poker-leave-btn');
const pokerStartBtn   = $('poker-start-btn');
const pokerFoldBtn    = $('poker-fold-btn');
const pokerCheckBtn   = $('poker-check-btn');
const pokerCallBtn    = $('poker-call-btn');
const pokerCallAmt    = $('poker-call-amt');
const pokerRaiseBtn   = $('poker-raise-btn');
const pokerRaiseSlider = $('poker-raise-slider');
const pokerRaiseAmt   = $('poker-raise-amt');

const CARD_SUIT = { S:'♠', H:'♥', D:'♦', C:'♣' };
const CARD_VAL  = { 11:'J', 12:'Q', 13:'K', 14:'A' };
const PHASE_TR  = { waiting:'Bekleniyor', preflop:'Preflop', flop:'Flop', turn:'Turn', river:'River', showdown:'Sonuç' };

function cardEl(card) {
  const div = document.createElement('div');
  div.className = 'poker-card';
  if (!card) { div.className += ' card-back'; div.textContent = '🂠'; return div; }
  const red = card.s === 'H' || card.s === 'D';
  if (red) div.classList.add('red');
  const val = CARD_VAL[card.v] || card.v;
  div.innerHTML = `<span class="card-val">${val}</span><span class="card-suit">${CARD_SUIT[card.s]}</span>`;
  return div;
}

function renderPoker(state) {
  pokerState = state;

  if (!state) {
    // No table exists
    pokerLobby.classList.remove('hidden');
    pokerCommunity.innerHTML = '';
    pokerSeats.innerHTML = '';
    pokerMyArea.classList.add('hidden');
    pokerActions.classList.add('hidden');
    pokerWinnerBanner.classList.add('hidden');
    pokerSeatCount.textContent = '0';
    pokerLobbyPlayers.innerHTML = '';
    pokerJoinBtn.classList.remove('hidden');
    pokerLeaveBtn.classList.add('hidden');
    pokerStartBtn.classList.add('hidden');
    pokerPot.textContent = '0';
    pokerPhaseLabel.textContent = '';
    return;
  }

  const mySeat = state.seats.find(s => s.socketId === socket?.id);
  const myTurn = state.turn === socket?.id;

  // Phase & pot
  pokerPot.textContent = state.pot;
  pokerPhaseLabel.textContent = PHASE_TR[state.phase] || state.phase;

  // Community cards
  pokerCommunity.innerHTML = '';
  const needed = { preflop:0, flop:3, turn:4, river:5, showdown:5, waiting:0 }[state.phase] || 0;
  for (let i=0;i<5;i++) {
    pokerCommunity.append(cardEl(i < state.community.length ? state.community[i] : null));
  }

  // Seats
  pokerSeats.innerHTML = '';
  for (const s of state.seats) {
    if (s.socketId === socket?.id) continue; // own area rendered separately
    const div = document.createElement('div');
    div.className = 'poker-seat' + (s.folded?' folded':'') + (state.turn===s.socketId?' myturn':'');
    const dealer = state.seats[state.dealer]?.socketId === s.socketId;
    div.innerHTML = `
      <div class="ps-name">${s.username}${dealer?' <span class="dealer-btn">D</span>':''}</div>
      <div class="ps-chips">💰 ${s.chips} ${s.allIn?'<em>ALL-IN</em>':''}</div>
      ${s.bet>0?`<div class="ps-bet">Bet: ${s.bet}</div>`:''}
      <div class="ps-cards">${(s.hand||[]).map(c=>cardEl(c).outerHTML).join('')}</div>
    `;
    // Rebuild cardEls properly (outerHTML trick)
    const cardsDiv = div.querySelector('.ps-cards');
    cardsDiv.innerHTML = '';
    (s.hand||[null,null]).forEach(c => cardsDiv.append(cardEl(c)));
    pokerSeats.append(div);
  }

  // My area
  if (mySeat) {
    pokerMyArea.classList.remove('hidden');
    pokerHoleCards.innerHTML = '';
    (mySeat.hand||[]).forEach(c => pokerHoleCards.append(cardEl(c)));
    pokerMyChips.textContent = `💰 ${mySeat.chips} chip`;
    pokerMyBet.textContent   = mySeat.bet > 0 ? `Bet: ${mySeat.bet}` : '';
  } else {
    pokerMyArea.classList.add('hidden');
  }

  // Winner banner
  if (state.phase === 'showdown' && state.winner) {
    pokerWinnerBanner.classList.remove('hidden');
    const names = state.winner.map(id => state.seats.find(s=>s.socketId===id)?.username || id);
    pokerWinnerBanner.textContent = `🏆 ${names.join(' & ')} kazandı! (${state.winnerHand})`;
  } else {
    pokerWinnerBanner.classList.add('hidden');
  }

  // Lobby section (waiting phase)
  if (state.phase === 'waiting') {
    pokerLobby.classList.remove('hidden');
    pokerSeatCount.textContent = state.seats.length;
    pokerLobbyPlayers.innerHTML = '';
    for (const s of state.seats) {
      const li = document.createElement('div');
      li.className = 'poker-lobby-player';
      li.textContent = `${s.username} — ${s.chips} chip`;
      pokerLobbyPlayers.append(li);
    }
    if (mySeat) {
      pokerJoinBtn.classList.add('hidden');
      pokerLeaveBtn.classList.remove('hidden');
      pokerStartBtn.classList.toggle('hidden', state.seats.length < 2);
    } else {
      pokerJoinBtn.classList.toggle('hidden', state.seats.length >= 6);
      pokerLeaveBtn.classList.add('hidden');
      pokerStartBtn.classList.add('hidden');
    }
    pokerActions.classList.add('hidden');
  } else {
    pokerLobby.classList.add('hidden');
    pokerActions.classList.remove('hidden');

    // Show/hide action buttons
    const inGame = mySeat && !mySeat.folded && state.phase !== 'showdown';
    pokerActions.classList.toggle('hidden', !inGame);
    pokerFoldBtn.textContent = 'Fold';
    pokerFoldBtn.disabled = false;

    if (inGame && myTurn) {
      const canCheck = mySeat.bet === state.currentBet;
      const callAmount = Math.min(state.currentBet - mySeat.bet, mySeat.chips);
      pokerCheckBtn.classList.toggle('hidden', !canCheck);
      pokerCallBtn.classList.toggle('hidden', canCheck || callAmount <= 0);
      pokerCallAmt.textContent = callAmount > 0 ? `(${callAmount})` : '';
      const maxRaise = mySeat.chips + mySeat.bet;
      const minRaiseTotal = Math.min(state.currentBet + state.minRaise, maxRaise);
      pokerRaiseSlider.min = minRaiseTotal;
      pokerRaiseSlider.max = maxRaise;
      pokerRaiseSlider.value = Math.min(Math.max(parseInt(pokerRaiseSlider.value)||minRaiseTotal, minRaiseTotal), maxRaise);
      pokerRaiseAmt.textContent = pokerRaiseSlider.value;
      $('poker-raise-row').classList.toggle('hidden', maxRaise <= state.currentBet - mySeat.bet + 1);
      pokerFoldBtn.disabled = false;
      pokerCheckBtn.disabled = false;
      pokerCallBtn.disabled = false;
    } else if (inGame) {
      // Not our turn — show fold but disabled, hide check/call/raise
      pokerFoldBtn.textContent = 'Sıra Bekleniyor...';
      pokerFoldBtn.disabled = true;
      pokerCheckBtn.classList.add('hidden');
      pokerCallBtn.classList.add('hidden');
      $('poker-raise-row').classList.add('hidden');
    }
  }
}

function openPokerPanel() {
  pokerOverlay.classList.remove('hidden');
  pokerOpen = true;
  if (socket) socket.emit('poker_request_state');
}
function closePokerPanel() {
  pokerOverlay.classList.add('hidden');
  pokerOpen = false;
}

$('poker-open-btn').addEventListener('click', openPokerPanel);
$('poker-close').addEventListener('click', closePokerPanel);
pokerOverlay.addEventListener('click', e => { if (e.target === pokerOverlay) closePokerPanel(); });

pokerJoinBtn.addEventListener('click', () => socket?.emit('poker_join'));
pokerLeaveBtn.addEventListener('click', () => socket?.emit('poker_leave'));
pokerStartBtn.addEventListener('click', () => socket?.emit('poker_start'));
pokerFoldBtn.addEventListener('click', () => socket?.emit('poker_action', { action:'fold' }));
pokerCheckBtn.addEventListener('click', () => socket?.emit('poker_action', { action:'check' }));
pokerCallBtn.addEventListener('click', () => socket?.emit('poker_action', { action:'call' }));
pokerRaiseBtn.addEventListener('click', () => {
  socket?.emit('poker_action', { action:'raise', amount: parseInt(pokerRaiseSlider.value) });
});
pokerRaiseSlider.addEventListener('input', () => { pokerRaiseAmt.textContent = pokerRaiseSlider.value; });

// Socket events
function setupPokerSocket() {
  socket.on('poker_state', state => {
    if (pokerOpen) renderPoker(state);
    else pokerState = state;
  });
  socket.on('poker_error', msg => {
    if (pokerOpen) {
      const err = document.createElement('div');
      err.style.cssText = 'color:var(--red);font-size:.8rem;margin-top:4px;text-align:center;';
      err.textContent = '⚠️ ' + msg;
      pokerLobby.append(err);
      setTimeout(() => err.remove(), 3000);
    }
  });
}

// Hook into /poker command
const _origSubmit = messageForm.onsubmit;
messageForm.addEventListener('submit', async (e2) => {
  // Note: the original submit handler is already attached; we just handle /poker here
}, true); // capture phase won't work this way

// Override message submit to handle /poker command
// We insert a check at the TOP by modifying the existing handler indirectly:
// Instead, patch the message input handler via an interceptor on the form
const _pokerFormInterceptor = (e) => {
  const content = messageInput.value.trim();
  if (content === '/poker') {
    e.preventDefault();
    e.stopImmediatePropagation();
    messageInput.value = '';
    openPokerPanel();
  }
};
messageForm.addEventListener('submit', _pokerFormInterceptor, true);
