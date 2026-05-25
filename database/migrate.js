'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function getMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function getCurrentVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version || 0);
}

function setCurrentVersion(db, version) {
  db.exec(`PRAGMA user_version = ${Number(version)}`);
}

function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function ensureColumn(db, tableName, columnName, definition) {
  if (getTableColumns(db, tableName).includes(columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function applyBuiltInMigration(db, version) {
  switch (version) {
    case 2:
      ensureColumn(db, 'accounts', 'display_name', 'TEXT');
      ensureColumn(db, 'accounts', 'token_version', 'INTEGER NOT NULL DEFAULT 1');
      ensureColumn(db, 'accounts', 'role', "TEXT NOT NULL DEFAULT 'user'");
      ensureColumn(db, 'accounts', 'disabled_at', 'INTEGER');
      ensureColumn(db, 'accounts', 'failed_login_count', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'accounts', 'locked_until', 'INTEGER');
      break;
    case 6:
      ensureColumn(db, 'accounts', 'email', 'TEXT');
      ensureColumn(db, 'accounts', 'email_verified_at', 'INTEGER');
      ensureColumn(db, 'accounts', 'email_pending', 'TEXT');
      ensureColumn(db, 'accounts', 'email_pending_token_hash', 'TEXT');
      ensureColumn(db, 'accounts', 'email_pending_expires_at', 'INTEGER');
      break;
    case 8:
      ensureColumn(db, 'accounts', 'totp_secret', 'TEXT');
      ensureColumn(db, 'accounts', 'totp_enabled_at', 'INTEGER');
      break;
    case 10:
      ensureColumn(db, 'accounts', 'pending_delete_at', 'INTEGER');
      break;
    default:
      break;
  }
}

function runMigrations(db, logger = console) {
  const files = getMigrationFiles();
  let currentVersion = getCurrentVersion(db);

  for (const fileName of files) {
    const version = Number(fileName.split('_', 1)[0]);
    if (version <= currentVersion) continue;

    const migrationSql = fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), 'utf8');
    db.exec('BEGIN');
    try {
      if (migrationSql.trim()) db.exec(migrationSql);
      applyBuiltInMigration(db, version);
      setCurrentVersion(db, version);
      db.exec('COMMIT');
      if (typeof logger?.info === 'function') {
        logger.info('migration_applied', { from: currentVersion, to: version, file: fileName });
      }
      currentVersion = version;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

module.exports = {
  MIGRATIONS_DIR,
  getCurrentVersion,
  runMigrations,
};
