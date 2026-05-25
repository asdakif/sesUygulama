'use strict';

// ═══════════════ DURUM ═══════════════
let socket;
let currentUser     = null;
let currentUserProfile = null;
let currentAuthToken = null;
let currentRefreshToken = null;
let currentChannelId = null;
let currentChannels  = [];
let currentView      = 'channel'; // 'channel' | 'dm'
let currentDmPeer    = null;
let typingTimer      = null;
let isTyping         = false;
let dmTypingTimer    = null;
let isDmTyping       = false;
let authMode         = 'login';
let registrationEnabled = true;
let pendingResetToken = null;
let currentAdminTab = 'users';
let adminUsersSearchTimer = null;
let currentPendingAuthChallenge = null;
let isLoginBusy = false;
const typingUsers    = new Set();
const dmNotifCounts  = {};        // username → unread count
const AUTH_TOKEN_KEY = 'sesappAuthToken';
const REFRESH_TOKEN_KEY = 'sesappRefreshToken';
const LAST_CHANNEL_ID_KEY = 'sesappLastChannelId';
let refreshSessionPromise = null;

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
const voicePeerDebug  = new Map(); // socketId → connection diagnostics
const locallyMuted    = new Set(); // username → kendi tarafından susturulmuş
const peerVolumes     = {};        // username → 0-1
const audioAnalysers  = new Map(); // socketId|'local' → AnalyserNode
const pendingVoiceCandidates = new Map(); // socketId → RTCIceCandidateInit[]
const peerDisconnectTimers   = new Map(); // socketId → timeoutId
let reconnectVoiceJoinTimer  = null;
let latestVoiceRoomsState    = {};

function syncPeerAudioElement(peerId) {
  const audio = document.getElementById(`audio-${peerId}`);
  if (!audio) return;
  const username = voicePeerIds.get(peerId);
  if (username) {
    audio.volume = Math.min(peerVolumes[username] ?? 1, 1);
    audio.muted = locallyMuted.has(username);
  } else {
    audio.volume = 1;
    audio.muted = false;
  }
}

function tryPlayAllPeerAudioElements() {
  for (const el of document.querySelectorAll('audio[id^="audio-"]')) {
    const p = el.play?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
}

function getVoicePeerDebug(peerId) {
  return voicePeerDebug.get(peerId) || null;
}

function getVoicePeerDebugForUsername(username) {
  let selected = null;
  for (const [peerId, mappedUsername] of voicePeerIds) {
    if (mappedUsername !== username) continue;
    const debug = getVoicePeerDebug(peerId);
    if (!debug) continue;
    if (!selected || (debug.updatedAt || 0) >= (selected.updatedAt || 0)) selected = debug;
  }
  return selected;
}

function setVoicePeerDebug(peerId, patch = {}) {
  const next = {
    ...getVoicePeerDebug(peerId),
    ...patch,
    peerId,
    username: patch.username || voicePeerIds.get(peerId) || getVoicePeerDebug(peerId)?.username || null,
    updatedAt: Date.now(),
  };
  voicePeerDebug.set(peerId, next);
  if (next.username) updateVoicePeerUi(next.username);
}

function clearVoicePeerDebug(peerId) {
  const username = voicePeerIds.get(peerId) || getVoicePeerDebug(peerId)?.username;
  voicePeerDebug.delete(peerId);
  if (username) updateVoicePeerUi(username);
}

function getVoicePeerStatusText(debug) {
  if (!debug) return '';
  if (debug.state === 'failed' || debug.iceState === 'failed') return 'baglanti yok';
  if (debug.state === 'disconnected' || debug.iceState === 'disconnected') return 'kopuk';
  if (debug.state === 'connecting' || debug.iceState === 'checking' || debug.iceState === 'new') return 'baglaniyor';
  if (debug.state === 'connected' || debug.state === 'completed' || debug.iceState === 'connected' || debug.iceState === 'completed') {
    const pathLabel = debug.path === 'relay' ? 'TURN' : debug.path === 'p2p' ? 'P2P' : 'bagli';
    return Number.isFinite(debug.rttMs) ? `${pathLabel} ${Math.round(debug.rttMs)}ms` : pathLabel;
  }
  return debug.path === 'relay' ? 'TURN hazir' : 'bekliyor';
}

function getVoicePeerStatusClass(debug) {
  if (!debug) return 'idle';
  if (debug.state === 'failed' || debug.iceState === 'failed') return 'failed';
  if (debug.state === 'disconnected' || debug.iceState === 'disconnected') return 'disconnected';
  if (debug.state === 'connecting' || debug.iceState === 'checking' || debug.iceState === 'new') return 'connecting';
  if (debug.state === 'connected' || debug.state === 'completed' || debug.iceState === 'connected' || debug.iceState === 'completed') {
    return debug.path === 'relay' ? 'relay' : 'connected';
  }
  return 'idle';
}

function getVoicePeerStatusTitle(debug) {
  if (!debug) return 'Henuz baglanti bilgisi yok.';
  const parts = [];
  if (debug.state) parts.push(`Peer: ${debug.state}`);
  if (debug.iceState) parts.push(`ICE: ${debug.iceState}`);
  if (debug.path === 'relay') parts.push('Yol: TURN relay');
  else if (debug.path === 'p2p') parts.push('Yol: dogrudan P2P');
  if (debug.candidateTypes) parts.push(`Aday: ${debug.candidateTypes}`);
  if (Number.isFinite(debug.rttMs)) parts.push(`Ping: ${Math.round(debug.rttMs)}ms`);
  return parts.join(' | ');
}

function isVoicePeerMuted(username) {
  for (const [peerId, mappedUsername] of voicePeerIds) {
    if (mappedUsername === username && mutedPeers.has(peerId)) return true;
  }
  return false;
}

function updateVoicePeerUi(username) {
  if (!username) return;
  const debug = getVoicePeerDebugForUsername(username);
  const muted = isVoicePeerMuted(username);
  document.querySelectorAll('.vc-member-item').forEach((li) => {
    if (li.dataset.username !== username) return;
    li.classList.toggle('vc-locally-muted', locallyMuted.has(username));

    let status = li.querySelector('.vc-peer-status');
    if (!status) {
      status = document.createElement('span');
      status.className = 'vc-peer-status';
      li.querySelector('.vc-member-name')?.after(status);
    }
    status.textContent = getVoicePeerStatusText(debug);
    status.className = `vc-peer-status state-${getVoicePeerStatusClass(debug)}`;
    status.title = getVoicePeerStatusTitle(debug);

    let icon = li.querySelector('.vc-muted-icon');
    if (muted) {
      if (!icon) {
        icon = document.createElement('span');
        icon.className = 'vc-muted-icon';
        icon.textContent = '🔇';
        li.append(icon);
      }
    } else {
      icon?.remove();
    }
  });
}

function updateAllVoicePeerUi() {
  const users = new Set([
    ...Object.values(latestVoiceRoomsState).flat(),
    ...voicePeerIds.values(),
  ]);
  users.forEach((username) => updateVoicePeerUi(username));
}

function summarizeSelectedCandidatePair(stats) {
  let selectedPair = null;
  for (const stat of stats.values()) {
    if (stat.type === 'transport' && stat.selectedCandidatePairId && stats.get(stat.selectedCandidatePairId)) {
      selectedPair = stats.get(stat.selectedCandidatePairId);
      break;
    }
  }
  if (!selectedPair) {
    for (const stat of stats.values()) {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) {
        selectedPair = stat;
        break;
      }
    }
  }
  if (!selectedPair) {
    for (const stat of stats.values()) {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
        selectedPair = stat;
        break;
      }
    }
  }
  if (!selectedPair) return null;

  const localCandidate = selectedPair.localCandidateId ? stats.get(selectedPair.localCandidateId) : null;
  const remoteCandidate = selectedPair.remoteCandidateId ? stats.get(selectedPair.remoteCandidateId) : null;
  const usesRelay = localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay';

  return {
    rttMs: selectedPair.currentRoundTripTime !== undefined
      ? selectedPair.currentRoundTripTime * 1000
      : null,
    path: usesRelay ? 'relay' : (localCandidate || remoteCandidate ? 'p2p' : 'unknown'),
    candidateTypes: [localCandidate?.candidateType, remoteCandidate?.candidateType]
      .filter(Boolean)
      .join('/'),
  };
}
let reconnectScreenTimer     = null;
let   speakingTimer   = null;
const SPEAKING_THR    = 12;        // 0-255 eşik

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];
const ICE = { iceServers: DEFAULT_ICE_SERVERS.map(cloneIceServer) };
let clientConfigPromise = null;

// ═══════════════ DOM ═══════════════
const $ = id => document.getElementById(id);

const loginScreen    = $('login-screen');
const loginCard      = loginScreen?.querySelector('.login-card');
const loginForm      = $('login-form');
const authSubtitle   = $('auth-subtitle');
const authLoginTab   = $('auth-login-tab');
const authRegisterTab= $('auth-register-tab');
const usernameField  = $('username-field');
const usernameInput  = $('username-input');
const emailField     = $('email-field');
const emailInput     = $('email-input');
const passwordField  = $('password-field');
const passwordInputLabel = $('password-input-label');
const passwordInput  = $('password-input');
const resetPasswordConfirmField = $('reset-password-confirm-field');
const resetPasswordConfirmInput = $('reset-password-confirm-input');
const inviteCodeField = $('invite-code-field');
const inviteCodeInput = $('invite-code-input');
const mfaCodeField = $('mfa-code-field');
const mfaCodeLabel = $('mfa-code-label');
const mfaCodeInput = $('mfa-code-input');
const mfaRecoveryField = $('mfa-recovery-field');
const mfaRecoveryInput = $('mfa-recovery-input');
const mfaEnrollPanel = $('mfa-enroll-panel');
const mfaQrWrap = $('mfa-qr-wrap');
const mfaSecretValue = $('mfa-secret-value');
const mfaSecretCopyBtn = $('mfa-secret-copy-btn');
const mfaRecoveryList = $('mfa-recovery-list');
const mfaRecoverySavedCheck = $('mfa-recovery-saved-check');
const mfaRecoveryCopyBtn = $('mfa-recovery-copy-btn');
const mfaVerifyHelper = $('mfa-verify-helper');
const mfaToggleRow = $('mfa-toggle-row');
const mfaUseRecoveryBtn = $('mfa-use-recovery-btn');
const mfaUseAppBtn = $('mfa-use-app-btn');
const mfaResendBtn = $('mfa-resend-btn');
const authHelperText = $('auth-helper-text');
const loginError     = $('login-error');
const forgotPasswordLink = $('forgot-password-link');
const authBackLink   = $('auth-back-link');
const appEl          = $('app');
const connectionBanner = $('connection-banner');
const emailReminderBanner = $('email-reminder-banner');
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
const logoutBtn      = $('logout-btn');
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
const screenVolume        = $('screen-volume');
const screenVolumeLabel   = $('screen-volume-label');
const qualityOverlay      = $('quality-modal-overlay');
const voiceControls  = $('voice-controls');
const vcMuteBtn      = $('vc-mute-btn');
const emojiPicker    = $('emoji-picker');
const settingsOverlay = $('settings-overlay');
const inputDeviceSelect = $('input-device-select');
const outputDeviceSelect = $('output-device-select');
const audioDeviceNote = $('audio-device-note');
const pttKeyBtn = $('ptt-key-btn');
const pttKeyDesc = $('ptt-key-desc');
const pttKeyNote = $('ptt-key-note');
const accountAvatarPreview = $('account-avatar-preview');
const accountDisplayNamePreview = $('account-display-name-preview');
const accountUsernamePreview = $('account-username-preview');
const accountPendingDeleteBanner = $('account-pending-delete-banner');
const accountUsernameInput = $('account-username-input');
const accountDisplayNameInput = $('account-display-name-input');
const accountDisplayNameSave = $('account-display-name-save');
const accountProfileFeedback = $('account-profile-feedback');
const accountPasswordForm = $('account-password-form');
const accountCurrentPasswordInput = $('account-current-password-input');
const accountNewPasswordInput = $('account-new-password-input');
const accountNewPasswordConfirmInput = $('account-new-password-confirm-input');
const accountPasswordFeedback = $('account-password-feedback');
const accountEmailValue = $('account-email-value');
const accountEmailStatus = $('account-email-status');
const accountEmailRefreshBtn = $('account-email-refresh-btn');
const accountEmailWarning = $('account-email-warning');
const accountEmailForm = $('account-email-form');
const accountEmailInput = $('account-email-input');
const accountEmailPasswordInput = $('account-email-password-input');
const accountEmailFeedback = $('account-email-feedback');
const account2faStatus = $('account-2fa-status');
const account2faDesc = $('account-2fa-desc');
const accountRecoveryForm = $('account-recovery-form');
const accountRecoveryPasswordInput = $('account-recovery-password-input');
const accountRecoveryResult = $('account-recovery-result');
const accountRecoveryCodes = $('account-recovery-codes');
const accountRecoveryCopyBtn = $('account-recovery-copy-btn');
const accountRecoveryFeedback = $('account-recovery-feedback');
const accountSessionsRefreshBtn = $('account-sessions-refresh-btn');
const accountLogoutAllBtn = $('account-logout-all-btn');
const accountSessionsEmpty = $('account-sessions-empty');
const accountSessionsList = $('account-sessions-list');
const accountSessionsFeedback = $('account-sessions-feedback');
const accountDeleteDetails = $('account-delete-details');
const accountDeleteForm = $('account-delete-form');
const accountDeletePasswordInput = $('account-delete-password-input');
const accountDeletePhraseInput = $('account-delete-phrase-input');
const accountDeleteFeedback = $('account-delete-feedback');
const accountAdminEntry = $('account-admin-entry');
const accountAdminOpenBtn = $('account-admin-open-btn');
const defaultConnectionBannerText = connectionBanner?.textContent || 'Bağlantı kesildi — yeniden bağlanılıyor...';
const adminAppEl = $('admin-app');
const adminUserDisplay = $('admin-user-display');
const adminUserRole = $('admin-user-role');
const adminLogoutBtn = $('admin-logout-btn');
const adminGlobalFeedback = $('admin-global-feedback');
const adminUsersPanel = $('admin-users-panel');
const adminInvitesPanel = $('admin-invites-panel');
const adminAuditPanel = $('admin-audit-panel');
const adminUsersRefreshBtn = $('admin-users-refresh-btn');
const adminUserSearch = $('admin-user-search');
const adminUserStatusFilter = $('admin-user-status-filter');
const adminUsersEmpty = $('admin-users-empty');
const adminUsersList = $('admin-users-list');
const adminInvitesRefreshBtn = $('admin-invites-refresh-btn');
const adminInviteForm = $('admin-invite-form');
const adminInviteLabel = $('admin-invite-label');
const adminInviteMaxUses = $('admin-invite-max-uses');
const adminInviteTtlHours = $('admin-invite-ttl-hours');
const adminInviteCreateBtn = $('admin-invite-create-btn');
const adminInviteResult = $('admin-invite-result');
const adminInviteCodeValue = $('admin-invite-code-value');
const adminInviteCopyBtn = $('admin-invite-copy-btn');
const adminInvitesEmpty = $('admin-invites-empty');
const adminInvitesList = $('admin-invites-list');
const adminAuditRefreshBtn = $('admin-audit-refresh-btn');
const adminAuditEvent = $('admin-audit-event');
const adminAuditActor = $('admin-audit-actor');
const adminAuditSince = $('admin-audit-since');
const adminAuditUntil = $('admin-audit-until');
const adminAuditLimit = $('admin-audit-limit');
const adminAuditEmpty = $('admin-audit-empty');
const adminAuditList = $('admin-audit-list');
const isElectronApp = navigator.userAgent.toLowerCase().includes('electron');
const electronAPI = globalThis.electronAPI || null;
const voiceSettings = globalThis.SesAppVoiceSettings || null;

