'use strict';

const crypto = require('crypto');

const DEFAULT_SCRYPT_PARAMS = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  dkLen: 64,
});

function getDefaultParams() {
  return { ...DEFAULT_SCRYPT_PARAMS };
}

function buildScryptOptions(params = DEFAULT_SCRYPT_PARAMS) {
  return {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  };
}

function encodeParamString(params) {
  return `N=${params.N},r=${params.r},p=${params.p}`;
}

function parseParamString(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return null;
  const pairs = Object.create(null);
  for (const part of rawValue.split(',')) {
    const [key, value] = part.split('=');
    if (!key || !value) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    pairs[key.trim()] = parsed;
  }
  if (!pairs.N || !pairs.r || !pairs.p) return null;
  return {
    N: pairs.N,
    r: pairs.r,
    p: pairs.p,
    dkLen: DEFAULT_SCRYPT_PARAMS.dkLen,
  };
}

function hashPassword(password, params = DEFAULT_SCRYPT_PARAMS) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, params.dkLen, buildScryptOptions(params));
  return [
    'scrypt',
    encodeParamString(params),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

function verifyLegacyHash(password, storedHash) {
  const parts = storedHash.split('$');
  if (parts.length !== 3) return { ok: false, needsRehash: false };

  const [, saltHex, expectedHashHex] = parts;
  if (!saltHex || !expectedHashHex) return { ok: false, needsRehash: false };

  try {
    const actualHash = crypto.scryptSync(password, saltHex, expectedHashHex.length / 2);
    const expectedHash = Buffer.from(expectedHashHex, 'hex');
    if (actualHash.length !== expectedHash.length) return { ok: false, needsRehash: false };
    return {
      ok: crypto.timingSafeEqual(actualHash, expectedHash),
      needsRehash: true,
    };
  } catch {
    return { ok: false, needsRehash: false };
  }
}

function verifyVersionedHash(password, storedHash) {
  const parts = storedHash.split('$');
  if (parts.length !== 4) return { ok: false, needsRehash: false };

  const [, rawParams, saltEncoded, expectedEncoded] = parts;
  const params = parseParamString(rawParams);
  if (!params || !saltEncoded || !expectedEncoded) return { ok: false, needsRehash: false };

  try {
    const salt = Buffer.from(saltEncoded, 'base64url');
    const expectedHash = Buffer.from(expectedEncoded, 'base64url');
    const actualHash = crypto.scryptSync(password, salt, expectedHash.length, buildScryptOptions(params));
    if (actualHash.length !== expectedHash.length) return { ok: false, needsRehash: false };
    const ok = crypto.timingSafeEqual(actualHash, expectedHash);
    return {
      ok,
      needsRehash: ok && encodeParamString(params) !== encodeParamString(DEFAULT_SCRYPT_PARAMS),
    };
  } catch {
    return { ok: false, needsRehash: false };
  }
}

function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash.startsWith('scrypt$')) {
    return { ok: false, needsRehash: false };
  }

  const parts = storedHash.split('$');
  if (parts.length === 3) return verifyLegacyHash(password, storedHash);
  if (parts.length === 4) return verifyVersionedHash(password, storedHash);
  return { ok: false, needsRehash: false };
}

module.exports = {
  DEFAULT_SCRYPT_PARAMS,
  getDefaultParams,
  hashPassword,
  parseParamString,
  verifyPassword,
};
