'use strict';

const { createAuditLogger } = require('./audit');
const { getDefaultParams, hashPassword, verifyPassword } = require('./hashing');
const { createLoginThrottle, getDelayMs } = require('./rate-limit');
const {
  createAuthToken,
  createPendingAuthToken,
  verifyAuthToken,
  verifyPendingAuthToken,
} = require('./tokens');
const {
  AUTH_CODE_REGEX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_REGEX,
  canonicalizeUsername,
  normalizeEmail,
  normalizeUsername,
  validateAuthCode,
  validateEmail,
  validateDisplayName,
  validatePassword,
  validateUsername,
} = require('./validators');

module.exports = {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_REGEX,
  canonicalizeUsername,
  createAuditLogger,
  createAuthToken,
  createPendingAuthToken,
  createLoginThrottle,
  getDefaultParams,
  getDelayMs,
  hashPassword,
  AUTH_CODE_REGEX,
  normalizeEmail,
  normalizeUsername,
  validateAuthCode,
  validateEmail,
  validateDisplayName,
  validatePassword,
  validateUsername,
  verifyAuthToken,
  verifyPendingAuthToken,
  verifyPassword,
};