const clientSessionId = (() => {
  const key = 'sesappSessionId';
  let id = localStorage.getItem(key);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
})();

const authRoutePath = window.location.pathname.replace(/\/+$/, '') || '/';
const isResetPasswordRoute = authRoutePath === '/reset-password';
const isConfirmEmailRoute = authRoutePath === '/confirm-email';
const isAdminRoute = authRoutePath === '/admin';
const authRouteParams = new URLSearchParams(window.location.search);

// ═══════════════ YARDIMCI FONKSİYONLAR ═══════════════
function usernameToHue(u) {
  let h = 0;
  for (const c of u) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return Math.abs(h) % 360;
}
function avatarColor(u) { return `hsl(${usernameToHue(u)},65%,55%)`; }

function setAuthMode(mode) {
  if (mode === 'register' && !registrationEnabled) mode = 'login';
  if (!['login', 'register', 'forgot', 'reset', 'mfa-enroll', 'mfa-verify', 'mfa-recovery'].includes(mode)) mode = 'login';
  authMode = mode;

  const isRegister = authMode === 'register';
  const isForgot = authMode === 'forgot';
  const isReset = authMode === 'reset';
  const isLogin = authMode === 'login';
  const isMfaEnroll = authMode === 'mfa-enroll';
  const isMfaVerify = authMode === 'mfa-verify';
  const isMfaRecovery = authMode === 'mfa-recovery';
  const isMfa = isMfaEnroll || isMfaVerify || isMfaRecovery;
  const isEmailMfa = currentPendingAuthChallenge?.step === 'email';

  loginCard?.classList.toggle('is-mfa', isMfa);

  authLoginTab?.classList.toggle('active', isLogin);
  authRegisterTab?.classList.toggle('active', isRegister);
  $('auth-mode-tabs')?.classList.toggle('hidden', isForgot || isReset || isMfa);
  usernameField?.classList.toggle('hidden', isForgot || isReset || isMfa);
  emailField?.classList.toggle('hidden', !(isRegister || isForgot));
  passwordField?.classList.toggle('hidden', isForgot || isMfa);
  resetPasswordConfirmField?.classList.toggle('hidden', !isReset);
  inviteCodeField?.classList.toggle('hidden', !isRegister);
  mfaCodeField?.classList.toggle('hidden', !(isMfaEnroll || isMfaVerify));
  mfaRecoveryField?.classList.toggle('hidden', !isMfaRecovery);
  mfaEnrollPanel?.classList.toggle('hidden', !isMfaEnroll);
  mfaVerifyHelper?.classList.toggle('hidden', !isMfa);
  mfaToggleRow?.classList.toggle('hidden', !(isMfaVerify || isMfaRecovery));
  mfaUseRecoveryBtn?.classList.toggle('hidden', !isMfaVerify || isEmailMfa);
  mfaUseAppBtn?.classList.toggle('hidden', !isMfaRecovery);
  mfaResendBtn?.classList.toggle('hidden', !(isMfaVerify && isEmailMfa));
  forgotPasswordLink?.classList.toggle('hidden', !isLogin);
  authBackLink?.classList.toggle('hidden', isLogin || isRegister);

  if (authSubtitle) {
    authSubtitle.textContent = isRegister
      ? 'Yeni hesabını oluştur ve kendi şifrenle giriş yap'
      : isForgot
        ? 'Sifirlama baglantisi e-postana gonderilsin'
        : isReset
          ? 'Yeni sifreni belirle ve tekrar giris yap'
          : isMfaEnroll
            ? 'Iki adimli dogrulama kurulumu gerekiyor'
          : isMfaRecovery
              ? 'Kurtarma koduyla giris yap'
              : isMfaVerify
                ? (isEmailMfa ? 'E-postana gelen kodu gir' : 'Authenticator uygulamandaki kodu gir')
          : 'Hesabınla giriş yap ve kaldığın yerden devam et';
  }
  if (authHelperText) {
    authHelperText.textContent = isRegister
      ? 'Kayıt için sunucu davet kodu gerekir. E-postani dogrulayinca sifreni de kurtarabilirsin.'
      : isForgot
        ? 'Dogrulanmis bir e-posta varsa sifirlama linki gonderilir.'
        : isReset
          ? 'Yeni sifren en az 8 karakter olmali.'
          : isMfaEnroll
            ? 'QR kodu tarayip authenticator uygulamandaki 6 haneli kodu asagidan dogrula. Bu ekran e-posta kodu beklemez.'
            : isMfaRecovery
              ? 'Authenticator uygulamana erisemiyorsan tek kullanimlik kurtarma kodunu gir.'
              : isMfaVerify
                ? (isEmailMfa
                    ? `E-postana gelen 6 haneli kodu gir.${currentPendingAuthChallenge?.emailHint ? ` Kod ${currentPendingAuthChallenge.emailHint} adresine gonderildi.` : ''}`
                    : 'Authenticator kodu 30 saniyede bir yenilenir. Gerekirse kurtarma koduna gecebilirsin.')
          : 'Kayıt olurken seçtiğin kullanıcı adı ve şifreyle giriş yap.';
  }
  if (mfaCodeLabel) {
    mfaCodeLabel.textContent = isMfaVerify && isEmailMfa
      ? 'E-posta Kodu'
      : isMfaEnroll || isMfaVerify
        ? 'Authenticator Kodu'
        : 'Doğrulama Kodu';
  }
  if (passwordInput && passwordInputLabel) {
    passwordInput.autocomplete = isRegister ? 'new-password' : 'current-password';
    passwordInputLabel.textContent = isReset ? 'Yeni Şifre' : 'Şifre';
    passwordInput.autocomplete = isRegister || isReset ? 'new-password' : 'current-password';
    passwordInput.placeholder = isRegister || isReset ? 'kendine bir şifre belirle...' : 'şifreni gir...';
  }
  if (inviteCodeInput && !isRegister) inviteCodeInput.value = '';
  if (resetPasswordConfirmInput && !isReset) resetPasswordConfirmInput.value = '';
  if (emailInput && !isRegister && !isForgot) emailInput.value = '';
  if (mfaCodeInput && !isMfaEnroll && !isMfaVerify) mfaCodeInput.value = '';
  if (mfaRecoveryInput && !isMfaRecovery) mfaRecoveryInput.value = '';
  $('join-btn').textContent = isRegister
    ? 'Hesap Oluştur'
    : isForgot
      ? 'Sifirlama Linki Gonder'
      : isReset
        ? 'Sifreyi Yenile'
        : isMfaEnroll
          ? 'Kurulumu Tamamla'
          : isMfaRecovery
            ? 'Kurtarma Koduyla Gir'
            : isMfaVerify
              ? 'Dogrula'
        : 'Giriş Yap';
  updatePendingAuthUi();
}

function setLoginStatus(message = '', type = 'error') {
  if (!loginError) return;
  loginError.textContent = message;
  loginError.classList.toggle('success', type === 'success');
}

function setLoginBusy(isBusy) {
  isLoginBusy = isBusy;
  const joinBtn = $('join-btn');
  if (joinBtn) joinBtn.disabled = isBusy;
  usernameInput.disabled = isBusy;
  if (emailInput) emailInput.disabled = isBusy;
  passwordInput.disabled = isBusy;
  if (resetPasswordConfirmInput) resetPasswordConfirmInput.disabled = isBusy;
  if (inviteCodeInput) inviteCodeInput.disabled = isBusy;
  if (mfaCodeInput) mfaCodeInput.disabled = isBusy;
  if (mfaRecoveryInput) mfaRecoveryInput.disabled = isBusy;
  if (mfaRecoverySavedCheck) mfaRecoverySavedCheck.disabled = isBusy;
  if (mfaSecretCopyBtn) mfaSecretCopyBtn.disabled = isBusy;
  if (mfaRecoveryCopyBtn) mfaRecoveryCopyBtn.disabled = isBusy;
  if (mfaUseRecoveryBtn) mfaUseRecoveryBtn.disabled = isBusy;
  if (mfaUseAppBtn) mfaUseAppBtn.disabled = isBusy;
  if (authBackLink) authBackLink.disabled = isBusy;
  updatePendingAuthUi();
}

function clearPendingAuthChallenge() {
  currentPendingAuthChallenge = null;
  if (mfaQrWrap) mfaQrWrap.innerHTML = '';
  if (mfaSecretValue) mfaSecretValue.textContent = '—';
  if (mfaRecoveryList) mfaRecoveryList.innerHTML = '';
  if (mfaRecoverySavedCheck) mfaRecoverySavedCheck.checked = false;
  if (mfaCodeInput) mfaCodeInput.value = '';
  if (mfaRecoveryInput) mfaRecoveryInput.value = '';
}

function renderRecoveryCodeGrid(container, codes = []) {
  if (!container) return;
  container.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const code of codes) {
    const item = document.createElement('div');
    item.className = 'mfa-recovery-item';
    item.textContent = code;
    fragment.append(item);
  }
  container.append(fragment);
}

function updatePendingAuthUi() {
  const joinBtn = $('join-btn');
  const challenge = currentPendingAuthChallenge;
  const isEmailMfa = challenge?.step === 'email';
  if (mfaQrWrap && authMode === 'mfa-enroll') {
    mfaQrWrap.innerHTML = challenge?.qrSvg || '';
  }
  if (mfaSecretValue && authMode === 'mfa-enroll') {
    mfaSecretValue.textContent = challenge?.secretB32 || '—';
  }
  if (mfaRecoveryList && authMode === 'mfa-enroll') {
    renderRecoveryCodeGrid(mfaRecoveryList, challenge?.recoveryCodes || []);
  }
  if (mfaVerifyHelper) {
    mfaVerifyHelper.textContent = authMode === 'mfa-recovery'
      ? 'Kaydettigin tek kullanimlik kurtarma kodunu gir.'
      : authMode === 'mfa-enroll'
        ? 'Authenticator uygulamandaki ilk 6 haneli kodu girerek kurulumu tamamla. E-postaya kod gelmez.'
        : isEmailMfa
          ? `E-postana gelen 6 haneli kodu gir.${challenge?.emailHint ? ` Kod ${challenge.emailHint} adresine gonderildi.` : ''}`
          : 'Authenticator uygulamandaki 6 haneli kodu gir. Uygulamaya erisemiyorsan kurtarma kodunu kullan.';
  }
  if (!joinBtn) return;
  if (authMode === 'mfa-enroll') {
    joinBtn.disabled = isLoginBusy || !challenge?.token || !challenge?.secretB32 || !mfaRecoverySavedCheck?.checked;
  } else if (authMode === 'mfa-verify') {
    joinBtn.disabled = isLoginBusy || !challenge?.token;
  } else if (authMode === 'mfa-recovery') {
    joinBtn.disabled = isLoginBusy || !challenge?.token;
  }
}

