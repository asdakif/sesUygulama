'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sesapp-migrate-'));
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

test('migration runner applies full auth schema and bumps user_version', () => {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');
  const db = loadDatabase({ dbFile, legacyFile });

  const rawDb = new DatabaseSync(dbFile);
  const version = rawDb.prepare('PRAGMA user_version').get().user_version;
  const accountColumns = rawDb.prepare('PRAGMA table_info(accounts)').all().map((row) => row.name);
  const refreshTableCount = rawDb.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name = 'refresh_tokens'
  `).get().count;
  const emailChallengeTableCount = rawDb.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name = 'email_auth_challenges'
  `).get().count;
  rawDb.close();

  assert.equal(version, 11);
  assert.ok(accountColumns.includes('display_name'));
  assert.ok(accountColumns.includes('token_version'));
  assert.ok(accountColumns.includes('locked_until'));
  assert.ok(accountColumns.includes('email'));
  assert.ok(accountColumns.includes('pending_delete_at'));
  assert.equal(refreshTableCount, 1);
  assert.equal(emailChallengeTableCount, 1);

  cleanupDatabaseModule(db, tempDir);
});
