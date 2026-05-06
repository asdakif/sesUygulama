'use strict';

const path = require('path');

const defaultRtcIceServers = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
  Object.freeze({ urls: 'stun:stun1.l.google.com:19302' }),
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

const envRtcIceServers = parseIceServers(process.env.RTC_ICE_SERVERS_JSON);

module.exports = {
  defaultPort: process.env.PORT === undefined ? 3000 : Number(process.env.PORT),
  registrationInviteCode: process.env.REGISTRATION_INVITE || process.env.PASSWORD || '',
  authSecret: process.env.AUTH_SECRET || process.env.PASSWORD || '',
  authTokenTtlMs: readNumber('AUTH_TOKEN_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,
  socketPingInterval: readNumber('SOCKET_PING_INTERVAL', 25_000),
  socketPingTimeout: readNumber('SOCKET_PING_TIMEOUT', 60_000),
  apiRateWindowMs: 15 * 60 * 1000,
  apiRateMax: readNumber('API_RATE_MAX', 100),
  socketRateWindowMs: readNumber('SOCKET_RATE_WINDOW_MS', 60_000),
  socketRateMax: readNumber('SOCKET_RATE_MAX', 30),
  soundcloudRefreshMs: readNumber('SC_REFRESH_MS', 12 * 60 * 60 * 1000),
  soundcloudUserAgent: process.env.SC_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  defaultRtcIceServers,
  rtcIceServers: envRtcIceServers || defaultRtcIceServers,
  hasCustomRtcIceServers: Boolean(envRtcIceServers),
  parseIceServers,
  staticDir: path.join(__dirname, '..', 'public'),
  defaultVoiceRooms: ['sesli-genel', 'sesli-oyun'],
};