function extractPendingAuthChallenge(payload = {}) {
  const pendingToken = typeof payload.pending_token === 'string' ? payload.pending_token : '';
  if (!pendingToken) return null;
  const requires = Array.isArray(payload.requires) ? payload.requires : [];
  const requirement = requires[0] || '';
  if (requirement === 'totp_enroll') return { token: pendingToken, step: 'enroll', user: payload.user || null };
  if (requirement === 'totp_verify') return { token: pendingToken, step: 'verify', user: payload.user || null };
  if (requirement === 'totp_recovery') return { token: pendingToken, step: 'recovery', user: payload.user || null };
  if (requirement === 'email_code') {
    return {
      token: pendingToken,
      step: 'email',
      delivery: payload.delivery || 'email',
      emailHint: payload.email_hint || '',
      user: payload.user || null,
    };
  }
  return null;
}

async function requestPendingJson(url, { method = 'POST', body } = {}) {
  if (!currentPendingAuthChallenge?.token) {
    throw new Error('Dogrulama oturumu bulunamadi. Tekrar giris yap.');
  }
  return requestJson(url, {
    method,
    body,
    headers: { Authorization: `Bearer ${currentPendingAuthChallenge.token}` },
    authorize: false,
    retryAuth: false,
  });
}

async function beginPendingAuthFlow(payload = {}) {
  const pending = extractPendingAuthChallenge(payload);
  if (!pending) return false;

  currentPendingAuthChallenge = pending;

  if (pending.step === 'enroll') {
    const enrollPayload = await requestPendingJson('/api/auth/2fa/enroll');
    currentPendingAuthChallenge = {
      ...currentPendingAuthChallenge,
      secretB32: enrollPayload.secret_b32,
      otpauthUrl: enrollPayload.otpauth_url,
      qrSvg: enrollPayload.qr_svg,
      recoveryCodes: enrollPayload.recovery_codes || [],
    };
    if (mfaRecoverySavedCheck) mfaRecoverySavedCheck.checked = false;
    setAuthMode('mfa-enroll');
  } else if (pending.step === 'recovery') {
    setAuthMode('mfa-recovery');
  } else if (pending.step === 'email') {
    setAuthMode('mfa-verify');
  } else {
    setAuthMode('mfa-verify');
  }

  if (payload?.warning) {
    setLoginStatus(payload.warning, 'error');
  } else {
    setLoginStatus('', 'error');
  }
  updatePendingAuthUi();
  return true;
}

function formatRecoveryCodes(codes = []) {
  return codes.filter(Boolean).join('\n');
}

async function copyPlainText(value, successMessage, failureMessage = 'Kopyalama başarısız oldu.') {
  try {
    await navigator.clipboard.writeText(value);
    setLoginStatus(successMessage, 'success');
    return true;
  } catch {
    setLoginStatus(failureMessage, 'error');
    return false;
  }
}

function getStoredAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

function getStoredRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY) || '';
}

function clearStoredAuth() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

function storeRefreshToken(token) {
  if (token) localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

function extractSessionTokens(payload = {}) {
  return {
    accessToken: payload.access_token || payload.token || null,
    refreshToken: payload.refresh_token ?? null,
  };
}

function applySessionTokens({ accessToken = null, refreshToken, clearLegacyAccess = false } = {}) {
  if (accessToken) currentAuthToken = accessToken;
  if (refreshToken !== undefined) {
    currentRefreshToken = refreshToken || null;
    if (currentRefreshToken) storeRefreshToken(currentRefreshToken);
    else localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
  if (clearLegacyAccess) localStorage.removeItem(AUTH_TOKEN_KEY);
}

const FATAL_AUTH_ERROR_CODES = new Set([
  'invalid_session',
  'revoked_session',
  'missing_account',
  'stale_token',
  'account_disabled',
  'account_locked',
  'refresh_reuse_detected',
  'stale_session',
  'account_unavailable',
]);

function isFatalAuthErrorCode(code) {
  return FATAL_AUTH_ERROR_CODES.has(code);
}

function getAuthHeaders(extra = {}) {
  const headers = new Headers(extra);
  if (currentAuthToken) headers.set('Authorization', `Bearer ${currentAuthToken}`);
  return headers;
}

function applyCurrentUserProfile(user) {
  currentUserProfile = user ? { ...user } : null;
  currentUser = currentUserProfile?.username || null;

  const displayName = currentUserProfile?.displayName || currentUser || '—';
  const usernameLabel = currentUser ? `@${currentUser}` : '@—';

  if (selfAvatar) {
    selfAvatar.textContent = displayName[0]?.toUpperCase?.() || '?';
    selfAvatar.style.background = avatarColor(currentUser || displayName);
  }
  if (selfUsername) selfUsername.textContent = displayName;

  if (accountAvatarPreview) {
    accountAvatarPreview.textContent = displayName[0]?.toUpperCase?.() || '?';
    accountAvatarPreview.style.background = avatarColor(currentUser || displayName);
  }
  if (accountDisplayNamePreview) accountDisplayNamePreview.textContent = displayName;
  if (accountUsernamePreview) accountUsernamePreview.textContent = usernameLabel;
  if (accountUsernameInput) accountUsernameInput.value = currentUser || '';
  if (accountDisplayNameInput && document.activeElement !== accountDisplayNameInput) {
    accountDisplayNameInput.value = currentUserProfile?.displayName || currentUser || '';
  }
  if (accountEmailValue) {
    accountEmailValue.textContent = currentUserProfile?.email || 'Henüz eklenmedi';
  }
  if (accountEmailStatus) {
    if (currentUserProfile?.emailPending) {
      accountEmailStatus.textContent = `Bekleyen değişiklik: ${currentUserProfile.emailPending}`;
    } else if (currentUserProfile?.email) {
      accountEmailStatus.textContent = currentUserProfile.emailVerifiedAt
        ? 'E-posta doğrulanmış.'
        : 'E-posta kayitli ama henuz dogrulanmamis.';
    } else {
      accountEmailStatus.textContent = 'Sifremi unuttum akisi icin dogrulanmis e-posta eklemelisin.';
    }
  }
  if (accountEmailInput && document.activeElement !== accountEmailInput) {
    accountEmailInput.value = currentUserProfile?.emailPending || currentUserProfile?.email || '';
  }
  if (accountEmailWarning) {
    accountEmailWarning.classList.toggle('hidden', Boolean(currentUserProfile?.email || currentUserProfile?.emailPending));
  }
  if (accountPendingDeleteBanner) {
    accountPendingDeleteBanner.classList.toggle('hidden', !currentUserProfile?.pendingDeleteAt);
  }
  if (emailReminderBanner) {
    emailReminderBanner.classList.toggle('hidden', Boolean(currentUserProfile?.email || currentUserProfile?.emailPending) || !currentUser);
  }
  if (account2faStatus) {
    account2faStatus.textContent = currentUserProfile?.mfaMethod === 'email'
      ? (currentUserProfile?.mfaEnabledAt ? 'E-posta Kodu Aktif' : 'E-posta Bekleniyor')
      : (currentUserProfile?.totpEnabledAt ? 'Aktif' : 'Kurulum Bekliyor');
  }
  if (account2faDesc) {
    account2faDesc.textContent = currentUserProfile?.mfaMethod === 'email'
      ? 'Giris yaparken dogrulama kodu e-postana gonderilir.'
      : (currentUserProfile?.totpEnabledAt
          ? 'Authenticator uygulaman ve kurtarma kodların hesabını korur.'
          : 'Bu hesap tekrar girişte authenticator kurulumu isteyecek.');
  }
  updateAdminAccessUi();
}

function setSettingsFeedback(el, message = '', type = '') {
  if (!el) return;
  el.textContent = message;
  el.classList.remove('success', 'error');
  if (type) el.classList.add(type);
}

function clearAccountFeedback() {
  setSettingsFeedback(accountProfileFeedback);
  setSettingsFeedback(accountPasswordFeedback);
  setSettingsFeedback(accountEmailFeedback);
  setSettingsFeedback(accountRecoveryFeedback);
  setSettingsFeedback(accountSessionsFeedback);
  setSettingsFeedback(accountDeleteFeedback);
}

function formatSettingsDate(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function setAdminFeedback(message = '', type = '') {
  if (!adminGlobalFeedback) return;
  adminGlobalFeedback.textContent = message;
  adminGlobalFeedback.classList.remove('hidden', 'success', 'error');
  if (!message) {
    adminGlobalFeedback.classList.add('hidden');
    return;
  }
  if (type) adminGlobalFeedback.classList.add(type);
}

function parseDateTimeLocalValue(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function updateAdminAccessUi() {
  const isAdmin = currentUserProfile?.role === 'admin';
  if (accountAdminEntry) accountAdminEntry.classList.toggle('hidden', !isAdmin);
  if (adminUserDisplay) {
    adminUserDisplay.textContent = currentUserProfile?.displayName || currentUserProfile?.username || '—';
  }
  if (adminUserRole) {
    adminUserRole.textContent = isAdmin ? 'admin' : (currentUserProfile?.role || 'user');
  }
}

function ensureAdminRouteAccess() {
  if (!isAdminRoute) return true;
  if (currentUserProfile?.role === 'admin') return true;
  sessionStorage.setItem('sesappLoginError', 'Bu alana erişmek için yönetici olman gerekiyor.');
  window.location.replace('/');
  return false;
}

function showAdminShell() {
  if (!adminAppEl) return;
  loginScreen.style.display = 'none';
  appEl.classList.add('hidden');
  adminAppEl.classList.remove('hidden');
  updateAdminAccessUi();
}

function hideAdminShell() {
  if (!adminAppEl) return;
  adminAppEl.classList.add('hidden');
}

function setAdminTab(tab) {
  currentAdminTab = ['users', 'invites', 'audit'].includes(tab) ? tab : 'users';
  document.querySelectorAll('.admin-tab-btn[data-admin-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.adminTab === currentAdminTab);
  });
  adminUsersPanel?.classList.toggle('hidden', currentAdminTab !== 'users');
  adminInvitesPanel?.classList.toggle('hidden', currentAdminTab !== 'invites');
  adminAuditPanel?.classList.toggle('hidden', currentAdminTab !== 'audit');
}

function renderAdminUsers(items = []) {
  if (!adminUsersList || !adminUsersEmpty) return;
  adminUsersList.innerHTML = '';
  adminUsersEmpty.classList.toggle('hidden', items.length > 0);

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'admin-card';
    card.dataset.username = item.username;

    const head = document.createElement('div');
    head.className = 'admin-card-head';

    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'admin-card-title';
    title.textContent = item.display_name || item.username;
    const subtitle = document.createElement('div');
    subtitle.className = 'admin-card-subtitle';
    subtitle.textContent = `@${item.username}${item.email ? ` • ${item.email}` : ''}`;
    titleWrap.append(title, subtitle);

    const badges = document.createElement('div');
    badges.className = 'admin-card-meta';
    const roleBadge = document.createElement('span');
    roleBadge.className = `admin-badge ${item.role === 'admin' ? 'admin' : ''}`.trim();
    roleBadge.textContent = item.role === 'admin' ? 'Admin' : 'User';
    badges.append(roleBadge);
    if (item.disabled_at) {
      const disabledBadge = document.createElement('span');
      disabledBadge.className = 'admin-badge disabled';
      disabledBadge.textContent = 'Devre dışı';
      badges.append(disabledBadge);
    }
    if (item.pending_delete_at) {
      const pendingBadge = document.createElement('span');
      pendingBadge.className = 'admin-badge pending';
      pendingBadge.textContent = 'Silinmeyi bekliyor';
      badges.append(pendingBadge);
    }
    const mfaBadge = document.createElement('span');
    mfaBadge.className = `admin-badge ${item.totp_enabled_at ? 'mfa' : 'pending'}`.trim();
    mfaBadge.textContent = item.totp_enabled_at ? '2FA aktif' : '2FA bekliyor';
    badges.append(mfaBadge);

    head.append(titleWrap, badges);

    const facts = document.createElement('div');
    facts.className = 'admin-card-facts';
    const created = document.createElement('div');
    created.textContent = `Açılış: ${formatSettingsDate(item.created_at)}`;
    const lastLogin = document.createElement('div');
    lastLogin.textContent = `Son giriş: ${formatSettingsDate(item.last_login_at)}`;
    facts.append(created, lastLogin);

    const actions = document.createElement('div');
    actions.className = 'admin-card-actions';

    const toggleDisableBtn = document.createElement('button');
    toggleDisableBtn.type = 'button';
    toggleDisableBtn.className = item.disabled_at ? 'admin-secondary-btn' : 'admin-danger-btn';
    toggleDisableBtn.dataset.action = item.disabled_at ? 'enable' : 'disable';
    toggleDisableBtn.dataset.username = item.username;
    toggleDisableBtn.textContent = item.disabled_at ? 'Aktif Et' : 'Devre Dışı Bırak';

    const toggleRoleBtn = document.createElement('button');
    toggleRoleBtn.type = 'button';
    toggleRoleBtn.className = 'admin-secondary-btn';
    toggleRoleBtn.dataset.action = 'role';
    toggleRoleBtn.dataset.username = item.username;
    toggleRoleBtn.dataset.role = item.role === 'admin' ? 'user' : 'admin';
    toggleRoleBtn.textContent = item.role === 'admin' ? 'User Yap' : 'Admin Yap';

    const logoutAllBtn = document.createElement('button');
    logoutAllBtn.type = 'button';
    logoutAllBtn.className = 'admin-secondary-btn';
    logoutAllBtn.dataset.action = 'logout-all';
    logoutAllBtn.dataset.username = item.username;
    logoutAllBtn.textContent = 'Tüm Oturumları Kapat';

    const emailBtn = document.createElement('button');
    emailBtn.type = 'button';
    emailBtn.className = 'admin-secondary-btn';
    emailBtn.dataset.action = 'email-set';
    emailBtn.dataset.username = item.username;
    emailBtn.textContent = 'E-posta Ata';

    const totpResetBtn = document.createElement('button');
    totpResetBtn.type = 'button';
    totpResetBtn.className = 'admin-secondary-btn';
    totpResetBtn.dataset.action = 'totp-reset';
    totpResetBtn.dataset.username = item.username;
    totpResetBtn.textContent = '2FA Sıfırla';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'admin-danger-btn';
    deleteBtn.dataset.action = 'delete';
    deleteBtn.dataset.username = item.username;
    deleteBtn.textContent = 'Silme Başlat';

    actions.append(toggleDisableBtn, toggleRoleBtn, logoutAllBtn, emailBtn, totpResetBtn, deleteBtn);
    card.append(head, facts, actions);
    adminUsersList.append(card);
  }
}

function renderAdminInvites(items = []) {
  if (!adminInvitesList || !adminInvitesEmpty) return;
  adminInvitesList.innerHTML = '';
  adminInvitesEmpty.classList.toggle('hidden', items.length > 0);

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'admin-card';
    card.dataset.inviteId = item.id;

    const head = document.createElement('div');
    head.className = 'admin-card-head';

    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'admin-card-title';
    title.textContent = item.label || 'Adsız davet';
    const subtitle = document.createElement('div');
    subtitle.className = 'admin-card-subtitle';
    subtitle.textContent = `Oluşturan: @${item.created_by}`;
    titleWrap.append(title, subtitle);

    const badges = document.createElement('div');
    badges.className = 'admin-card-meta';
    const usageBadge = document.createElement('span');
    usageBadge.className = 'admin-badge';
    usageBadge.textContent = `${item.uses_remaining}/${item.max_uses} kullanım kaldı`;
    badges.append(usageBadge);
    if (item.revoked_at) {
      const revokedBadge = document.createElement('span');
      revokedBadge.className = 'admin-badge disabled';
      revokedBadge.textContent = 'İptal edildi';
      badges.append(revokedBadge);
    } else if (item.expires_at && item.expires_at <= Date.now()) {
      const expiredBadge = document.createElement('span');
      expiredBadge.className = 'admin-badge pending';
      expiredBadge.textContent = 'Süresi doldu';
      badges.append(expiredBadge);
    }

    head.append(titleWrap, badges);

    const facts = document.createElement('div');
    facts.className = 'admin-card-facts';
    const created = document.createElement('div');
    created.textContent = `Oluşturuldu: ${formatSettingsDate(item.created_at)}`;
    const expires = document.createElement('div');
    expires.textContent = `Bitiş: ${item.expires_at ? formatSettingsDate(item.expires_at) : 'Süresiz'}`;
    facts.append(created, expires);

    card.append(head, facts);

    const canRevoke = !item.revoked_at && item.uses_remaining > 0;
    if (canRevoke) {
      const actions = document.createElement('div');
      actions.className = 'admin-card-actions';
      const revokeBtn = document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.className = 'admin-danger-btn';
      revokeBtn.dataset.action = 'revoke';
      revokeBtn.dataset.inviteId = item.id;
      revokeBtn.textContent = 'İptal Et';
      actions.append(revokeBtn);
      card.append(actions);
    }

    adminInvitesList.append(card);
  }
}

function renderAdminAudit(items = []) {
  if (!adminAuditList || !adminAuditEmpty) return;
  adminAuditList.innerHTML = '';
  adminAuditEmpty.classList.toggle('hidden', items.length > 0);

  for (const item of items) {
    const row = document.createElement('article');
    row.className = 'admin-audit-item';

    const top = document.createElement('div');
    top.className = 'admin-audit-top';

    const event = document.createElement('div');
    event.className = 'admin-audit-event';
    event.textContent = item.event || 'unknown_event';

    const time = document.createElement('div');
    time.className = 'admin-audit-time';
    time.textContent = formatSettingsDate(item.ts);

    top.append(event, time);

    const meta = document.createElement('div');
    meta.className = 'admin-audit-meta';
    meta.textContent = [
      `Actor: ${item.actor_username || '—'}`,
      `Target: ${item.target_username || '—'}`,
      `IP: ${item.ip || '—'}`,
    ].join(' • ');

    row.append(top, meta);

    if (item.metadata_json) {
      const json = document.createElement('pre');
      json.className = 'admin-audit-json';
      json.textContent = item.metadata_json;
      row.append(json);
    }

    adminAuditList.append(row);
  }
}

async function loadAdminUsers({ silent = false } = {}) {
  const search = adminUserSearch?.value?.trim() || '';
  const disabled = adminUserStatusFilter?.value || '';
  const params = new URLSearchParams();
  if (search) params.set('q', search);
  if (disabled) params.set('disabled', disabled);
  const payload = await authorizedFetchJson(`/api/admin/users?${params.toString()}`);
  renderAdminUsers(payload.items || []);
  if (!silent) setAdminFeedback('Kullanıcı listesi güncellendi.', 'success');
  return payload.items || [];
}

async function loadAdminInvites({ silent = false } = {}) {
  const payload = await authorizedFetchJson('/api/admin/invites');
  renderAdminInvites(payload.items || []);
  if (!silent) setAdminFeedback('Davet listesi güncellendi.', 'success');
  return payload.items || [];
}

async function loadAdminAudit({ silent = false } = {}) {
  const params = new URLSearchParams();
  const event = adminAuditEvent?.value?.trim() || '';
  const actor = adminAuditActor?.value?.trim() || '';
  const since = parseDateTimeLocalValue(adminAuditSince?.value || '');
  const until = parseDateTimeLocalValue(adminAuditUntil?.value || '');
  const limit = Math.min(Math.max(Number(adminAuditLimit?.value) || 100, 1), 500);
  if (event) params.set('event', event);
  if (actor) params.set('actor', actor);
  if (Number.isFinite(since)) params.set('since', String(since));
  if (Number.isFinite(until)) params.set('until', String(until));
  params.set('limit', String(limit));
  const payload = await authorizedFetchJson(`/api/admin/audit-log?${params.toString()}`);
  renderAdminAudit(payload.items || []);
  if (!silent) setAdminFeedback('Audit kayıtları güncellendi.', 'success');
  return payload.items || [];
}

async function loadAdminRouteData() {
  await Promise.all([
    loadAdminUsers({ silent: true }),
    loadAdminInvites({ silent: true }),
    loadAdminAudit({ silent: true }),
  ]);
}

function renderAccountSessions(items = []) {
  if (!accountSessionsList || !accountSessionsEmpty) return;
  accountSessionsList.innerHTML = '';
  accountSessionsEmpty.classList.toggle('hidden', items.length > 0);

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'settings-session-item';

    const main = document.createElement('div');
    main.className = 'settings-session-main';

    const device = document.createElement('div');
    device.className = 'settings-session-device';
    device.textContent = item.device_label || 'Bilinmeyen cihaz';
    if (item.is_current) {
      const badge = document.createElement('span');
      badge.className = 'settings-session-badge';
      badge.textContent = 'Bu cihaz';
      device.append(' ', badge);
    }

    const meta = document.createElement('div');
    meta.className = 'settings-session-meta';
    meta.textContent = `IP: ${item.ip || 'bilinmiyor'} • Açılış: ${formatSettingsDate(item.created_at)} • Son kullanım: ${formatSettingsDate(item.last_used_at)}`;

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'settings-danger-btn';
    actionBtn.textContent = item.is_current ? 'Bu Cihazdan Çık' : 'Oturumu Kapat';
    actionBtn.dataset.sessionId = item.id;
    actionBtn.dataset.isCurrent = item.is_current ? 'true' : 'false';

    main.append(device, meta);
    li.append(main, actionBtn);
    accountSessionsList.append(li);
  }
}

