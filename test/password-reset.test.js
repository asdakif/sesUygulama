'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { hashPassword, verifyPassword } = require('../server/auth');
const { createSessionManager } = require('../server/auth/sessions');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sesapp-reset-'));
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
  db.setAccountEmail('akif', 'akif@example.com', Date.now());
  const sessions = createSessionManager({
    db,
    config: {
      authSecret: 'reset-test-secret-key-that-is-at-least-32-bytes-long',
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

test('password reset token use rotates password and revokes active sessions', () => {
  const harness = createHarness();

  try {
    const session = harness.sessions.issueSession({
      account: harness.db.getAccount('akif'),
      ip: '127.0.0.1',
      userAgent: 'device-a',
    });

    harness.db.insertPasswordResetToken({
      tokenId: 'reset-1',
      tokenHash: 'hashed-reset-token',
      accountUsername: 'akif',
      createdAt: Date.now(),
      expiresAt: Date.now() + (60 * 60 * 1000),
      requestIp: '127.0.0.1',
    });

    harness.db.completePasswordReset({
      tokenId: 'reset-1',
      username: 'akif',
      passwordHash: hashPassword('Secret456!reset'),
      usedAt: Date.now(),
    });

    const resetRow = harness.db.getPasswordResetToken('reset-1');
    const refreshedAccount = harness.db.getAccount('akif');
    assert.ok(resetRow.used_at);
    assert.equal(refreshedAccount.token_version, 2);
    assert.equal(verifyPassword('Secret123!smoke', refreshedAccount.password_hash).ok, false);
    assert.equal(verifyPassword('Secret456!reset', refreshedAccount.password_hash).ok, true);
    assert.ok(harness.db.getRefreshToken(session.refreshTokenId).revoked_at);
  } finally {
    cleanupDatabaseModule(harness.db, harness.tempDir);
  }
});

test('active password reset tokens can be listed and invalidated', () => {
  const harness = createHarness();

  try {
    const now = Date.now();
    harness.db.insertPasswordResetToken({
      tokenId: 'reset-old',
      tokenHash: 'old-hash',
      accountUsername: 'akif',
      createdAt: now - 10_000,
      expiresAt: now + (60 * 60 * 1000),
      requestIp: '127.0.0.1',
    });
    harness.db.insertPasswordResetToken({
      tokenId: 'reset-new',
      tokenHash: 'new-hash',
      accountUsername: 'akif',
      createdAt: now,
      expiresAt: now + (60 * 60 * 1000),
      requestIp: '127.0.0.1',
    });

    const listed = harness.db.listActivePasswordResetTokens('akif', now);
    assert.deepEqual(listed.map((row) => row.token_id), ['reset-old', 'reset-new']);

    harness.db.markPasswordResetTokenUsed('reset-old', now + 500);
    const activeAfterUse = harness.db.listActivePasswordResetTokens('akif', now + 1_000);
    assert.deepEqual(activeAfterUse.map((row) => row.token_id), ['reset-new']);
  } finally {
    cleanupDatabaseModule(harness.db, harness.tempDir);
  }
});
