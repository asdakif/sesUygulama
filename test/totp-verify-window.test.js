'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  generateSecret,
  generateTotpCode,
  verifyTotpCode,
} = require('../server/auth');

test('totp verification accepts +/- one step and rejects two-step drift', () => {
  const secret = generateSecret();
  const now = 1_716_592_800_000;

  const previousCode = generateTotpCode(secret, now - 30_000);
  const currentCode = generateTotpCode(secret, now);
  const nextCode = generateTotpCode(secret, now + 30_000);
  const tooOldCode = generateTotpCode(secret, now - 60_000);
  const tooFutureCode = generateTotpCode(secret, now + 60_000);

  assert.equal(verifyTotpCode({ secret, code: previousCode, now }).ok, true);
  assert.equal(verifyTotpCode({ secret, code: currentCode, now }).ok, true);
  assert.equal(verifyTotpCode({ secret, code: nextCode, now }).ok, true);
  assert.equal(verifyTotpCode({ secret, code: tooOldCode, now }).ok, false);
  assert.equal(verifyTotpCode({ secret, code: tooFutureCode, now }).ok, false);
});
