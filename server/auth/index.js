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
  generateOtpauthUrl,
  generateRecoveryCodes,
  generateSecret,
  generateTotpCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  normalizeTotpCode,
  renderQrSvg,
  verifyTotpCode,
} = require('./totp');
const {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RECOVERY_CODE_REGEX,
  TOTP_CODE_REGEX,
  USERNAME_REGEX,
  canonicalizeUsername,
  normalizeEmail,
  normalizeUsername,
  validateEmail,
  validateDisplayName,
  validatePassword,
  validateRecoveryCode,
  validateTotpCode,
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
  generateOtpauthUrl,
  generateRecoveryCodes,
  generateSecret,
  generateTotpCode,
  getDefaultParams,
  getDelayMs,
  hashPassword,
  hashRecoveryCode,
  normalizeEmail,
  normalizeRecoveryCode,
  normalizeTotpCode,
  normalizeUsername,
  RECOVERY_CODE_REGEX,
  renderQrSvg,
  validateEmail,
  validateDisplayName,
  validatePassword,
  validateRecoveryCode,
  validateTotpCode,
  validateUsername,
  verifyAuthToken,
  verifyPendingAuthToken,
  verifyPassword,
  verifyTotpCode,
  TOTP_CODE_REGEX,
};
