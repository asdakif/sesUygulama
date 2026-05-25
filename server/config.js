'use strict';

const path = require('path');

const defaultStunIceServers = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
  Object.freeze({ urls: 'stun:stun1.l.google.com:19302' }),
]);

const defaultRtcIceServers = Object.freeze([
  ...defaultStunIceServers,
  Object.freeze({
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  }),
]);

function readNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readTimestamp(name, fallback = null) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeIceServer(server) {
  if (!server || typeof server !== 'object') return null;

  let urls = null;
  if (typeof server.urls === 'string' && server.urls.trim()) {
    urls = server.urls.trim();
  } else if (Array.isArray(server.urls)) {
    const validUrls = server.urls
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim());
    if (validUrls.length) urls = validUrls;
  }

  if (!urls) return null;

  const normalized = { urls };
  if (typeof server.username === 'string') normalized.username = server.username;
  if (typeof server.credential === 'string') normalized.credential = server.credential;
  if (typeof server.credentialType === 'string') normalized.credentialType = server.credentialType;
  return normalized;
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function readBooleanFromEnv(env, name, fallback) {
  const value = env?.[name];
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function readChoice(name, allowedValues, fallback) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

function splitCsv(rawValue) {
  if (typeof rawValue !== 'string') return [];
  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseIceServers(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return null;

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return null;
    const normalized = parsed.map(normalizeIceServer).filter(Boolean);
    return normalized.length ? normalized : null;
  } catch {
    return null;
  }
}

function buildManagedTurnIceServers(env = process.env) {
  const hosts = splitCsv(env.TURN_HOSTS || env.TURN_HOST || '');
  const username = typeof env.TURN_USERNAME === 'string' ? env.TURN_USERNAME.trim() : '';
  const credential = typeof env.TURN_PASSWORD === 'string' ? env.TURN_PASSWORD.trim() : '';
  if (!hosts.length || !username || !credential) return null;

  const udpPort = Number(env.TURN_PORT || 3478);
  const tlsPort = Number(env.TURNS_PORT || 5349);
  const includeTcp = readBooleanFromEnv(env, 'TURN_ENABLE_TCP', true);
  const includeTls = readBooleanFromEnv(env, 'TURN_ENABLE_TLS', true);
  const urls = [];

  for (const host of hosts) {
    urls.push(`turn:${host}:${udpPort}`);
    if (includeTcp) urls.push(`turn:${host}:${udpPort}?transport=tcp`);
    if (includeTls) urls.push(`turns:${host}:${tlsPort}?transport=tcp`);
  }

  return [
    ...defaultStunIceServers,
    {
      urls,
      username,
      credential,
    },
  ];
}

const envRtcIceServers = parseIceServers(process.env.RTC_ICE_SERVERS_JSON);
const envManagedTurnIceServers = buildManagedTurnIceServers(process.env);

module.exports = {
  defaultPort: process.env.PORT === undefined ? 3000 : Number(process.env.PORT),
  legacyInviteCode: process.env.REGISTRATION_INVITE || '',
  legacyInviteEnabled: readBoolean('LEGACY_INVITE_ENABLED', true),
  registrationInviteCode: process.env.REGISTRATION_INVITE || '',
  authSecret: process.env.AUTH_SECRET || '',
  legacyAuthTokenGraceUntil: readTimestamp('LEGACY_AUTH_TOKEN_GRACE_UNTIL'),
  accessTokenTtlMs: readNumber('ACCESS_TOKEN_TTL_MINUTES', 15) * 60 * 1000,
  authTokenTtlMs: readNumber('AUTH_TOKEN_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,
  refreshTokenTtlMs: readNumber('REFRESH_TOKEN_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,
  refreshRateWindowMs: readNumber('AUTH_REFRESH_RATE_WINDOW_MS', 60_000),
  refreshRateMax: readNumber('AUTH_REFRESH_RATE_MAX', 60),
  pendingTokenTtlMs: 5 * 60 * 1000,
  mfaRequired: readBoolean('MFA_REQUIRED', true),
  emailAuthCodeTtlMs: readNumber('EMAIL_AUTH_CODE_TTL_MINUTES', 10) * 60 * 1000,
  passwordResetTokenTtlMs: readNumber('PASSWORD_RESET_TOKEN_TTL_MINUTES', 60) * 60 * 1000,
  emailVerificationTokenTtlMs: readNumber('EMAIL_VERIFICATION_TOKEN_TTL_MINUTES', 60) * 60 * 1000,
  emailProvider: process.env.EMAIL_PROVIDER || (process.env.NODE_ENV === 'test' ? 'noop' : 'resend'),
  emailAllowNoop: readBoolean('EMAIL_ALLOW_NOOP', process.env.NODE_ENV === 'test'),
  resendApiKey: process.env.RESEND_API_KEY || '',
  smtpUrl: process.env.SMTP_URL || '',
  emailFrom: process.env.EMAIL_FROM || '',
  publicAppUrl: process.env.PUBLIC_APP_URL || '',
  bootstrapAdminUsername: process.env.BOOTSTRAP_ADMIN_USERNAME || '',
  socketPingInterval: readNumber('SOCKET_PING_INTERVAL', 25_000),
  socketPingTimeout: readNumber('SOCKET_PING_TIMEOUT', 60_000),
  apiRateWindowMs: 15 * 60 * 1000,
  apiRateMax: readNumber('API_RATE_MAX', 100),
  socketRateWindowMs: readNumber('SOCKET_RATE_WINDOW_MS', 60_000),
  socketRateMax: readNumber('SOCKET_RATE_MAX', 30),
  soundcloudRefreshMs: readNumber('SC_REFRESH_MS', 12 * 60 * 60 * 1000),
  soundcloudUserAgent: process.env.SC_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  defaultStunIceServers,
  defaultRtcIceServers,
  rtcIceServers: envRtcIceServers || envManagedTurnIceServers || defaultRtcIceServers,
  hasCustomRtcIceServers: Boolean(envRtcIceServers || envManagedTurnIceServers),
  buildManagedTurnIceServers,
  parseIceServers,
  staticDir: path.join(__dirname, '..', 'public'),
  defaultVoiceRooms: ['sesli-genel', 'sesli-oyun'],
};
