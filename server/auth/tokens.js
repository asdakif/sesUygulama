'use strict';

const crypto = require('crypto');

function signPayload(payload, secret) {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function createAuthToken({
  username,
  secret,
  ttlMs,
  tokenVersion = 1,
  role = 'user',
  schemaVersion = 2,
  tokenId = crypto.randomUUID(),
}) {
  const issuedAt = Date.now();
  const payload = {
    sub: username,
    ver: tokenVersion,
    rol: role,
    iat: issuedAt,
    exp: issuedAt + ttlMs,
    jti: tokenId,
    v: schemaVersion,
  };
  return signPayload(payload, secret);
}

function createPendingAuthToken({
  username,
  step,
  secret,
  ttlMs,
  schemaVersion = 2,
  tokenId = crypto.randomUUID(),
}) {
  const issuedAt = Date.now();
  return signPayload({
    sub: username,
    step,
    iat: issuedAt,
    exp: issuedAt + ttlMs,
    jti: tokenId,
    v: schemaVersion,
  }, secret);
}

function parseSignedToken(token, secret) {
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
    return JSON.parse(decodeBase64Url(encodedPayload));
  } catch {
    return null;
  }
}

function verifyAuthToken(token, secret) {
  const payload = parseSignedToken(token, secret);
  const username = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  if (!username) return null;
  if (!Number.isFinite(payload?.exp) || Date.now() > payload.exp) return null;
  if (payload?.step) return null;
  const schemaVersion = Number.isFinite(payload?.v) ? payload.v : 1;
  const tokenVersion = Number.isFinite(payload?.ver) ? payload.ver : 1;
  return {
    username,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    tokenId: payload.jti,
    version: schemaVersion,
    tokenVersion,
    role: typeof payload?.rol === 'string' && payload.rol ? payload.rol : 'user',
    isLegacy: schemaVersion < 2 || !Number.isFinite(payload?.ver),
  };
}

function verifyPendingAuthToken(token, secret) {
  const payload = parseSignedToken(token, secret);
  const username = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  const step = typeof payload?.step === 'string' ? payload.step.trim() : '';
  if (!username || !step) return null;
  if (!Number.isFinite(payload?.exp) || Date.now() > payload.exp) return null;
  return {
    username,
    step,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    tokenId: payload.jti,
    version: Number.isFinite(payload?.v) ? payload.v : 2,
  };
}

module.exports = {
  createAuthToken,
  createPendingAuthToken,
  parseSignedToken,
  verifyAuthToken,
  verifyPendingAuthToken,
};
