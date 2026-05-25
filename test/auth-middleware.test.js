'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAuthToken, verifyAuthToken } = require('../server/auth');
const {
  createHttpAuthMiddleware,
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
    secret: 'middleware-secret-key-that-is-at-least-32-bytes-long',
    ttlMs: 60_000,
    tokenVersion: 1,
  });

  const valid = resolveAuthSession({
    token,
    verifyAuthToken,
    secret: 'middleware-secret-key-that-is-at-least-32-bytes-long',
    db: {
      isTokenRevoked() {
        return false;
      },
      getAccount(username) {
        return username === 'akif'
          ? { username, token_version: 1, role: 'user', display_name: 'Akif', disabled_at: null, locked_until: null }
          : null;
      },
    },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.session.username, 'akif');
  assert.equal(valid.session.role, 'user');

  const revoked = resolveAuthSession({
    token,
    verifyAuthToken,
    secret: 'middleware-secret-key-that-is-at-least-32-bytes-long',
    db: {
      isTokenRevoked() {
        return true;
      },
      getAccount(username) {
        return username === 'akif'
          ? { username, token_version: 1, role: 'user', display_name: 'Akif', disabled_at: null, locked_until: null }
          : null;
      },
    },
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.code, 'revoked_session');
});

test('resolveAuthSession returns a refresh hint for legacy tokens before the cutoff', () => {
  const token = createAuthToken({
    username: 'akif',
    secret: 'middleware-secret-key-that-is-at-least-32-bytes-long',
    ttlMs: 60_000,
    tokenVersion: 1,
    schemaVersion: 1,
  });

  const valid = resolveAuthSession({
    token,
    verifyAuthToken,
    secret: 'middleware-secret-key-that-is-at-least-32-bytes-long',
    legacyTokenGraceUntil: Date.now() + 60_000,
    db: {
      isTokenRevoked() {
        return false;
      },
      getAccount(username) {
        return username === 'akif'
          ? { username, token_version: 1, role: 'user', display_name: 'Akif', disabled_at: null, locked_until: null }
          : null;
      },
    },
  });

  assert.equal(valid.ok, true);
  assert.equal(valid.migrateHint, 'refresh');
  assert.equal(valid.session.isLegacy, true);
});

test('resolveAuthSession rejects legacy tokens after the cutoff', () => {
  const token = createAuthToken({
    username: 'akif',
    secret: 'middleware-secret-key-that-is-at-least-32-bytes-long',
    ttlMs: 60_000,
    tokenVersion: 1,
    schemaVersion: 1,
  });

  const rejected = resolveAuthSession({
    token,
    verifyAuthToken,
    secret: 'middleware-secret-key-that-is-at-least-32-bytes-long',
    legacyTokenGraceUntil: Date.now() - 60_000,
    db: {
      isTokenRevoked() {
        return false;
      },
      getAccount(username) {
        return username === 'akif'
          ? { username, token_version: 1, role: 'user', display_name: 'Akif', disabled_at: null, locked_until: null }
          : null;
      },
    },
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'legacy_token');
});

test('createHttpAuthMiddleware sets an auth migration hint for legacy tokens', () => {
  const token = createAuthToken({
    username: 'akif',
    secret: 'middleware-secret-key-that-is-at-least-32-bytes-long',
    ttlMs: 60_000,
    tokenVersion: 1,
    schemaVersion: 1,
  });
  const auditEvents = [];
  const { requireAuth } = createHttpAuthMiddleware({
    verifyAuthToken,
    secret: 'middleware-secret-key-that-is-at-least-32-bytes-long',
    legacyTokenGraceUntil: Date.now() + 60_000,
    audit: {
      record(event, payload) {
        auditEvents.push({ event, payload });
      },
    },
    db: {
      isTokenRevoked() {
        return false;
      },
      getAccount(username) {
        return username === 'akif'
          ? { username, token_version: 1, role: 'user', display_name: 'Akif', disabled_at: null, locked_until: null }
          : null;
      },
    },
  });

  const req = {
    headers: { authorization: `Bearer ${token}` },
    ip: '127.0.0.1',
    get(name) {
      return name === 'user-agent' ? 'middleware-test' : null;
    },
  };
  const res = {
    headers: {},
    set(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
    },
  };
  let nextCalled = false;

  requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.headers['X-Auth-Migrate'], 'refresh');
  assert.equal(req.auth.username, 'akif');
  assert.equal(auditEvents[0]?.event, 'legacy_token_used');
});
