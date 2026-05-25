'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clearExpiredRecentTotpUsage,
  generateSecret,
  generateTotpCode,
  verifyTotpCode,
} = require('../server/auth/totp');

test('same totp code cannot be replayed within the replay window', () => {
  clearExpiredRecentTotpUsage(Number.MAX_SAFE_INTEGER);

  const secret = generateSecret();
  const now = 1_716_592_800_000;
  const username = `replay_${now}`;
  const code = generateTotpCode(secret, now);

  const first = verifyTotpCode({ secret, code, now, username });
  const second = verifyTotpCode({ secret, code, now, username });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'replayed_code');
});
