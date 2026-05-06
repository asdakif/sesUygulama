/**
 * SQLite-backed persistence layer with one-time legacy JSON migration.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const LEGACY_DATA_FILE = process.env.SESAPP_DATA_FILE || path.join(__dirname, 'chat-data.json');
const DB_FILE = process.env.SESAPP_DB_FILE || LEGACY_DATA_FILE.replace(/\.json$/i, '.sqlite');

const defaultChannels = [
  { id: 1, name: 'genel', description: 'Genel sohbet kanalı' },
  { id: 2, name: 'oyun', description: 'Oyun konuşmaları' },
  { id: 3, name: 'müzik', description: 'Müzik önerileri' },
  { id: 4, name: 'duyurular', description: 'Önemli duyurular' },
];

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readLegacyJson() {
  if (!fs.existsSync(LEGACY_DATA_FILE) || LEGACY_DATA_FILE === DB_FILE) return null;
  try {
    return JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

ensureDir(DB_FILE);

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS revoked_tokens (
    token_id TEXT PRIMARY KEY,
    revoked_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (message_id, emoji, username),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS dms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const countTableStmt = db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ? AND name = ?');
const countRowsStmt = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`);
const insertChannelStmt = db.prepare(`
  INSERT INTO channels (id, name, description)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description
`);
const insertUserStmt = db.prepare('INSERT OR IGNORE INTO users (username) VALUES (?)');
const insertAccountStmt = db.prepare(`
  INSERT INTO accounts (username, password_hash, created_at, last_login_at)
  VALUES (?, ?, ?, ?)
`);
const selectAccountByUsernameStmt = db.prepare(`
  SELECT username, password_hash, created_at, last_login_at
  FROM accounts
  WHERE username = ?
`);
const updateAccountLoginStmt = db.prepare(`
  UPDATE accounts
  SET last_login_at = ?
  WHERE username = ?
`);
const insertRevokedTokenStmt = db.prepare(`
  INSERT OR REPLACE INTO revoked_tokens (token_id, revoked_at, expires_at)
  VALUES (?, ?, ?)
`);
const selectRevokedTokenStmt = db.prepare(`
  SELECT token_id
  FROM revoked_tokens
  WHERE token_id = ?
`);
const pruneRevokedTokensStmt = db.prepare(`
  DELETE FROM revoked_tokens
  WHERE expires_at <= ?
`);
const insertMessageStmt = db.prepare(`
  INSERT INTO messages (channel_id, username, content, created_at)
  VALUES (?, ?, ?, ?)
`);
const insertMessageWithIdStmt = db.prepare(`
  INSERT INTO messages (id, channel_id, username, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const selectMessageByIdStmt = db.prepare(`
  SELECT id, channel_id, username, content, created_at
  FROM messages
  WHERE id = ?
`);
const selectChannelByIdStmt = db.prepare(`
  SELECT id, name, description
  FROM channels
  WHERE id = ?
`);
const selectChannelsStmt = db.prepare(`
  SELECT id, name, description
  FROM channels
  ORDER BY id ASC
`);
const selectMessagesStmt = db.prepare(`
  SELECT id, channel_id, username, content, created_at
  FROM (
    SELECT id, channel_id, username, content, created_at
    FROM messages
    WHERE channel_id = ?
    ORDER BY id DESC
    LIMIT ?
  )
  ORDER BY id ASC
`);
const selectDmsStmt = db.prepare(`
  SELECT id, from_user, to_user, content, created_at
  FROM (
    SELECT id, from_user, to_user, content, created_at
    FROM dms
    WHERE
      (from_user = ? AND to_user = ?)
      OR
      (from_user = ? AND to_user = ?)
    ORDER BY id DESC
    LIMIT ?
  )
  ORDER BY id ASC
`);
const insertDmStmt = db.prepare(`
  INSERT INTO dms (from_user, to_user, content, created_at)
  VALUES (?, ?, ?, ?)
`);
const insertDmWithIdStmt = db.prepare(`
  INSERT INTO dms (id, from_user, to_user, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const selectReactionStmt = db.prepare(`
  SELECT 1
  FROM message_reactions
  WHERE message_id = ? AND emoji = ? AND username = ?
`);
const addReactionStmt = db.prepare(`
  INSERT OR IGNORE INTO message_reactions (message_id, emoji, username)
  VALUES (?, ?, ?)
`);
const deleteReactionStmt = db.prepare(`
  DELETE FROM message_reactions
  WHERE message_id = ? AND emoji = ? AND username = ?
`);

function tableExists(name) {
  return Boolean(countTableStmt.get('table', name)?.count);
}

function isDatabaseEmpty() {
  if (!tableExists('channels')) return true;
  return (
    countRowsStmt('channels').get().count === 0 &&
    countRowsStmt('messages').get().count === 0 &&
    countRowsStmt('dms').get().count === 0 &&
    countRowsStmt('users').get().count === 0
  );
}

function setMetadata(key, value) {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function seedDefaultChannels() {
  for (const channel of defaultChannels) {
    insertChannelStmt.run(channel.id, channel.name, channel.description || '');
  }
}

function syncAutoincrementSequence(table, lastId) {
  db.prepare('INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, lastId);
}

function runInTransaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function migrateLegacyJsonIfNeeded() {
  if (!isDatabaseEmpty()) return;

  const legacy = readLegacyJson();
  if (!legacy) {
    seedDefaultChannels();
    return;
  }

  runInTransaction(() => {
    const channels = Array.isArray(legacy.channels) && legacy.channels.length
      ? legacy.channels
      : defaultChannels;

    for (const channel of channels) {
      insertChannelStmt.run(channel.id, channel.name, channel.description || '');
    }

    for (const username of legacy.users || []) {
      if (typeof username === 'string' && username.trim()) {
        insertUserStmt.run(username.trim());
      }
    }

    let maxMessageId = 0;
    for (const msg of legacy.messages || []) {
      const createdAt = Number(msg.created_at) || Math.floor(Date.now() / 1000);
      insertMessageWithIdStmt.run(
        msg.id,
        msg.channel_id,
        msg.username,
        msg.content,
        createdAt,
      );
      maxMessageId = Math.max(maxMessageId, Number(msg.id) || 0);

      const reactions = msg.reactions || {};
      for (const [emoji, users] of Object.entries(reactions)) {
        for (const username of users || []) {
          addReactionStmt.run(msg.id, emoji, username);
        }
      }
    }

    let maxDmId = 0;
    for (const dm of legacy.dms || []) {
      const createdAt = Number(dm.created_at) || Math.floor(Date.now() / 1000);
      insertDmWithIdStmt.run(dm.id, dm.from, dm.to, dm.content, createdAt);
      maxDmId = Math.max(maxDmId, Number(dm.id) || 0);
      if (typeof dm.from === 'string' && dm.from.trim()) insertUserStmt.run(dm.from.trim());
      if (typeof dm.to === 'string' && dm.to.trim()) insertUserStmt.run(dm.to.trim());
    }

    if (maxMessageId > 0) syncAutoincrementSequence('messages', maxMessageId);
    if (maxDmId > 0) syncAutoincrementSequence('dms', maxDmId);
    setMetadata('legacyMigrationSource', LEGACY_DATA_FILE);
    setMetadata('legacyMigrationAt', String(Date.now()));
  });
}

function getReactionsForMessageIds(messageIds) {
  if (!messageIds.length) return new Map();

  const placeholders = messageIds.map(() => '?').join(', ');
  const stmt = db.prepare(`
    SELECT message_id, emoji, username
    FROM message_reactions
    WHERE message_id IN (${placeholders})
    ORDER BY message_id ASC, emoji ASC, username ASC
  `);

  const grouped = new Map();
  for (const row of stmt.all(...messageIds)) {
    if (!grouped.has(row.message_id)) grouped.set(row.message_id, {});
    const messageReactions = grouped.get(row.message_id);
    if (!messageReactions[row.emoji]) messageReactions[row.emoji] = [];
    messageReactions[row.emoji].push(row.username);
  }

  return grouped;
}

function hydrateMessage(messageRow, reactionsByMessageId) {
  return {
    id: messageRow.id,
    channel_id: messageRow.channel_id,
    username: messageRow.username,
    content: messageRow.content,
    created_at: messageRow.created_at,
    reactions: reactionsByMessageId.get(messageRow.id) || {},
  };
}

migrateLegacyJsonIfNeeded();
pruneRevokedTokensStmt.run(Date.now());

process.on('exit', () => {
  try { db.close(); } catch {}
});

module.exports = {
  DB_FILE,
  LEGACY_DATA_FILE,

  getChannels() {
    return selectChannelsStmt.all();
  },

  getChannelById(id) {
    return selectChannelByIdStmt.get(id) || null;
  },

  getMessages(channelId, limit = 60) {
    const rows = selectMessagesStmt.all(channelId, limit);
    const reactions = getReactionsForMessageIds(rows.map(row => row.id));
    return rows.map(row => hydrateMessage(row, reactions));
  },

  insertMessage(channelId, username, content) {
    const createdAt = Math.floor(Date.now() / 1000);
    const result = insertMessageStmt.run(channelId, username, content, createdAt);
    const messageId = Number(result.lastInsertRowid);
    const row = selectMessageByIdStmt.get(messageId);
    return hydrateMessage(row, new Map());
  },

  toggleReaction(messageId, username, emoji) {
    const messageRow = selectMessageByIdStmt.get(messageId);
    if (!messageRow) return null;

    if (selectReactionStmt.get(messageId, emoji, username)) {
      deleteReactionStmt.run(messageId, emoji, username);
    } else {
      addReactionStmt.run(messageId, emoji, username);
    }

    const reactions = getReactionsForMessageIds([messageId]);
    return hydrateMessage(messageRow, reactions);
  },

  getDmKey(userA, userB) {
    return [userA, userB].sort().join(':');
  },

  getDms(userA, userB, limit = 60) {
    return selectDmsStmt.all(userA, userB, userB, userA, limit).map((row) => ({
      id: row.id,
      from: row.from_user,
      to: row.to_user,
      content: row.content,
      created_at: row.created_at,
    }));
  },

  insertDm(from, to, content) {
    const createdAt = Math.floor(Date.now() / 1000);
    const result = insertDmStmt.run(from, to, content, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      from,
      to,
      content,
      created_at: createdAt,
    };
  },

  ensureUser(username) {
    insertUserStmt.run(username);
  },

  getAccount(username) {
    return selectAccountByUsernameStmt.get(username) || null;
  },

  createAccount(username, passwordHash) {
    if (selectAccountByUsernameStmt.get(username)) {
      return { ok: false, reason: 'account_exists' };
    }

    const createdAt = Math.floor(Date.now() / 1000);
    runInTransaction(() => {
      insertUserStmt.run(username);
      insertAccountStmt.run(username, passwordHash, createdAt, createdAt);
    });

    return {
      ok: true,
      account: {
        username,
        password_hash: passwordHash,
        created_at: createdAt,
        last_login_at: createdAt,
      },
    };
  },

  touchAccountLogin(username) {
    updateAccountLoginStmt.run(Math.floor(Date.now() / 1000), username);
  },

  revokeToken(tokenId, expiresAt) {
    if (!tokenId || !Number.isFinite(expiresAt)) return;
    insertRevokedTokenStmt.run(tokenId, Date.now(), expiresAt);
  },

  isTokenRevoked(tokenId) {
    if (!tokenId) return false;
    pruneRevokedTokensStmt.run(Date.now());
    return Boolean(selectRevokedTokenStmt.get(tokenId));
  },

  close() {
    db.close();
  },
};
