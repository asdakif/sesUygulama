'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { hashPassword, verifyPassword } = require('../server/auth');
const { createSessionManager } = require('../server/auth/sessions');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sesapp-account-'));
}

function loadDatabase({ dbFile, legacyFile }) {
  process.env.SESAPP_DB_FILE = dbFile;
  process.env.SESAPP_DATA_FILE = legacyFile;
  delete require.cache[require.resolve('../database')];
  return require('../database');
}

function cleanupDatabaseModule(db, tempDir) {
  try { db.close(); } catch {}
  delete require.cache[require.resolve('../database')];
  delete process.env.SESAPP_DB_FILE;
  delete process.env.SESAPP_DATA_FILE;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function createHarness() {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');
  const db = loadDatabase({ dbFile, legacyFile });
  const created = db.createAccount('akif', hashPassword('Secret123!smoke'), { displayName: 'Akif' });
  const sessions = createSessionManager({
    db,
    config: {
      authSecret: 'account-test-secret-key-that-is-at-least-32-bytes-long',
      accessTokenTtlMs: 15 * 60 * 1000,
      refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    },
    audit: { record() {} },
    forceDisconnectUser() {},
  });

  return {
    db,
    tempDir,
    account: created.account,
    sessions,
  };
}

test('password rotation updates hash, bumps token version, and revokes active sessions', () => {
  const harness = createHarness();

  try {
    const firstSession = harness.sessions.issueSession({
      account: harness.account,
      ip: '127.0.0.1',
      userAgent: 'device-a',
    });
    const secondSession = harness.sessions.issueSession({
      account: harness.account,
      ip: '127.0.0.2',
      userAgent: 'device-b',
    });

    assert.equal(harness.db.listActiveRefreshTokens('akif').length, 2);

    harness.db.updateAccountPasswordHash('akif', hashPassword('EvenStronger!456'));
    harness.sessions.revokeAllSessionsForUser({
      username: 'akif',
      accessTokenId: firstSession.accessTokenId,
      accessTokenExpiresAt: firstSession.accessTokenExpiresAt,
    });

    const refreshedAccount = harness.db.getAccount('akif');
    assert.equal(refreshedAccount.token_version, 2);
    assert.equal(verifyPassword('Secret123!smoke', refreshedAccount.password_hash).ok, false);
    assert.equal(verifyPassword('EvenStronger!456', refreshedAccount.password_hash).ok, true);
    assert.equal(harness.db.isTokenRevoked(firstSession.accessTokenId), true);
    assert.ok(harness.db.getRefreshToken(firstSession.refreshTokenId).revoked_at);
    assert.ok(harness.db.getRefreshToken(secondSession.refreshTokenId).revoked_at);
    assert.equal(harness.db.listActiveRefreshTokens('akif').length, 0);
  } finally {
    cleanupDatabaseModule(harness.db, harness.tempDir);
  }
});

test('active sessions list only current refresh rows and tracks current device by access token', () => {
  const harness = createHarness();

  try {
    const firstSession = harness.sessions.issueSession({
      account: harness.account,
      ip: '127.0.0.1',
      userAgent: 'device-a',
    });
    const secondSession = harness.sessions.issueSession({
      account: harness.account,
      ip: '127.0.0.2',
      userAgent: 'device-b',
    });

    const listed = harness.db.listActiveRefreshTokens('akif');
    assert.equal(listed.length, 2);
    assert.equal(
      harness.sessions.getRefreshTokenIdForAccessToken(firstSession.accessTokenId),
      firstSession.refreshTokenId,
    );
    assert.equal(
      harness.sessions.getRefreshTokenIdForAccessToken(secondSession.accessTokenId),
      secondSession.refreshTokenId,
    );

    harness.db.revokeRefreshToken(secondSession.refreshTokenId);
    const afterRevoke = harness.db.listActiveRefreshTokens('akif');
    assert.equal(afterRevoke.length, 1);
    assert.equal(afterRevoke[0].token_id, firstSession.refreshTokenId);
  } finally {
    cleanupDatabaseModule(harness.db, harness.tempDir);
  }
});

test('pending delete can be scheduled, cleared, and hard-pruned later', () => {
  const harness = createHarness();

  try {
    const pendingDeleteAt = Date.now() + (7 * 24 * 60 * 60 * 1000);
    harness.db.scheduleAccountDelete('akif', pendingDeleteAt);
    assert.equal(harness.db.getAccount('akif').pending_delete_at, pendingDeleteAt);

    harness.db.clearPendingAccountDelete('akif');
    assert.equal(harness.db.getAccount('akif').pending_delete_at, null);

    harness.db.scheduleAccountDelete('akif', Date.now() - 1_000);
    const deleted = harness.db.deleteExpiredPendingAccounts(Date.now());
    assert.deepEqual(deleted, ['akif']);
    assert.equal(harness.db.getAccount('akif'), null);
  } finally {
    cleanupDatabaseModule(harness.db, harness.tempDir);
  }
});
