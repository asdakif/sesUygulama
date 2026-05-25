'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { hashPassword } = require('../server/auth');
const { createSessionManager } = require('../server/auth/sessions');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sesapp-refresh-'));
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

function createSessionHarness() {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');
  const db = loadDatabase({ dbFile, legacyFile });
  const created = db.createAccount('akif', hashPassword('Secret123!smoke'), { displayName: 'Akif' });
  const auditEvents = [];
  const disconnects = [];
  const sessions = createSessionManager({
    db,
    config: {
      authSecret: 'refresh-test-secret-key-that-is-at-least-32-bytes-long',
      accessTokenTtlMs: 15 * 60 * 1000,
      refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    },
    audit: {
      record(event, payload) {
        auditEvents.push({ event, payload });
      },
    },
    forceDisconnectUser(username, reason, message) {
      disconnects.push({ username, reason, message });
    },
  });

  return {
    db,
    tempDir,
    account: created.account,
    sessions,
    auditEvents,
    disconnects,
  };
}

test('refresh rotation issues a distinct token pair and marks the old token as replaced', () => {
  const harness = createSessionHarness();

  try {
    const first = harness.sessions.issueSession({
      account: harness.account,
      ip: '127.0.0.1',
      userAgent: 'rotation-test',
    });
    const rotated = harness.sessions.refreshSession({
      refreshToken: first.refreshToken,
      ip: '127.0.0.1',
      userAgent: 'rotation-test',
    });

    assert.equal(rotated.ok, true);
    assert.notEqual(rotated.accessToken, first.accessToken);
    assert.notEqual(rotated.refreshToken, first.refreshToken);
    assert.notEqual(rotated.refreshTokenId, first.refreshTokenId);
    assert.equal(rotated.familyId, first.familyId);

    const originalRow = harness.db.getRefreshToken(first.refreshTokenId);
    assert.equal(originalRow.replaced_by_token_id, rotated.refreshTokenId);
    assert.ok(originalRow.last_used_at >= originalRow.created_at);
  } finally {
    cleanupDatabaseModule(harness.db, harness.tempDir);
  }
});

test('refresh reuse kills the whole family and bumps token_version', () => {
  const harness = createSessionHarness();

  try {
    const first = harness.sessions.issueSession({
      account: harness.account,
      ip: '127.0.0.1',
      userAgent: 'reuse-test',
    });
    const rotated = harness.sessions.refreshSession({
      refreshToken: first.refreshToken,
      ip: '127.0.0.1',
      userAgent: 'reuse-test',
    });
    assert.equal(rotated.ok, true);

    const reused = harness.sessions.refreshSession({
      refreshToken: first.refreshToken,
      ip: '127.0.0.1',
      userAgent: 'reuse-test',
    });
    assert.equal(reused.ok, false);
    assert.equal(reused.code, 'refresh_reuse_detected');

    const refreshedAccount = harness.db.getAccount('akif');
    assert.equal(refreshedAccount.token_version, 2);
    assert.equal(harness.disconnects.length, 1);
    assert.equal(harness.disconnects[0].username, 'akif');
    assert.equal(harness.disconnects[0].reason, 'refresh_reuse_detected');
    assert.equal(
      harness.auditEvents.some((entry) => entry.event === 'refresh_reuse_detected'),
      true,
    );

    const rotatedRow = harness.db.getRefreshToken(rotated.refreshTokenId);
    assert.ok(rotatedRow.revoked_at);

    const afterFamilyKill = harness.sessions.refreshSession({
      refreshToken: rotated.refreshToken,
      ip: '127.0.0.1',
      userAgent: 'reuse-test',
    });
    assert.equal(afterFamilyKill.ok, false);
    assert.equal(afterFamilyKill.code, 'revoked_refresh');
  } finally {
    cleanupDatabaseModule(harness.db, harness.tempDir);
  }
});