function handleAuthFailure(message) {
  currentUserProfile = null;
  currentAuthToken = null;
  currentRefreshToken = null;
  clearPendingAuthChallenge();
  clearStoredAuth();
  sessionStorage.setItem('sesappLoginError', message || 'Oturumun geçersiz. Tekrar giriş yap.');
  window.location.reload();
}

async function refreshAccessToken() {
  if (refreshSessionPromise) return refreshSessionPromise;

  const refreshToken = currentRefreshToken || getStoredRefreshToken();
  if (!refreshToken) return { ok: false, message: 'Oturum yenilenemedi.' };

  refreshSessionPromise = fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  }).then(async (response) => {
    let payload = {};
    try {
      payload = await response.json();
    } catch {}

    if (!response.ok) {
      currentAuthToken = null;
      currentRefreshToken = null;
      clearStoredAuth();
      return { ok: false, message: payload?.error || 'Oturum yenilenemedi.' };
    }

    const nextTokens = extractSessionTokens(payload);
    if (!nextTokens.accessToken || !nextTokens.refreshToken) {
      currentAuthToken = null;
      currentRefreshToken = null;
      clearStoredAuth();
      return { ok: false, message: 'Sunucu eksik oturum verisi döndürdü.' };
    }

    applySessionTokens({
      accessToken: nextTokens.accessToken,
      refreshToken: nextTokens.refreshToken,
      clearLegacyAccess: true,
    });

    if (socket) {
      try {
        socket.emit('session_refresh', { token: currentAuthToken });
      } catch {}
    }

    return { ok: true, payload };
  }).finally(() => {
    refreshSessionPromise = null;
  });

  return refreshSessionPromise;
}

async function requestJson(url, {
  method = 'GET',
  body,
  headers = {},
  authorize = true,
  retryAuth = authorize,
} = {}) {
  const requestHeaders = authorize ? getAuthHeaders(headers) : new Headers(headers);
  if (body !== undefined && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {}

  if (!response.ok) {
    const authFailureCodes = [
      'invalid_session',
      'revoked_session',
      'missing_account',
      'stale_token',
      'expired_token',
      'revoked_token',
      'account_disabled',
      'account_locked',
    ];

    if (authorize && retryAuth && response.status === 401 && (currentRefreshToken || getStoredRefreshToken()) && url !== '/api/auth/refresh') {
      const refreshed = await refreshAccessToken();
      if (refreshed.ok) {
        return requestJson(url, {
          method,
          body,
          headers,
          authorize,
          retryAuth: false,
        });
      }
    }

    if (authorize && authFailureCodes.includes(payload?.code)) {
      handleAuthFailure(payload?.error);
    }
    throw new Error(payload?.error || 'İşlem tamamlanamadı.');
  }

  return payload;
}

async function postJson(url, body, options = {}) {
  return requestJson(url, {
    method: 'POST',
    body,
    authorize: options.authorize ?? true,
    retryAuth: options.retryAuth ?? (options.authorize ?? true),
  });
}

async function authorizedFetchJson(url, options = {}) {
  return requestJson(url, {
    method: options.method || 'GET',
    body: options.body,
    headers: options.headers || {},
    authorize: true,
    retryAuth: options.retryAuth ?? true,
  });
}

async function refreshCurrentAccountState() {
  const payload = await authorizedFetchJson('/api/auth/me');
  applyCurrentUserProfile(payload.user);
  return payload.user;
}

async function loadAccountSessions({ silent = false } = {}) {
  try {
    const payload = await authorizedFetchJson('/api/auth/sessions');
    renderAccountSessions(payload.items || []);
    if (!silent) setSettingsFeedback(accountSessionsFeedback, 'Oturum listesi güncellendi.', 'success');
  } catch (err) {
    setSettingsFeedback(accountSessionsFeedback, err.message || 'Oturumlar yüklenemedi.', 'error');
  }
}

function applyRegistrationAvailability() {
  if (authRegisterTab) authRegisterTab.classList.toggle('hidden', !registrationEnabled);
  if (!registrationEnabled && authMode === 'register') setAuthMode('login');
  if (!registrationEnabled && authMode === 'login' && authHelperText) {
    authHelperText.textContent = 'Yeni hesap kaydı şu anda kapalıysa mevcut hesabınla giriş yapmalısın.';
  }
}

async function loadAuthenticatedBootstrap({ adminOnly = false } = {}) {
  const requests = adminOnly
    ? [
        authorizedFetchJson('/api/auth/me'),
        Promise.resolve(null),
        loadClientConfig(),
      ]
    : [
        authorizedFetchJson('/api/auth/me'),
        authorizedFetchJson('/api/channels'),
        loadClientConfig(),
      ];
  const [authPayload, channels] = await Promise.all(requests);
  applyCurrentUserProfile(authPayload.user);
  if (adminOnly) return authPayload.user;
  currentChannels = channels;
  const savedChannelId = Number(localStorage.getItem(LAST_CHANNEL_ID_KEY));
  currentChannelId = currentChannels.some((channel) => channel.id === savedChannelId)
    ? savedChannelId
    : currentChannels[0]?.id ?? null;
  if (!currentChannelId) throw new Error('Kanal bulunamadı.');
}

function rememberCurrentChannel() {
  if (currentChannelId) localStorage.setItem(LAST_CHANNEL_ID_KEY, String(currentChannelId));
}

function createSocketConnection() {
  if (socket) {
    try { socket.disconnect(); } catch {}
    socket = null;
  }

  socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    auth: { token: currentAuthToken },
  });
  setupSocket();

  socket.on('connect', () => {
    hideConnectionBanner();
    if (!currentUser || !currentAuthToken || !currentChannelId) return;
    clearTimeout(reconnectVoiceJoinTimer);
    clearTimeout(reconnectScreenTimer);
    socket.emit('join', { channelId: currentChannelId, sessionId: clientSessionId });
    if (currentVoiceRoom) {
      reconnectVoiceJoinTimer = setTimeout(() => {
        socket?.emit('voice_join', { room: currentVoiceRoom });
      }, 500);
    }
    if (isSharing && screenStream) {
      reconnectScreenTimer = setTimeout(() => {
        socket?.emit('screen_share_start');
      }, 700);
    }
  });
}

