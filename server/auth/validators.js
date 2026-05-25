'use strict';

const fs = require('fs');
const path = require('path');

const USERNAME_REGEX = /^[a-z0-9_]{2,20}$/;
const DISPLAY_NAME_MAX_LENGTH = 32;
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const ZERO_WIDTH_REGEX = /[\u200B-\u200D\uFEFF]/;
const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_CODE_REGEX = /^\d{6}$/;

const breachedPasswords = new Set(fs.readFileSync(path.join(__dirname, 'breached-passwords.txt'), 'utf8')
  .split(/\r?\n/)
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean));

let zxcvbnFn = null;
function getZxcvbn() {
  if (!zxcvbnFn) zxcvbnFn = require('zxcvbn');
  return zxcvbnFn;
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalizeUsername(value) {
  const normalized = normalizeUsername(value).toLowerCase();
  return USERNAME_REGEX.test(normalized) ? normalized : null;
}

function validateDisplayName(value) {
  if (typeof value !== 'string') return { ok: false, message: 'Görünen ad gerekli.' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: 'Görünen ad gerekli.' };
  if (trimmed.length < 2 || trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, message: `Görünen ad 2-${DISPLAY_NAME_MAX_LENGTH} karakter arasında olmalı.` };
  }
  if (CONTROL_CHAR_REGEX.test(trimmed) || ZERO_WIDTH_REGEX.test(trimmed)) {
    return { ok: false, message: 'Görünen adda görünmez veya kontrol karakterleri kullanılamaz.' };
  }
  return { ok: true, displayName: trimmed };
}

function validateUsername(value) {
  const username = canonicalizeUsername(value);
  if (!username) {
    return {
      ok: false,
      message: 'Kullanıcı adı 2-20 karakter olmalı ve yalnızca küçük harf, rakam ve alt çizgi içermeli.',
    };
  }

  const displayNameResult = validateDisplayName(normalizeUsername(value));
  return {
    ok: true,
    username,
    displayName: displayNameResult.ok ? displayNameResult.displayName : username,
  };
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return { ok: false, message: 'E-posta gerekli.' };
  if (email.length > EMAIL_MAX_LENGTH) {
    return { ok: false, message: `E-posta en fazla ${EMAIL_MAX_LENGTH} karakter olabilir.` };
  }
  if (!EMAIL_REGEX.test(email)) {
    return { ok: false, message: 'Geçerli bir e-posta adresi gir.' };
  }
  return { ok: true, email };
}

function validatePassword(password, context = {}) {
  if (typeof password !== 'string' || !password.length) {
    return { ok: false, message: 'Şifre gerekli.' };
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      message: `Şifre ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} karakter arasında olmalı.`,
    };
  }

  if (breachedPasswords.has(password.trim().toLowerCase())) {
    return { ok: false, message: 'Bu şifre çok yaygın veya güvensiz. Daha güçlü bir şifre seç.' };
  }

  const zxcvbn = getZxcvbn();
  const score = zxcvbn(password, [context.username, context.displayName].filter(Boolean)).score;
  if (score < 2) {
    return { ok: false, message: 'Şifre çok zayıf. Daha uzun ve tahmin edilmesi zor bir şifre seç.' };
  }

  return { ok: true };
}

function validateAuthCode(value) {
  const normalized = String(value || '').replace(/\s+/g, '').trim();
  if (!AUTH_CODE_REGEX.test(normalized)) {
    return { ok: false, message: '6 haneli doğrulama kodunu gir.' };
  }
  return { ok: true, code: normalized };
}

module.exports = {
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  EMAIL_REGEX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_REGEX,
  AUTH_CODE_REGEX,
  canonicalizeUsername,
  normalizeEmail,
  normalizeUsername,
  validateEmail,
  validateDisplayName,
  validateAuthCode,
  validatePassword,
  validateUsername,
};
