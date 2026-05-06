'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAuthToken, verifyAuthToken } = require('../server/auth');
const {
  extractBearerToken,
  resolveAuthSession,
} = require('../server/auth-middleware');

test('extractBearerToken parses bearer header safely', () => {
  assert.equal(extractBearerToken('Bearer abc.def'), 'abc.def');
  assert.equal(extractBearerToken('bearer xyz'), 'xyz');
  assert.equal(extractBearerToken('Token nope'), null);
  assert.equal(extractBearerToken(null), null);
});

test('resolveAuthSession rejects revoked tokens and accepts valid accounts', () => {
  const token = createAuthToken({
    username: 'akif',
    secret: 'middleware-secret',
    ttlMs: 60_000,
  });

  const valid = resolveAuthSession({
    token,
    verifyAuthToken,
    secret: 'middleware-secret',
    db: {
      isTokenRevoked() {
        return false;
      },
      getAccount(username) {
        return username === 'akif' ? { username } : null;
      },
    },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.session.username, 'akif');

  const revoked = resolveAuthSession({
    token,
    verifyAuthToken,
    secret: 'middleware-secret',
    db: {
      isTokenRevoked() {
        return true;
      },
      getAccount(username) {
        return username === 'akif' ? { username } : null;
      },
    },
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.code, 'revoked_session');
});
