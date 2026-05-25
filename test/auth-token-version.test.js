'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAuthToken, verifyAuthToken } = require('../server/auth');
const { resolveAuthSession } = require('../server/auth-middleware');

test('resolveAuthSession rejects stale token versions', () => {
  const secret = 'middleware-secret-key-that-is-at-least-32-bytes-long';
  const token = createAuthToken({
    username: 'akif',
    secret,
    ttlMs: 60_000,
    tokenVersion: 1,
  });

  const result = resolveAuthSession({
    token,
    verifyAuthToken,
    secret,
    db: {
      isTokenRevoked() {
        return false;
      },
      getAccount() {
        return {
          username: 'akif',
          token_version: 2,
          role: 'user',
          display_name: 'Akif',
          disabled_at: null,
          locked_until: null,
        };
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'stale_token');
});
