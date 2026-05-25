'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sesapp-admin-bootstrap-'));
}

function loadDatabase({ dbFile, legacyFile }) {
  process.env.SESAPP_DB_FILE = dbFile;
  process.env.SESAPP_DATA_FILE = legacyFile;
  delete require.cache[require.resolve('../database')];
  return require('../database');
}

function cleanupModules(db, tempDir) {
  try { db.close(); } catch {}
  delete require.cache[require.resolve('../database')];
  delete require.cache[require.resolve('../server/admin-bootstrap')];
  delete process.env.SESAPP_DB_FILE;
  delete process.env.SESAPP_DATA_FILE;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function loadServerHelper() {
  delete require.cache[require.resolve('../server/admin-bootstrap')];
  return require('../server/admin-bootstrap').bootstrapAdminRole;
}

test('bootstrapAdminRole promotes configured username to admin', () => {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');
  const db = loadDatabase({ dbFile, legacyFile });

  try {
    db.createAccount('akif', 'hash-akif', { displayName: 'Akif' });
    const bootstrapAdminRole = loadServerHelper();
    const events = [];
    bootstrapAdminRole({
      db,
      config: { bootstrapAdminUsername: 'akif' },
      audit: { record(event, meta) { events.push({ event, meta }); } },
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(db.getAccount('akif')?.role, 'admin');
    assert.equal(events[0]?.event, 'bootstrap_admin_set');
  } finally {
    cleanupModules(db, tempDir);
  }
});

test('bootstrapAdminRole promotes first account when no admins exist', () => {
  const tempDir = createTempDir();
  const legacyFile = path.join(tempDir, 'chat-data.json');
  const dbFile = path.join(tempDir, 'chat-data.sqlite');
  const db = loadDatabase({ dbFile, legacyFile });

  try {
    db.createAccount('akif', 'hash-akif', { displayName: 'Akif' });
    db.createAccount('zeynep', 'hash-zeynep', { displayName: 'Zeynep' });
    const bootstrapAdminRole = loadServerHelper();
    const events = [];
    bootstrapAdminRole({
      db,
      config: { bootstrapAdminUsername: '' },
      audit: { record(event, meta) { events.push({ event, meta }); } },
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(db.getAccount('akif')?.role, 'admin');
    assert.equal(db.getAccount('zeynep')?.role, 'user');
    assert.equal(events[0]?.event, 'bootstrap_admin_first_user');
  } finally {
    cleanupModules(db, tempDir);
  }
});