async function bootstrapAuthenticatedApp({ token, refreshToken, shouldLoadSc = true } = {}) {
  applySessionTokens({
    accessToken: token || null,
    refreshToken,
    clearLegacyAccess: true,
  });

  await loadAuthenticatedBootstrap({ adminOnly: isAdminRoute });
  if (isAdminRoute) {
    if (!ensureAdminRouteAccess()) return;
    showAdminShell();
    await loadAdminRouteData();
    return;
  }

  hideAdminShell();
  rememberCurrentChannel();
  createSocketConnection();
  if (shouldLoadSc) loadScApi();
}

async function logoutAndReset({ revoke = true } = {}) {
  let tokenBeforeLogout = currentAuthToken;
  let refreshBeforeLogout = currentRefreshToken || getStoredRefreshToken();

  if (revoke && refreshBeforeLogout) {
    try {
      const refreshed = await refreshAccessToken();
      if (refreshed.ok) {
        tokenBeforeLogout = currentAuthToken;
        refreshBeforeLogout = currentRefreshToken || getStoredRefreshToken();
      }
    } catch {}
  }

  currentAuthToken = null;
  currentRefreshToken = null;
  currentUserProfile = null;
  clearPendingAuthChallenge();
  clearStoredAuth();

  if (revoke && tokenBeforeLogout) {
    try {
      currentAuthToken = tokenBeforeLogout;
      await postJson('/api/auth/logout', { refresh_token: refreshBeforeLogout }, { retryAuth: false });
    } catch {}
  }

  currentAuthToken = null;
  currentRefreshToken = null;
  currentUserProfile = null;
  clearPendingAuthChallenge();
  socket?.disconnect();
  window.location.reload();
}

function cloneIceServer(server) {
  if (!server || typeof server !== 'object') return null;
  return {
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
  };
}

function normalizeIceServers(iceServers) {
  if (!Array.isArray(iceServers)) return null;
  const normalized = iceServers
    .map(cloneIceServer)
    .filter((server) => server && (typeof server.urls === 'string' || Array.isArray(server.urls)));
  return normalized.length ? normalized : null;
}

async function loadClientConfig() {
  if (clientConfigPromise) return clientConfigPromise;

  clientConfigPromise = fetch('/api/client-config', { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const iceServers = normalizeIceServers(payload?.iceServers);
      if (iceServers) ICE.iceServers = iceServers;
      if (typeof payload?.registrationEnabled === 'boolean') {
        registrationEnabled = payload.registrationEnabled;
        applyRegistrationAvailability();
      }
      return payload;
    })
    .catch((err) => {
      console.warn('Client config unavailable, using fallback ICE servers.', err);
      return null;
    });

  return clientConfigPromise;
}

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

function showConnectionBanner(text = defaultConnectionBannerText) {
  if (!connectionBanner) return;
  connectionBanner.textContent = text;
  connectionBanner.classList.remove('hidden');
}

function hideConnectionBanner() {
  if (!connectionBanner) return;
  connectionBanner.textContent = defaultConnectionBannerText;
  connectionBanner.classList.add('hidden');
}

function isEditableTarget(target) {
  if (!target || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function resetRealtimeStateForReconnect() {
  closeAllPeers();
  closeScreenView();
  for (const [, pc] of screenPeerConns) {
    try { pc.close(); } catch {}
  }
  screenPeerConns.clear();
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
  if (isSharing) stopScreenShare();
  closeScreenView();
  currentView = 'channel';
  currentChannelId = channelId;
  rememberCurrentChannel();
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
  if (currentVoiceRoom) tryPlayAllPeerAudioElements();
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
    const data = await authorizedFetchJson(`/api/music/search?q=${encodeURIComponent(text)}`);
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

function getBaseVoiceAudioConstraints() {
  return {
    noiseSuppression: ($('toggle-noise')?.checked ?? true),
    echoCancellation: ($('toggle-echo')?.checked  ?? true),
    autoGainControl:  ($('toggle-gain')?.checked  ?? true),
  };
}

function setupLocalAudioAnalyser(stream) {
  audioAnalysers.delete('local');
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an  = ctx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    audioAnalysers.set('local', an);
  } catch {}
}

const audioDeviceController = voiceSettings?.createAudioDeviceController({
  localStorageKeyPrefix: '',
  localStorageRef: localStorage,
  inputSelect: inputDeviceSelect,
  outputSelect: outputDeviceSelect,
  noteEl: audioDeviceNote,
  screenVideo,
  getPeerAudioElements: () => [...document.querySelectorAll('audio[id^="audio-"]')],
  getBaseVoiceConstraints: getBaseVoiceAudioConstraints,
  getCurrentVoiceRoom: () => currentVoiceRoom,
  getPeerConnections: () => peerConnections,
  getLocalStream: () => localStream,
  setLocalStream: (stream) => { localStream = stream; },
  setupLocalAudioAnalyser,
  applyMicState: () => applyMicState(),
  updateMuteBtn: () => updateMuteBtn(),
  onMicrophoneError: (error) => alert(`Seçilen mikrofon açılamadı: ${error.message}`),
});

// ═══════════════ EKRAN PAYLAŞIMI ═══════════════
const QUALITY_PRESETS = {
  low:    { video: { width: 1280, height: 720,  frameRate: 15 }, audioBitrate: 64000,   videoBitrate: 500000  },
  normal: { video: { width: 1920, height: 1080, frameRate: 30 }, audioBitrate: 128000,  videoBitrate: 2000000 },
  high:   { video: { width: 2560, height: 1440, frameRate: 60 }, audioBitrate: 128000,  videoBitrate: 6000000 },
};
let selectedQuality = 'normal';

function applyScreenShareVolume(value) {
  const vol = Math.max(0, Math.min(100, parseInt(value) || 0));
  screenVolume.value = vol;
  screenVolumeLabel.textContent = vol + '%';
  screenVideo.volume = vol / 100;
}

const savedScreenVol = parseInt(localStorage.getItem('screenShareVolume') ?? '100');
applyScreenShareVolume(savedScreenVol);

screenVolume.addEventListener('input', () => {
  const vol = parseInt(screenVolume.value);
  applyScreenShareVolume(vol);
  localStorage.setItem('screenShareVolume', vol);
});

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

function closeScreenView() {
  screenPanel.classList.remove('fullscreen-mode');
  screenPanel.classList.add('hidden');
  screenVideo.srcObject = null;
  if (screenViewConn) { screenViewConn.close(); screenViewConn = null; }
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
    applyScreenShareVolume(screenVolume.value);
    audioDeviceController?.applyPreferredOutputDevice?.();
    screenPanel.classList.remove('hidden');
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) socket.emit('screen_ice', { to: sharerId, candidate: ev.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected','failed','closed'].includes(pc.connectionState)) {
      closeScreenView();
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
  closeScreenView();
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
  if (currentVoiceRoom === room) return;
  if (currentVoiceRoom) await leaveVoiceChannel();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: audioDeviceController?.buildVoiceAudioConstraints?.() || getBaseVoiceAudioConstraints(),
      video: false,
    });
  } catch (err) {
    alert('Mikrofona erişim izni reddedildi: ' + err.message);
    return;
  }
  setupLocalAudioAnalyser(localStream);

  currentVoiceRoom = room;
  audioUnlocked = true;
  socket.emit('voice_join', { room });
  socket.emit('music_sync_request', { voiceRoom: room });
  sounds.voiceJoin();
  updateVoiceUI();
  applyVoiceMode();
  startSpeakingDetection();
  audioDeviceController?.refreshSelectors?.();
  tryPlayAllPeerAudioElements();
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
  for (const [id, pc] of [...peerConnections]) cleanupPeer(id, pc);
  mutedPeers.clear();
  voicePeerDebug.clear();
}

function shouldInitiateVoicePeer(peerId) {
  return Boolean(socket?.id) && socket.id < peerId;
}

function queueVoiceCandidate(peerId, candidate) {
  if (!pendingVoiceCandidates.has(peerId)) pendingVoiceCandidates.set(peerId, []);
  pendingVoiceCandidates.get(peerId).push(candidate);
}

async function flushPendingVoiceCandidates(peerId) {
  const pc = peerConnections.get(peerId);
  const candidates = pendingVoiceCandidates.get(peerId);
  if (!pc || !pc.remoteDescription || !candidates?.length) return;

  pendingVoiceCandidates.delete(peerId);
  for (const candidate of candidates) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  }
}

function clearPeerDisconnectTimer(peerId) {
  const timer = peerDisconnectTimers.get(peerId);
  if (!timer) return;
  clearTimeout(timer);
  peerDisconnectTimers.delete(peerId);
}

function cleanupPeer(peerId, pc = peerConnections.get(peerId)) {
  clearPeerDisconnectTimer(peerId);
  pendingVoiceCandidates.delete(peerId);
  if (pc && peerConnections.get(peerId) === pc) peerConnections.delete(peerId);
  if (pc) {
    const state = pc.connectionState === 'closed' ? 'closed' : (pc.connectionState || 'closed');
    const iceState = pc.iceConnectionState === 'closed' ? 'closed' : (pc.iceConnectionState || 'closed');
    setVoicePeerDebug(peerId, { state, iceState });
  }
  if (pc && pc.signalingState !== 'closed') {
    try { pc.close(); } catch {}
  }
  removeAudio(peerId);
}

function forgetVoicePeer(peerId) {
  clearPeerDisconnectTimer(peerId);
  pendingVoiceCandidates.delete(peerId);
  clearVoicePeerDebug(peerId);
  voicePeerIds.delete(peerId);
}

function schedulePeerDisconnectCleanup(peerId, pc) {
  clearPeerDisconnectTimer(peerId);
  const timer = setTimeout(() => {
    const activePc = peerConnections.get(peerId);
    if (!activePc || activePc !== pc) return;
    if (
      ['disconnected', 'failed', 'closed'].includes(activePc.connectionState) ||
      ['disconnected', 'failed', 'closed'].includes(activePc.iceConnectionState)
    ) {
      cleanupPeer(peerId, activePc);
    }
  }, 5000);
  peerDisconnectTimers.set(peerId, timer);
}

async function ensureVoicePeerConnection(peerId, username) {
  if (!peerId || peerId === socket?.id) return null;
  if (username) voicePeerIds.set(peerId, username);
  setVoicePeerDebug(peerId, { username });
  syncPeerAudioElement(peerId);
  return createPeer(peerId, shouldInitiateVoicePeer(peerId));
}

