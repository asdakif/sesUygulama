'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sesapp-db-'));
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

test('database seeds default channels for a new SQLite store', () => {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');
  const db = loadDatabase({ dbFile, legacyFile });

  assert.equal(db.getChannels().length, 4);
  assert.deepEqual(
    db.getChannels().map((channel) => channel.name),
    ['genel', 'oyun', 'müzik', 'duyurular'],
  );

  cleanupDatabaseModule(db, tempDir);
});

test('database migrates legacy JSON content into SQLite', () => {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');

  const legacyData = {
    channels: [
      { id: 1, name: 'genel', description: 'Genel sohbet kanalı' },
      { id: 9, name: 'test', description: 'Test kanalı' },
    ],
    messages: [
      {
        id: 3,
        channel_id: 9,
        username: 'akif',
        content: 'Merhaba',
        created_at: 1_700_000_000,
        reactions: { '🔥': ['mehmet'] },
      },
    ],
    dms: [
      {
        id: 7,
        from: 'akif',
        to: 'mehmet',
        content: 'Selam',
        created_at: 1_700_000_100,
      },
    ],
    users: ['akif', 'mehmet'],
    nextMessageId: 4,
    nextDmId: 8,
  };
  fs.writeFileSync(legacyFile, JSON.stringify(legacyData, null, 2), 'utf8');

  const db = loadDatabase({ dbFile, legacyFile });

  const migratedMessages = db.getMessages(9);
  assert.equal(migratedMessages.length, 1);
  assert.equal(migratedMessages[0].content, 'Merhaba');
  assert.deepEqual(migratedMessages[0].reactions, { '🔥': ['mehmet'] });

  const migratedDms = db.getDms('mehmet', 'akif');
  assert.equal(migratedDms.length, 1);
  assert.equal(migratedDms[0].content, 'Selam');

  const inserted = db.insertMessage(9, 'mehmet', 'Yeni mesaj');
  assert.equal(inserted.id, 4);

  cleanupDatabaseModule(db, tempDir);
});

test('database toggles reactions idempotently', () => {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');
  const db = loadDatabase({ dbFile, legacyFile });

  const message = db.insertMessage(1, 'akif', 'Selam');
  const afterAdd = db.toggleReaction(message.id, 'mehmet', '👍');
  assert.deepEqual(afterAdd.reactions, { '👍': ['mehmet'] });

  const afterRemove = db.toggleReaction(message.id, 'mehmet', '👍');
  assert.deepEqual(afterRemove.reactions, {});

  cleanupDatabaseModule(db, tempDir);
});

test('database stores real account credentials separately from user presence', () => {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');
  const db = loadDatabase({ dbFile, legacyFile });

  const created = db.createAccount('akif', 'hashed-password');
  assert.equal(created.ok, true);
  assert.equal(db.getAccount('akif').password_hash, 'hashed-password');

  const duplicate = db.createAccount('akif', 'another-hash');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'account_exists');

  db.touchAccountLogin('akif');
  assert.ok(db.getAccount('akif').last_login_at >= created.account.last_login_at);
  db.revokeToken('token-1', Date.now() + 10_000);
  assert.equal(db.isTokenRevoked('token-1'), true);
  assert.equal(db.isTokenRevoked('token-2'), false);

  cleanupDatabaseModule(db, tempDir);
});
