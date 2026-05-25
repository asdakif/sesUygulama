'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const TOTP_STEP_MS = 30_000;
const TOTP_DIGITS = 6;
const TOTP_REPLAY_WINDOW_MS = 90_000;
const recentTotpUsage = new Map();

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(input) {
  const normalized = String(input || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret(bytes = 20) {
  return encodeBase32(crypto.randomBytes(bytes));
}

function generateOtpauthUrl({ issuer, username, secret }) {
  const safeIssuer = encodeURIComponent(issuer);
  const safeLabel = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${safeLabel}?secret=${secret}&issuer=${safeIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=30`;
}

async function renderQrSvg(otpauthUrl) {
  return QRCode.toString(otpauthUrl, {
    type: 'svg',
    margin: 1,
    width: 220,
    color: {
      dark: '#f8fafc',
      light: '#0000',
    },
  });
}

function hotp(secret, counter, digits = TOTP_DIGITS) {
  const key = decodeBase32(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function getTotpCounter(now = Date.now()) {
  return Math.floor(now / TOTP_STEP_MS);
}

function generateTotpCode(secret, now = Date.now()) {
  return hotp(secret, getTotpCounter(now));
}

function normalizeTotpCode(code) {
  return String(code || '').replace(/\s+/g, '').trim();
}

function clearExpiredRecentTotpUsage(now = Date.now()) {
  for (const [key, expiresAt] of recentTotpUsage) {
    if (expiresAt <= now) recentTotpUsage.delete(key);
  }
}

function rememberAcceptedCode(username, counter, now = Date.now()) {
  clearExpiredRecentTotpUsage(now);
  recentTotpUsage.set(`${username}:${counter}`, now + TOTP_REPLAY_WINDOW_MS);
}

function wasCodeRecentlyUsed(username, counter, now = Date.now()) {
  clearExpiredRecentTotpUsage(now);
  const expiresAt = recentTotpUsage.get(`${username}:${counter}`);
  return Boolean(expiresAt && expiresAt > now);
}

function verifyTotpCode({ secret, code, now = Date.now(), window = 1, username = '' }) {
  const normalizedCode = normalizeTotpCode(code);
  if (!/^\d{6}$/.test(normalizedCode)) {
    return { ok: false, reason: 'invalid_format' };
  }

  const baseCounter = getTotpCounter(now);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = baseCounter + offset;
    if (counter < 0) continue;
    if (hotp(secret, counter) !== normalizedCode) continue;
    if (username && wasCodeRecentlyUsed(username, counter, now)) {
      return { ok: false, reason: 'replayed_code' };
    }
    if (username) rememberAcceptedCode(username, counter, now);
    return { ok: true, counter };
  }

  return { ok: false, reason: 'code_mismatch' };
}

function generateRecoveryCode() {
  let raw = '';
  for (let index = 0; index < 12; index += 1) {
    raw += RECOVERY_ALPHABET[crypto.randomInt(0, RECOVERY_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

module.exports = {
  TOTP_DIGITS,
  TOTP_REPLAY_WINDOW_MS,
  TOTP_STEP_MS,
  clearExpiredRecentTotpUsage,
  encodeBase32,
  decodeBase32,
  generateOtpauthUrl,
  generateRecoveryCodes,
  generateSecret,
  generateTotpCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  normalizeTotpCode,
  renderQrSvg,
  verifyTotpCode,
};
