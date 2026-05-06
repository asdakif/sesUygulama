'use strict';

const crypto = require('crypto');

const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 72;

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!username) return { ok: false, message: 'Kullanıcı adı gerekli.' };
  if (username.length < 2 || username.length > 20) {
    return { ok: false, message: 'Kullanıcı adı 2-20 karakter arasında olmalı.' };
  }
  return { ok: true, username };
}

function validatePassword(password) {
  if (typeof password !== 'string' || !password.length) {
    return { ok: false, message: 'Şifre gerekli.' };
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      message: `Şifre ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} karakter arasında olmalı.`,
    };
  }
  return { ok: true };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash.startsWith('scrypt$')) return false;

  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;

  const [, salt, expectedHashHex] = parts;
  if (!salt || !expectedHashHex) return false;

  try {
    const actualHash = crypto.scryptSync(password, salt, expectedHashHex.length / 2);
    const expectedHash = Buffer.from(expectedHashHex, 'hex');
    if (actualHash.length !== expectedHash.length) return false;
    return crypto.timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function createAuthToken({ username, secret, ttlMs }) {
  const issuedAt = Date.now();
  const payload = {
    sub: username,
    iat: issuedAt,
    exp: issuedAt + ttlMs,
    jti: crypto.randomUUID(),
    v: 1,
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifyAuthToken(token, secret) {
  if (typeof token !== 'string') return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest();
  const actualSignature = Buffer.from(signature, 'base64url');
  if (actualSignature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(actualSignature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    const username = normalizeUsername(payload?.sub);
    if (!username) return null;
    if (!Number.isFinite(payload?.exp) || Date.now() > payload.exp) return null;
    return {
      username,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      tokenId: payload.jti,
      version: payload.v,
    };
  } catch {
    return null;
  }
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  createAuthToken,
  hashPassword,
  normalizeUsername,
  validatePassword,
  validateUsername,
  verifyAuthToken,
  verifyPassword,
};