async function createPeer(peerId, initiator) {
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);

  const pc = new RTCPeerConnection(ICE);
  peerConnections.set(peerId, pc);
  setVoicePeerDebug(peerId, {
    username: voicePeerIds.get(peerId) || null,
    state: pc.connectionState || 'new',
    iceState: pc.iceConnectionState || 'new',
    path: 'unknown',
    rttMs: null,
  });

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = async (ev) => {
    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${peerId}`;
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.append(audio);
    }
    audio.srcObject = ev.streams[0];
    try {
      await audioDeviceController?.applyPreferredOutputDevice?.();
    } catch {}
    syncPeerAudioElement(peerId);
    try {
      await audio.play();
    } catch {
      tryPlayAllPeerAudioElements();
    }
    // Konuşma analizi
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
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
    setVoicePeerDebug(peerId, { state: pc.connectionState || 'unknown' });
    if (['connected', 'completed'].includes(pc.connectionState)) {
      clearPeerDisconnectTimer(peerId);
      return;
    }
    if (['failed', 'closed'].includes(pc.connectionState)) {
      cleanupPeer(peerId, pc);
      return;
    }
    if (pc.connectionState === 'disconnected') schedulePeerDisconnectCleanup(peerId, pc);
  };

  pc.oniceconnectionstatechange = () => {
    setVoicePeerDebug(peerId, { iceState: pc.iceConnectionState || 'unknown' });
    if (['connected', 'completed'].includes(pc.iceConnectionState)) {
      clearPeerDisconnectTimer(peerId);
      return;
    }
    if (['failed', 'closed'].includes(pc.iceConnectionState)) {
      cleanupPeer(peerId, pc);
      return;
    }
    if (pc.iceConnectionState === 'disconnected') schedulePeerDisconnectCleanup(peerId, pc);
  };

  // Bağlantı kalitesi — 5sn'de bir RTT ölç
  const qualityInterval = setInterval(async () => {
    if (!peerConnections.has(peerId)) { clearInterval(qualityInterval); return; }
    try {
      const stats = await pc.getStats();
      const summary = summarizeSelectedCandidatePair(stats);
      if (summary) setVoicePeerDebug(peerId, summary);
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
  applyMicState();
  isMuted ? sounds.mute() : sounds.unmute();
  updateMuteBtn();
}

// ── Ses modu (PTT / VAD) ──────────────────────────────────────────────────────
let pttActive  = false;
let voiceMode  = localStorage.getItem('voiceMode') || 'vad'; // 'ptt' | 'vad'
let pttKeyCode = localStorage.getItem('pttKeyCode') || 'Space';

// Mikrofon gerçek durumu: VAD'da isMuted'a bak, PTT'de pttActive && !isMuted
function applyMicState() {
  if (!localStream) return;
  const active = voiceMode === 'ptt' ? (pttActive && !isMuted) : !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = active; });
  socket?.emit('voice_mute_state', { muted: !active });
}

function applyVoiceMode() {
  if (!currentVoiceRoom || !localStream) return;
  if (voiceMode === 'vad') {
    hidePttIndicator();
  } else {
    showPttIndicator(pttActive);
  }
  applyMicState();
  updateMuteBtn();
}

const pttController = voiceSettings?.createPttController({
  electronAPI,
  isElectronApp,
  localStorageKeyPrefix: '',
  localStorageRef: localStorage,
  pttKeyBtn,
  pttKeyDesc,
  pttKeyNote,
  hasVoiceRoom: () => Boolean(currentVoiceRoom),
  isEditableTarget,
  onStateChange: ({ voiceMode: nextVoiceMode, pttActive: nextPttActive, pttKeyCode: nextPttKeyCode }) => {
    voiceMode = nextVoiceMode;
    pttActive = nextPttActive;
    pttKeyCode = nextPttKeyCode;

    if (voiceMode === 'vad') {
      hidePttIndicator();
    } else if (currentVoiceRoom) {
      showPttIndicator(pttActive);
    }

    applyMicState();
    updateMuteBtn();
  },
});
pttController?.attach();

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
  pttController?.syncUi?.();
  audioDeviceController?.refreshSelectors?.({ ensurePermissions: true });
  clearAccountFeedback();
  accountPasswordForm?.reset?.();
  accountEmailPasswordInput && (accountEmailPasswordInput.value = '');
  accountDeleteForm?.reset?.();
  accountDeleteDetails?.removeAttribute?.('open');
  applyCurrentUserProfile(currentUserProfile);
  void refreshCurrentAccountState().catch(() => {});
  void loadAccountSessions({ silent: true });
  settingsOverlay.classList.remove('hidden');
});

$('settings-close').addEventListener('click', () => {
  pttController?.stopCapture?.();
  settingsOverlay.classList.add('hidden');
});
settingsOverlay.addEventListener('click', (e) => {
  if (e.target !== settingsOverlay) return;
  pttController?.stopCapture?.();
  settingsOverlay.classList.add('hidden');
});

document.querySelectorAll('.settings-opt[data-voice-mode]').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.settings-opt[data-voice-mode]').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    pttController?.setVoiceMode?.(opt.dataset.voiceMode);
    if (!pttController) {
      voiceMode = opt.dataset.voiceMode;
      localStorage.setItem('voiceMode', voiceMode);
      applyVoiceMode();
    }
  });
});
audioDeviceController?.attach?.();

accountDisplayNameSave?.addEventListener('click', async () => {
  const displayName = accountDisplayNameInput?.value?.trim() || '';
  if (!displayName) {
    setSettingsFeedback(accountProfileFeedback, 'Görünen ad boş bırakılamaz.', 'error');
    return;
  }
  accountDisplayNameSave.disabled = true;
  setSettingsFeedback(accountProfileFeedback, '');
  try {
    const payload = await postJson('/api/auth/change-display-name', {
      display_name: displayName,
    });
    applyCurrentUserProfile(payload.user);
    setSettingsFeedback(accountProfileFeedback, 'Görünen ad güncellendi.', 'success');
  } catch (err) {
    setSettingsFeedback(accountProfileFeedback, err.message || 'Görünen ad güncellenemedi.', 'error');
  } finally {
    accountDisplayNameSave.disabled = false;
  }
});

accountPasswordForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = accountCurrentPasswordInput?.value || '';
  const newPassword = accountNewPasswordInput?.value || '';
  const confirmPassword = accountNewPasswordConfirmInput?.value || '';

  if (!currentPassword || !newPassword) {
    setSettingsFeedback(accountPasswordFeedback, 'Tüm şifre alanlarını doldur.', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    setSettingsFeedback(accountPasswordFeedback, 'Yeni şifreler eşleşmiyor.', 'error');
    return;
  }

  const submitBtn = accountPasswordForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  setSettingsFeedback(accountPasswordFeedback, '');

  try {
    await postJson('/api/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
    });
    sessionStorage.setItem('sesappLoginError', 'Şifren değişti. Tekrar giriş yap.');
    await logoutAndReset({ revoke: false });
  } catch (err) {
    setSettingsFeedback(accountPasswordFeedback, err.message || 'Şifre değiştirilemedi.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

accountEmailRefreshBtn?.addEventListener('click', async () => {
  accountEmailRefreshBtn.disabled = true;
  setSettingsFeedback(accountEmailFeedback, '');
  try {
    await refreshCurrentAccountState();
    setSettingsFeedback(accountEmailFeedback, 'E-posta bilgisi yenilendi.', 'success');
  } catch (err) {
    setSettingsFeedback(accountEmailFeedback, err.message || 'E-posta bilgisi yenilenemedi.', 'error');
  } finally {
    accountEmailRefreshBtn.disabled = false;
  }
});

accountEmailForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const newEmail = accountEmailInput?.value?.trim() || '';
  const currentPassword = accountEmailPasswordInput?.value || '';
  if (!newEmail || !currentPassword) {
    setSettingsFeedback(accountEmailFeedback, 'E-posta ve mevcut şifre gerekli.', 'error');
    return;
  }

  const submitBtn = accountEmailForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  setSettingsFeedback(accountEmailFeedback, '');

  try {
    const payload = await postJson('/api/auth/change-email', {
      new_email: newEmail,
      current_password: currentPassword,
    });
    if (payload?.user) applyCurrentUserProfile(payload.user);
    accountEmailPasswordInput.value = '';
    setSettingsFeedback(
      accountEmailFeedback,
      payload?.warning || 'Dogrulama maili gonderildi. Gelen kutunu kontrol et.',
      payload?.warning ? 'error' : 'success',
    );
  } catch (err) {
    setSettingsFeedback(accountEmailFeedback, err.message || 'E-posta guncellenemedi.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

accountRecoveryForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = accountRecoveryPasswordInput?.value || '';
  if (!currentPassword) {
    setSettingsFeedback(accountRecoveryFeedback, 'Mevcut şifren gerekli.', 'error');
    return;
  }

  const submitBtn = accountRecoveryForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  setSettingsFeedback(accountRecoveryFeedback, '');

  try {
    const payload = await postJson('/api/auth/2fa/regenerate-recovery', {
      current_password: currentPassword,
    });
    if (accountRecoveryCodes) {
      accountRecoveryCodes.textContent = formatRecoveryCodes(payload.recovery_codes || []);
    }
    accountRecoveryResult?.classList.remove('hidden');
    if (accountRecoveryPasswordInput) accountRecoveryPasswordInput.value = '';
    setSettingsFeedback(accountRecoveryFeedback, 'Yeni kurtarma kodların üretildi. Bunları şimdi kaydet.', 'success');
  } catch (err) {
    setSettingsFeedback(accountRecoveryFeedback, err.message || 'Kurtarma kodları yenilenemedi.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

accountRecoveryCopyBtn?.addEventListener('click', async () => {
  const codes = accountRecoveryCodes?.textContent?.trim() || '';
  if (!codes) return;
  try {
    await navigator.clipboard.writeText(codes);
    setSettingsFeedback(accountRecoveryFeedback, 'Kurtarma kodları panoya kopyalandı.', 'success');
  } catch {
    setSettingsFeedback(accountRecoveryFeedback, 'Kopyalama başarısız oldu.', 'error');
  }
});

accountSessionsRefreshBtn?.addEventListener('click', () => {
  void loadAccountSessions();
});

accountLogoutAllBtn?.addEventListener('click', async () => {
  accountLogoutAllBtn.disabled = true;
  setSettingsFeedback(accountSessionsFeedback, '');
  try {
    await postJson('/api/auth/sessions/logout-all', {});
    sessionStorage.setItem('sesappLoginError', 'Tüm cihazlardaki oturumların kapatıldı.');
    await logoutAndReset({ revoke: false });
  } catch (err) {
    setSettingsFeedback(accountSessionsFeedback, err.message || 'Tüm oturumlar kapatılamadı.', 'error');
  } finally {
    accountLogoutAllBtn.disabled = false;
  }
});

accountSessionsList?.addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-session-id]');
  if (!button) return;
  const sessionId = button.dataset.sessionId;
  const isCurrent = button.dataset.isCurrent === 'true';
  button.disabled = true;
  setSettingsFeedback(accountSessionsFeedback, '');

  try {
    await requestJson(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      authorize: true,
      retryAuth: true,
    });
    if (isCurrent) {
      sessionStorage.setItem('sesappLoginError', 'Bu cihazdaki oturum kapatıldı.');
      await logoutAndReset({ revoke: false });
      return;
    }
    setSettingsFeedback(accountSessionsFeedback, 'Oturum kapatıldı.', 'success');
    await loadAccountSessions({ silent: true });
  } catch (err) {
    setSettingsFeedback(accountSessionsFeedback, err.message || 'Oturum kapatılamadı.', 'error');
    button.disabled = false;
  }
});

accountDeleteForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = accountDeletePasswordInput?.value || '';
  const phrase = accountDeletePhraseInput?.value?.trim().toUpperCase() || '';
  if (!password) {
    setSettingsFeedback(accountDeleteFeedback, 'Mevcut şifren gerekli.', 'error');
    return;
  }
  if (phrase !== 'HESABIMI SIL') {
    setSettingsFeedback(accountDeleteFeedback, 'Onay metnini tam olarak HESABIMI SIL yaz.', 'error');
    return;
  }

  const submitBtn = accountDeleteForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  setSettingsFeedback(accountDeleteFeedback, '');
  try {
    await postJson('/api/auth/account/delete', {
      current_password: password,
    });
    sessionStorage.setItem('sesappLoginError', 'Hesabın 7 gün sonra silinmek üzere işaretlendi.');
    await logoutAndReset({ revoke: false });
  } catch (err) {
    setSettingsFeedback(accountDeleteFeedback, err.message || 'Silme isteği başlatılamadı.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

accountAdminOpenBtn?.addEventListener('click', () => {
  window.location.href = '/admin';
});

adminLogoutBtn?.addEventListener('click', () => {
  logoutAndReset();
});

document.querySelectorAll('.admin-tab-btn[data-admin-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const nextTab = btn.dataset.adminTab || 'users';
    setAdminTab(nextTab);
    if (nextTab === 'users') void loadAdminUsers({ silent: true }).catch((err) => setAdminFeedback(err.message || 'Kullanıcılar yüklenemedi.', 'error'));
    if (nextTab === 'invites') void loadAdminInvites({ silent: true }).catch((err) => setAdminFeedback(err.message || 'Davetler yüklenemedi.', 'error'));
    if (nextTab === 'audit') void loadAdminAudit({ silent: true }).catch((err) => setAdminFeedback(err.message || 'Audit kayıtları yüklenemedi.', 'error'));
  });
});

adminUsersRefreshBtn?.addEventListener('click', () => {
  setAdminFeedback('');
  void loadAdminUsers().catch((err) => setAdminFeedback(err.message || 'Kullanıcılar yüklenemedi.', 'error'));
});

adminInvitesRefreshBtn?.addEventListener('click', () => {
  setAdminFeedback('');
  void loadAdminInvites().catch((err) => setAdminFeedback(err.message || 'Davetler yüklenemedi.', 'error'));
});

adminAuditRefreshBtn?.addEventListener('click', () => {
  setAdminFeedback('');
  void loadAdminAudit().catch((err) => setAdminFeedback(err.message || 'Audit kayıtları yüklenemedi.', 'error'));
});

[adminAuditEvent, adminAuditActor, adminAuditSince, adminAuditUntil, adminAuditLimit].forEach((el) => {
  el?.addEventListener('change', () => {
    if (currentAdminTab !== 'audit') return;
    setAdminFeedback('');
    void loadAdminAudit({ silent: true }).catch((err) => setAdminFeedback(err.message || 'Audit kayıtları yüklenemedi.', 'error'));
  });
  el?.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter') return;
    evt.preventDefault();
    setAdminFeedback('');
    void loadAdminAudit({ silent: true }).catch((err) => setAdminFeedback(err.message || 'Audit kayıtları yüklenemedi.', 'error'));
  });
});

adminUserSearch?.addEventListener('input', () => {
  clearTimeout(adminUsersSearchTimer);
  adminUsersSearchTimer = setTimeout(() => {
    setAdminFeedback('');
    void loadAdminUsers({ silent: true }).catch((err) => setAdminFeedback(err.message || 'Kullanıcılar yüklenemedi.', 'error'));
  }, 250);
});

adminUserStatusFilter?.addEventListener('change', () => {
  setAdminFeedback('');
  void loadAdminUsers({ silent: true }).catch((err) => setAdminFeedback(err.message || 'Kullanıcılar yüklenemedi.', 'error'));
});

adminInviteForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!adminInviteCreateBtn) return;
  adminInviteCreateBtn.disabled = true;
  setAdminFeedback('');
  try {
    const payload = await postJson('/api/admin/invites', {
      label: adminInviteLabel?.value?.trim() || '',
      max_uses: Number(adminInviteMaxUses?.value) || 1,
      ttl_hours: adminInviteTtlHours?.value ? Number(adminInviteTtlHours.value) : null,
    });
    if (adminInviteCodeValue) adminInviteCodeValue.textContent = payload.code || '—';
    adminInviteResult?.classList.remove('hidden');
    adminInviteForm.reset();
    if (adminInviteMaxUses) adminInviteMaxUses.value = '1';
    await loadAdminInvites({ silent: true });
    setAdminFeedback('Yeni davet oluşturuldu. Kod sadece burada bir kez gösterilir.', 'success');
  } catch (err) {
    setAdminFeedback(err.message || 'Davet oluşturulamadı.', 'error');
  } finally {
    adminInviteCreateBtn.disabled = false;
  }
});

adminInviteCopyBtn?.addEventListener('click', async () => {
  const code = adminInviteCodeValue?.textContent?.trim() || '';
  if (!code || code === '—') return;
  try {
    await navigator.clipboard.writeText(code);
    setAdminFeedback('Davet kodu panoya kopyalandı.', 'success');
  } catch {
    setAdminFeedback('Kopyalama başarısız oldu. Kodu elle seçebilirsin.', 'error');
  }
});

adminInvitesList?.addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action="revoke"][data-invite-id]');
  if (!button) return;
  button.disabled = true;
  setAdminFeedback('');
  try {
    await requestJson(`/api/admin/invites/${encodeURIComponent(button.dataset.inviteId)}`, {
      method: 'DELETE',
      authorize: true,
      retryAuth: true,
    });
    await loadAdminInvites({ silent: true });
    setAdminFeedback('Davet iptal edildi.', 'success');
  } catch (err) {
    setAdminFeedback(err.message || 'Davet iptal edilemedi.', 'error');
    button.disabled = false;
  }
});

adminUsersList?.addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action][data-username]');
  if (!button) return;
  const { action, username } = button.dataset;
  if (!username) return;

  button.disabled = true;
  setAdminFeedback('');

  try {
    if (action === 'disable') {
      const payload = await postJson(`/api/admin/users/${encodeURIComponent(username)}/disable`, {});
      if (username === currentUser && payload?.user) {
        applyCurrentUserProfile(payload.user);
        handleAuthFailure('Hesabın devre dışı bırakıldı.');
        return;
      }
      await loadAdminUsers({ silent: true });
      setAdminFeedback(`@${username} devre dışı bırakıldı.`, 'success');
      return;
    }

    if (action === 'enable') {
      const payload = await postJson(`/api/admin/users/${encodeURIComponent(username)}/enable`, {});
      if (username === currentUser && payload?.user) applyCurrentUserProfile(payload.user);
      await loadAdminUsers({ silent: true });
      setAdminFeedback(`@${username} tekrar aktif edildi.`, 'success');
      return;
    }

    if (action === 'role') {
      const nextRole = button.dataset.role === 'admin' ? 'admin' : 'user';
      const payload = await postJson(`/api/admin/users/${encodeURIComponent(username)}/role`, { role: nextRole });
      if (username === currentUser && payload?.user) {
        applyCurrentUserProfile(payload.user);
        if (!ensureAdminRouteAccess()) return;
      }
      await loadAdminUsers({ silent: true });
      setAdminFeedback(`@${username} için rol ${nextRole} olarak güncellendi.`, 'success');
      return;
    }

    if (action === 'logout-all') {
      await postJson(`/api/admin/users/${encodeURIComponent(username)}/logout-all`, {});
      if (username === currentUser) {
        sessionStorage.setItem('sesappLoginError', 'Tüm oturumların kapatıldı.');
        await logoutAndReset({ revoke: false });
        return;
      }
      setAdminFeedback(`@${username} için tüm oturumlar kapatıldı.`, 'success');
      return;
    }

    if (action === 'email-set') {
      const email = window.prompt(`@${username} için yeni e-posta adresi`, '');
      if (!email) {
        button.disabled = false;
        return;
      }
      const payload = await postJson(`/api/admin/users/${encodeURIComponent(username)}/email-set`, { email });
      if (username === currentUser && payload?.user) applyCurrentUserProfile(payload.user);
      await loadAdminUsers({ silent: true });
      setAdminFeedback(`@${username} için e-posta güncellendi.`, 'success');
      return;
    }

    if (action === 'totp-reset') {
      const confirmed = window.confirm(`@${username} için iki adımlı doğrulamayı sıfırlamak istiyor musun?`);
      if (!confirmed) {
        button.disabled = false;
        return;
      }
      await postJson('/api/auth/2fa/reset', { username });
      if (username === currentUser) {
        sessionStorage.setItem('sesappLoginError', '2FA kurulumun sıfırlandı. Tekrar giriş yap.');
        await logoutAndReset({ revoke: false });
        return;
      }
      await loadAdminUsers({ silent: true });
      setAdminFeedback(`@${username} için 2FA sıfırlandı.`, 'success');
      return;
    }

    if (action === 'delete') {
      const phrase = window.prompt(`@${username} hesabını silme sürecini başlatmak için HESABIMI SIL yaz.`, '');
      if (phrase?.trim().toUpperCase() !== 'HESABIMI SIL') {
        button.disabled = false;
        setAdminFeedback('Silme isteği iptal edildi.', 'error');
        return;
      }
      await requestJson(`/api/admin/users/${encodeURIComponent(username)}`, {
        method: 'DELETE',
        body: { confirmation_phrase: 'HESABIMI SIL' },
        authorize: true,
        retryAuth: true,
      });
      if (username === currentUser) {
        sessionStorage.setItem('sesappLoginError', 'Hesabın silinmek üzere işaretlendi.');
        await logoutAndReset({ revoke: false });
        return;
      }
      await loadAdminUsers({ silent: true });
      setAdminFeedback(`@${username} için silme süreci başlatıldı.`, 'success');
      return;
    }
  } catch (err) {
    setAdminFeedback(err.message || 'İşlem tamamlanamadı.', 'error');
  } finally {
    button.disabled = false;
  }
});

function showPttIndicator(active) {
  let el = $('ptt-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ptt-indicator';
    document.body.append(el);
  }
  const keyLabel = voiceSettings?.formatPttKeyLabel?.(pttKeyCode) || pttKeyCode;
  el.textContent = active ? '🎙️ Konuşuyor...' : `🔇 ${keyLabel} basılı tut`;
  el.className = active ? 'ptt-talking' : 'ptt-muted';
  el.classList.remove('hidden');
}

function hidePttIndicator() {
  $('ptt-indicator')?.classList.add('hidden');
}

function updateVoiceRoomsUI(state) {
  latestVoiceRoomsState = state;
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
      name.className = 'vc-member-name';
      name.textContent = username;
      name.style.flex = '1';
      name.style.fontSize = '.82rem';
      name.style.color = 'var(--text-2)';

      li.append(av, name);

      if (isVoicePeerMuted(username)) {
        const icon = document.createElement('span');
        icon.className = 'vc-muted-icon';
        icon.textContent = '🔇';
        li.append(icon);
      }

      const status = document.createElement('span');
      status.className = 'vc-peer-status';
      li.append(status);

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
      updateVoicePeerUi(username);
    }
  }
}

// ═══════════════ SOCKET OLAYLARI ═══════════════
function setupSocket() {
  socket.on('auth_error', ({ code, message }) => {
    if (isFatalAuthErrorCode(code)) {
      handleAuthFailure(message);
      return;
    }
    if (currentUser && appEl.classList.contains('_shown')) {
      showConnectionBanner(`${message} Yeniden bağlanılamadı.`);
      resetRealtimeStateForReconnect();
      socket.disconnect();
      socket = null;
      return;
    }
    loginError.textContent = message;
    setLoginBusy(false);
    socket.disconnect();
    socket = null;
  });

  socket.on('message_history', ({ messages, channelId }) => {
    // İlk bağlantıda UI'yi aç
    if (!appEl.classList.contains('_shown')) {
      appEl.classList.add('_shown');
      loginScreen.style.display = 'none';
      appEl.classList.remove('hidden');
      applyCurrentUserProfile(currentUserProfile || { username: currentUser, displayName: currentUser });
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
    if (!currentVoiceRoom) return;
    for (const peer of peers) {
      await ensureVoicePeerConnection(peer.socketId, peer.username);
    }
  });

  socket.on('voice_peer_joined', async ({ socketId, username }) => {
    if (!currentVoiceRoom) return;
    await ensureVoicePeerConnection(socketId, username);
  });

  socket.on('voice_offer', async ({ from, offer, fromUsername }) => {
    if (!currentVoiceRoom) return;
    if (fromUsername) voicePeerIds.set(from, fromUsername);
    const pc = await createPeer(from, false);
    syncPeerAudioElement(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushPendingVoiceCandidates(from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('voice_answer', { to: from, answer });
  });

  socket.on('voice_answer', async ({ from, answer, fromUsername }) => {
    if (!currentVoiceRoom) return;
    if (fromUsername) voicePeerIds.set(from, fromUsername);
    syncPeerAudioElement(from);
    const pc = peerConnections.get(from);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushPendingVoiceCandidates(from);
    }
  });

  socket.on('voice_ice', async ({ from, candidate }) => {
    if (!currentVoiceRoom) return;
    const pc = peerConnections.get(from);
    if (!pc || !pc.remoteDescription) {
      queueVoiceCandidate(from, candidate);
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  });

  socket.on('voice_peer_left', ({ socketId }) => {
    cleanupPeer(socketId);
    forgetVoicePeer(socketId);
  });

  socket.on('voice_peer_muted', ({ socketId, muted }) => {
    if (muted) mutedPeers.add(socketId);
    else mutedPeers.delete(socketId);
    updateAllVoicePeerUi();
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
    closeScreenView();
  });

  socket.on('disconnect', () => {
    showConnectionBanner();
    resetRealtimeStateForReconnect();
  });

  socket.on('connect_error', (err) => {
    if (isFatalAuthErrorCode(err?.data?.code)) {
      handleAuthFailure(err.message || 'Oturumun geçersiz. Tekrar giriş yap.');
      return;
    }
    showConnectionBanner('Sunucuya ulaşılamıyor, yeniden deneniyor...');
  });

  setupPokerSocket();
}

async function handleSpecialAuthRoute() {
  if (isConfirmEmailRoute) {
    const token = authRouteParams.get('token') || '';
    setAuthMode('login');
    if (!token) {
      setLoginStatus('Dogrulama baglantisi gecersiz gorunuyor.');
      return true;
    }

    setLoginBusy(true);
    try {
      await postJson('/api/auth/change-email/confirm', { token }, { authorize: false, retryAuth: false });
      setLoginStatus('E-posta adresin dogrulandi. Artik sifre kurtarma icin kullanabilirsin.', 'success');
      window.history.replaceState({}, '', '/');
    } catch (err) {
      setLoginStatus(err.message || 'Dogrulama baglantisi gecersiz ya da suresi dolmus.');
    } finally {
      setLoginBusy(false);
    }
    return true;
  }

  if (isResetPasswordRoute) {
    pendingResetToken = authRouteParams.get('token') || '';
    setAuthMode('reset');
    if (!pendingResetToken) {
      setLoginStatus('Sifirlama baglantisi gecersiz gorunuyor.');
    }
    return true;
  }

  return false;
}

// ═══════════════ GİRİŞ ═══════════════
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const email = emailInput?.value?.trim() || '';
  const password = passwordInput.value;
  const confirmPassword = resetPasswordConfirmInput?.value || '';
  const inviteCode = inviteCodeInput?.value || '';
  const mfaCode = mfaCodeInput?.value?.trim() || '';
  const recoveryCode = mfaRecoveryInput?.value?.trim() || '';
  if ((authMode === 'login' || authMode === 'register') && !username) return;
  setLoginStatus('', 'error');
  setLoginBusy(true);

  if (authMode === 'forgot') {
    try {
      await postJson('/api/auth/forgot-password', { email }, { authorize: false, retryAuth: false });
      setLoginStatus('Eger bu e-posta dogrulandiysa sifirlama linki gonderildi.', 'success');
      setAuthMode('login');
    } catch (err) {
      setLoginStatus(err.message || 'Sifirlama istegi gonderilemedi.');
    }
    setLoginBusy(false);
    return;
  }

  if (authMode === 'reset') {
    if (!pendingResetToken) {
      setLoginStatus('Sifirlama baglantisi gecersiz ya da eksik.');
      setLoginBusy(false);
      return;
    }
    if (!password) {
      setLoginStatus('Yeni sifreni gir.');
      setLoginBusy(false);
      return;
    }
    if (password !== confirmPassword) {
      setLoginStatus('Yeni sifreler eslesmiyor.');
      setLoginBusy(false);
      return;
    }
    try {
      await postJson('/api/auth/reset-password', {
        token: pendingResetToken,
        new_password: password,
      }, { authorize: false, retryAuth: false });
      pendingResetToken = null;
      window.history.replaceState({}, '', '/');
      resetPasswordConfirmInput.value = '';
      passwordInput.value = '';
      setAuthMode('login');
      setLoginStatus('Sifren yenilendi. Simdi yeni sifrenle giris yap.', 'success');
    } catch (err) {
      setLoginStatus(err.message || 'Sifre yenilenemedi.');
    }
    setLoginBusy(false);
    return;
  }

  if (authMode === 'mfa-enroll') {
    if (!currentPendingAuthChallenge?.token) {
      setLoginStatus('Dogrulama oturumu bulunamadi. Tekrar giris yap.');
      setLoginBusy(false);
      return;
    }
    if (!mfaRecoverySavedCheck?.checked) {
      setLoginStatus('Devam etmeden once kurtarma kodlarini kaydettigini onayla.');
      setLoginBusy(false);
      return;
    }
    if (!mfaCode) {
      setLoginStatus('Authenticator uygulamandaki 6 haneli kodu gir.');
      setLoginBusy(false);
      return;
    }
    try {
      const authPayload = await requestPendingJson('/api/auth/2fa/enroll/confirm', {
        body: { code: mfaCode },
      });
      clearPendingAuthChallenge();
      const { accessToken, refreshToken } = extractSessionTokens(authPayload);
      await bootstrapAuthenticatedApp({ token: accessToken, refreshToken, shouldLoadSc: true });
      setLoginBusy(false);
      return;
    } catch (err) {
      setLoginStatus(err.message || 'Iki adimli dogrulama tamamlanamadi.');
      setLoginBusy(false);
      return;
    }
  }

  if (authMode === 'mfa-verify') {
    if (!currentPendingAuthChallenge?.token) {
      setLoginStatus('Dogrulama oturumu bulunamadi. Tekrar giris yap.');
      setLoginBusy(false);
      return;
    }
    if (!mfaCode) {
      setLoginStatus(currentPendingAuthChallenge?.step === 'email'
        ? 'E-postana gelen 6 haneli kodu gir.'
        : 'Authenticator uygulamandaki 6 haneli kodu gir.');
      setLoginBusy(false);
      return;
    }
    try {
      const authPayload = await requestPendingJson('/api/auth/2fa/verify', {
        body: { code: mfaCode },
      });
      clearPendingAuthChallenge();
      const { accessToken, refreshToken } = extractSessionTokens(authPayload);
      await bootstrapAuthenticatedApp({ token: accessToken, refreshToken, shouldLoadSc: true });
      setLoginBusy(false);
      return;
    } catch (err) {
      setLoginStatus(err.message || 'Dogrulama basarisiz.');
      setLoginBusy(false);
      return;
    }
  }

  if (authMode === 'mfa-recovery') {
    if (!currentPendingAuthChallenge?.token) {
      setLoginStatus('Dogrulama oturumu bulunamadi. Tekrar giris yap.');
      setLoginBusy(false);
      return;
    }
    if (!recoveryCode) {
      setLoginStatus('Kurtarma kodunu gir.');
      setLoginBusy(false);
      return;
    }
    try {
      const authPayload = await requestPendingJson('/api/auth/2fa/recovery', {
        body: { recovery_code: recoveryCode },
      });
      clearPendingAuthChallenge();
      const { accessToken, refreshToken } = extractSessionTokens(authPayload);
      await bootstrapAuthenticatedApp({ token: accessToken, refreshToken, shouldLoadSc: true });
      setLoginBusy(false);
      return;
    } catch (err) {
      setLoginStatus(err.message || 'Kurtarma kodu kabul edilmedi.');
      setLoginBusy(false);
      return;
    }
  }

  let authPayload;
  try {
    authPayload = await postJson(
      authMode === 'register' ? '/api/auth/register' : '/api/auth/login',
      authMode === 'register'
        ? { username, password, inviteCode, email }
        : { username, password },
      { authorize: false, retryAuth: false },
    );
  } catch (err) {
    setLoginStatus(err.message || 'Giriş başarısız.');
    setLoginBusy(false);
    return;
  }

  if (authPayload?.pending_token) {
    try {
      await beginPendingAuthFlow(authPayload);
    } catch (err) {
      clearPendingAuthChallenge();
      setLoginStatus(err.message || 'Iki adimli dogrulama baslatilamadi.');
    }
    setLoginBusy(false);
    return;
  }

  try {
    const { accessToken, refreshToken } = extractSessionTokens(authPayload);
    clearPendingAuthChallenge();
    await bootstrapAuthenticatedApp({ token: accessToken, refreshToken, shouldLoadSc: true });
    if (authPayload?.warning) {
      showConnectionBanner(authPayload.warning);
      setTimeout(() => hideConnectionBanner(), 4500);
    }
  } catch {
    setLoginStatus('Sunucuya bağlanılamadı.');
    clearStoredAuth();
    currentAuthToken = null;
    currentRefreshToken = null;
    setLoginBusy(false);
    return;
  }
  setLoginBusy(false);
});

authLoginTab?.addEventListener('click', () => {
  setLoginStatus('', 'error');
  setAuthMode('login');
});
authRegisterTab?.addEventListener('click', () => {
  setLoginStatus('', 'error');
  setAuthMode('register');
});
forgotPasswordLink?.addEventListener('click', () => {
  setLoginStatus('', 'error');
  setAuthMode('forgot');
});
mfaRecoverySavedCheck?.addEventListener('change', () => {
  updatePendingAuthUi();
});
mfaResendBtn?.addEventListener('click', async () => {
  if (isLoginBusy || currentPendingAuthChallenge?.step !== 'email') return;
  setLoginStatus('', 'error');
  setLoginBusy(true);
  try {
    const payload = await requestPendingJson('/api/auth/2fa/resend');
    if (payload?.email_hint) currentPendingAuthChallenge.emailHint = payload.email_hint;
    setLoginStatus(
      payload?.email_hint
        ? `Kod tekrar gonderildi: ${payload.email_hint}`
        : 'Kod tekrar e-postana gonderildi.',
      'success',
    );
  } catch (err) {
    setLoginStatus(err.message || 'Kod tekrar gonderilemedi.');
  }
  setLoginBusy(false);
});
mfaSecretCopyBtn?.addEventListener('click', () => {
  const value = currentPendingAuthChallenge?.secretB32 || '';
  if (!value) return;
  void copyPlainText(value, 'Kurulum anahtarı panoya kopyalandı.');
});
mfaRecoveryCopyBtn?.addEventListener('click', () => {
  const codes = formatRecoveryCodes(currentPendingAuthChallenge?.recoveryCodes || []);
  if (!codes) return;
  void copyPlainText(codes, 'Kurtarma kodları panoya kopyalandı.');
});
mfaUseRecoveryBtn?.addEventListener('click', () => {
  setLoginStatus('', 'error');
  setAuthMode('mfa-recovery');
});
mfaUseAppBtn?.addEventListener('click', () => {
  setLoginStatus('', 'error');
  setAuthMode('mfa-verify');
});
authBackLink?.addEventListener('click', () => {
  setLoginStatus('', 'error');
  pendingResetToken = null;
  clearPendingAuthChallenge();
  if (isResetPasswordRoute || isConfirmEmailRoute) window.history.replaceState({}, '', '/');
  setAuthMode('login');
});
logoutBtn?.addEventListener('click', () => {
  logoutAndReset();
});

setAuthMode('login');
applyRegistrationAvailability();
loadClientConfig();
const pendingLoginError = sessionStorage.getItem('sesappLoginError');
if (pendingLoginError) {
  setLoginStatus(pendingLoginError, pendingLoginError.includes('Dogrulama') ? 'success' : 'error');
  sessionStorage.removeItem('sesappLoginError');
}

void (async () => {
  const isSpecialAuthRoute = await handleSpecialAuthRoute();
  const existingRefreshToken = getStoredRefreshToken();
  const existingAuthToken = getStoredAuthToken();
  if (!isSpecialAuthRoute && existingRefreshToken) {
    currentRefreshToken = existingRefreshToken;
    setLoginBusy(true);
    refreshAccessToken()
      .then((result) => {
        if (!result.ok) throw new Error(result.message || 'Oturum geri yüklenemedi.');
        return bootstrapAuthenticatedApp({ shouldLoadSc: true });
      })
      .catch((err) => {
        clearStoredAuth();
        currentAuthToken = null;
        currentRefreshToken = null;
        setLoginStatus(err?.message || 'Oturum geri yüklenemedi.');
        setLoginBusy(false);
      });
  } else if (!isSpecialAuthRoute && existingAuthToken) {
    setLoginBusy(true);
    bootstrapAuthenticatedApp({ token: existingAuthToken, shouldLoadSc: true })
      .catch((err) => {
        clearStoredAuth();
        currentAuthToken = null;
        currentRefreshToken = null;
        setLoginStatus(err?.message || 'Oturum geri yüklenemedi.');
        setLoginBusy(false);
      });
  }
})();

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
    const isWinner = s.isWinner && state.phase === 'showdown';
    const div = document.createElement('div');
    div.className = 'poker-seat'
      + (s.folded ? ' folded' : '')
      + (state.turn === s.socketId ? ' myturn' : '')
      + (isWinner ? ' winner' : '');
    const dealer = state.seats[state.dealer]?.socketId === s.socketId;
    const nameEl = document.createElement('div');
    nameEl.className = 'ps-name';
    nameEl.innerHTML = (isWinner ? '🏆 ' : '') + s.username
      + (dealer ? ' <span class="dealer-btn">D</span>' : '');

    const chipsEl = document.createElement('div');
    chipsEl.className = 'ps-chips';
    chipsEl.textContent = `💰 ${s.chips}` + (s.allIn ? ' ALL-IN' : '');

    div.append(nameEl, chipsEl);

    if (s.bet > 0) {
      const betEl = document.createElement('div');
      betEl.className = 'ps-bet';
      betEl.textContent = `Bet: ${s.bet}`;
      div.append(betEl);
    }

    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'ps-cards';
    (s.hand || [null, null]).forEach(c => cardsDiv.append(cardEl(c)));
    div.append(cardsDiv);

    // Showdown: el ismi göster
    if (state.phase === 'showdown' && !s.folded && s.handName) {
      const handEl = document.createElement('div');
      handEl.className = 'ps-hand-name' + (isWinner ? ' winner-hand' : '');
      handEl.textContent = s.handName;
      div.append(handEl);
    }

    pokerSeats.append(div);
  }

  // My area
  if (mySeat) {
    pokerMyArea.classList.remove('hidden');
    pokerMyArea.classList.toggle('winner', !!(mySeat.isWinner && state.phase === 'showdown'));
    pokerHoleCards.innerHTML = '';
    (mySeat.hand||[]).forEach(c => pokerHoleCards.append(cardEl(c)));
    pokerMyChips.textContent = `💰 ${mySeat.chips} chip`;
    // Showdown: kendi el ismini göster
    if (state.phase === 'showdown' && mySeat.handName) {
      pokerMyBet.textContent = mySeat.isWinner ? `🏆 ${mySeat.handName}` : mySeat.handName;
      pokerMyBet.style.color = mySeat.isWinner ? 'var(--green)' : 'var(--text-2)';
      pokerMyBet.style.fontWeight = '600';
    } else {
      pokerMyBet.textContent = mySeat.bet > 0 ? `Bet: ${mySeat.bet}` : '';
      pokerMyBet.style.color = '';
      pokerMyBet.style.fontWeight = '';
    }
  } else {
    pokerMyArea.classList.add('hidden');
  }

  // Winner banner — tüm elleri karşılaştırmalı göster
  if (state.phase === 'showdown' && state.winner) {
    pokerWinnerBanner.classList.remove('hidden');
    const winnerNames = state.winner.map(id => state.seats.find(s=>s.socketId===id)?.username || id);
    // El karşılaştırması: her aktif oyuncunun elini listele
    const handLines = state.seats
      .filter(s => !s.folded && s.handName)
      .map(s => `${s.isWinner ? '🏆' : '  '} ${s.username}: ${s.handName}`)
      .join('\n');
    pokerWinnerBanner.innerHTML =
      `<div class="pw-title">${winnerNames.join(' & ')} kazandı!</div>` +
      (handLines ? `<pre class="pw-hands">${handLines}</pre>` : '');
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
