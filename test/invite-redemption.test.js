'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sesapp-invite-'));
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

test('single-use invite can only create one account', () => {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');
  const db = loadDatabase({ dbFile, legacyFile });

  try {
    db.createAccount('admin', 'hash-1', { displayName: 'Admin' });
    db.setAccountRole('admin', 'admin');
    db.createInvite({
      inviteId: 'invite-1',
      code: 'H7K2-9XQP-3WMN',
      createdBy: 'admin',
      maxUses: 1,
      usesRemaining: 1,
      createdAt: Date.now(),
    });

    const first = db.createAccountWithInvite('akif', 'hash-akif', {
      displayName: 'Akif',
      inviteCode: 'H7K2-9XQP-3WMN',
      nowMs: Date.now(),
    });
    const second = db.createAccountWithInvite('zeynep', 'hash-zeynep', {
      displayName: 'Zeynep',
      inviteCode: 'H7K2-9XQP-3WMN',
      nowMs: Date.now(),
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'invalid_invite');
    assert.equal(db.getAccount('akif')?.username, 'akif');
    assert.equal(db.getAccount('zeynep'), null);
    assert.equal(db.getInviteById('invite-1')?.uses_remaining, 0);
  } finally {
    cleanupDatabaseModule(db, tempDir);
  }
});
