'use strict';

/**
 * SQLite-backed persistence layer with one-time legacy JSON migration.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createLogger } = require('./server/logger');
const { runMigrations } = require('./database/migrate');

const log = createLogger('database');

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
`);
runMigrations(db, log);
db.exec(`
  UPDATE accounts
  SET display_name = username
  WHERE display_name IS NULL OR trim(display_name) = '';
`);

const countTableStmt = db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ? AND name = ?');
const countRowsStmt = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`);

const insertMetadataStmt = db.prepare(`
  INSERT INTO metadata (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const insertChannelStmt = db.prepare(`
  INSERT INTO channels (id, name, description)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description
`);

const insertUserStmt = db.prepare('INSERT OR IGNORE INTO users (username) VALUES (?)');

const insertAccountStmt = db.prepare(`
  INSERT INTO accounts (
    username,
    display_name,
    password_hash,
    created_at,
    last_login_at,
    token_version,
    role,
    failed_login_count
  )
  VALUES (?, ?, ?, ?, ?, 1, 'user', 0)
`);

const selectAccountByUsernameStmt = db.prepare(`
  SELECT
    username,
    display_name,
    password_hash,
    email,
    email_verified_at,
    email_pending,
    email_pending_token_hash,
    email_pending_expires_at,
    token_version,
    role,
    disabled_at,
    failed_login_count,
    locked_until,
    totp_secret,
    totp_enabled_at,
    pending_delete_at,
    created_at,
    last_login_at
  FROM accounts
  WHERE username = ? COLLATE NOCASE
  ORDER BY created_at ASC
  LIMIT 1
`);

const selectAccountByEmailStmt = db.prepare(`
  SELECT
    username,
    display_name,
    password_hash,
    email,
    email_verified_at,
    email_pending,
    email_pending_token_hash,
    email_pending_expires_at,
    token_version,
    role,
    disabled_at,
    failed_login_count,
    locked_until,
    totp_secret,
    totp_enabled_at,
    pending_delete_at,
    created_at,
    last_login_at
  FROM accounts
  WHERE email = ? COLLATE NOCASE
  ORDER BY created_at ASC
  LIMIT 1
`);

const selectAccountByPendingEmailStmt = db.prepare(`
  SELECT
    username,
    display_name,
    password_hash,
    email,
    email_verified_at,
    email_pending,
    email_pending_token_hash,
    email_pending_expires_at,
    token_version,
    role,
    disabled_at,
    failed_login_count,
    locked_until,
    totp_secret,
    totp_enabled_at,
    pending_delete_at,
    created_at,
    last_login_at
  FROM accounts
  WHERE email_pending = ? COLLATE NOCASE
  ORDER BY created_at ASC
  LIMIT 1
`);

const updateAccountLoginStmt = db.prepare(`
  UPDATE accounts
  SET last_login_at = ?
  WHERE username = ? COLLATE NOCASE
`);

const updateAccountPasswordHashStmt = db.prepare(`
  UPDATE accounts
  SET password_hash = ?
  WHERE username = ? COLLATE NOCASE
`);

const updateAccountDisplayNameStmt = db.prepare(`
  UPDATE accounts
  SET display_name = ?
  WHERE username = ? COLLATE NOCASE
`);

const updateAccountPendingEmailStmt = db.prepare(`
  UPDATE accounts
  SET email_pending = ?, email_pending_token_hash = ?, email_pending_expires_at = ?
  WHERE username = ? COLLATE NOCASE
`);

const clearAccountPendingEmailStmt = db.prepare(`
  UPDATE accounts
  SET email_pending = NULL, email_pending_token_hash = NULL, email_pending_expires_at = NULL
  WHERE username = ? COLLATE NOCASE
`);

const confirmAccountPendingEmailStmt = db.prepare(`
  UPDATE accounts
  SET
    email = email_pending,
    email_verified_at = ?,
    email_pending = NULL,
    email_pending_token_hash = NULL,
    email_pending_expires_at = NULL
  WHERE username = ? COLLATE NOCASE
`);

const setAccountEmailStmt = db.prepare(`
  UPDATE accounts
  SET
    email = ?,
    email_verified_at = ?,
    email_pending = NULL,
    email_pending_token_hash = NULL,
    email_pending_expires_at = NULL
  WHERE username = ? COLLATE NOCASE
`);

const updateAccountLoginSecurityStmt = db.prepare(`
  UPDATE accounts
  SET failed_login_count = ?, locked_until = ?
  WHERE username = ? COLLATE NOCASE
`);

const scheduleAccountDeleteStmt = db.prepare(`
  UPDATE accounts
  SET pending_delete_at = ?
  WHERE username = ? COLLATE NOCASE
`);

const clearAccountPendingDeleteStmt = db.prepare(`
  UPDATE accounts
  SET pending_delete_at = NULL
  WHERE username = ? COLLATE NOCASE
`);

const bumpAccountTokenVersionStmt = db.prepare(`
  UPDATE accounts
  SET token_version = token_version + 1
  WHERE username = ? COLLATE NOCASE
`);

const selectAccountTokenVersionStmt = db.prepare(`
  SELECT token_version
  FROM accounts
  WHERE username = ? COLLATE NOCASE
  LIMIT 1
`);

const selectAccountRoleStmt = db.prepare(`
  SELECT role
  FROM accounts
  WHERE username = ? COLLATE NOCASE
  LIMIT 1
`);

const selectFirstAccountStmt = db.prepare(`
  SELECT
    username,
    display_name,
    password_hash,
    email,
    email_verified_at,
    email_pending,
    email_pending_token_hash,
    email_pending_expires_at,
    token_version,
    role,
    disabled_at,
    failed_login_count,
    locked_until,
    totp_secret,
    totp_enabled_at,
    pending_delete_at,
    created_at,
    last_login_at
  FROM accounts
  ORDER BY created_at ASC, username ASC
  LIMIT 1
`);

const countAccountsStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM accounts
`);

const countAdminAccountsStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM accounts
  WHERE role = 'admin'
`);

const updateAccountRoleStmt = db.prepare(`
  UPDATE accounts
  SET role = ?
  WHERE username = ? COLLATE NOCASE
`);

const updateAccountDisabledAtStmt = db.prepare(`
  UPDATE accounts
  SET disabled_at = ?
  WHERE username = ? COLLATE NOCASE
`);

const updateAccountTotpSecretStmt = db.prepare(`
  UPDATE accounts
  SET totp_secret = ?, totp_enabled_at = NULL
  WHERE username = ? COLLATE NOCASE
`);

const updateAccountTotpEnabledStmt = db.prepare(`
  UPDATE accounts
  SET totp_enabled_at = ?
  WHERE username = ? COLLATE NOCASE
`);

const clearAccountTotpStmt = db.prepare(`
  UPDATE accounts
  SET totp_secret = NULL, totp_enabled_at = NULL
  WHERE username = ? COLLATE NOCASE
`);

const insertRevokedTokenStmt = db.prepare(`
  INSERT OR REPLACE INTO revoked_tokens (token_id, revoked_at, expires_at)
  VALUES (?, ?, ?)
`);

const insertRevokedAccessTokenStmt = db.prepare(`
  INSERT OR REPLACE INTO revoked_access_tokens (token_id, expires_at)
  VALUES (?, ?)
`);

const selectRevokedTokenStmt = db.prepare(`
  SELECT token_id
  FROM revoked_tokens
  WHERE token_id = ?
`);

const selectRevokedAccessTokenStmt = db.prepare(`
  SELECT token_id
  FROM revoked_access_tokens
  WHERE token_id = ?
`);

const pruneRevokedTokensStmt = db.prepare(`
  DELETE FROM revoked_tokens
  WHERE expires_at <= ?
`);

const pruneRevokedAccessTokensStmt = db.prepare(`
  DELETE FROM revoked_access_tokens
  WHERE expires_at <= ?
`);

const insertRefreshTokenStmt = db.prepare(`
  INSERT INTO refresh_tokens (
    token_id,
    token_hash,
    account_username,
    family_id,
    account_token_version_at_issue,
    device_label,
    ip,
    user_agent,
    created_at,
    last_used_at,
    expires_at,
    replaced_by_token_id,
    revoked_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
`);

const selectRefreshTokenStmt = db.prepare(`
  SELECT
    token_id,
    token_hash,
    account_username,
    family_id,
    account_token_version_at_issue,
    device_label,
    ip,
    user_agent,
    created_at,
    last_used_at,
    expires_at,
    replaced_by_token_id,
    revoked_at
  FROM refresh_tokens
  WHERE token_id = ?
  LIMIT 1
`);

const updateRefreshTokenReplacementStmt = db.prepare(`
  UPDATE refresh_tokens
  SET replaced_by_token_id = ?, last_used_at = ?
  WHERE token_id = ?
`);

const updateRefreshTokenRevokedStmt = db.prepare(`
  UPDATE refresh_tokens
  SET revoked_at = COALESCE(revoked_at, ?)
  WHERE token_id = ?
`);

const updateRefreshFamilyRevokedStmt = db.prepare(`
  UPDATE refresh_tokens
  SET revoked_at = COALESCE(revoked_at, ?)
  WHERE family_id = ?
`);

const selectActiveRefreshTokensForUserStmt = db.prepare(`
  SELECT
    token_id,
    account_username,
    device_label,
    ip,
    user_agent,
    created_at,
    last_used_at,
    expires_at
  FROM refresh_tokens
  WHERE account_username = ? COLLATE NOCASE
    AND revoked_at IS NULL
    AND replaced_by_token_id IS NULL
    AND expires_at > ?
  ORDER BY last_used_at DESC, created_at DESC
`);

const insertPasswordResetTokenStmt = db.prepare(`
  INSERT INTO password_reset_tokens (
    token_id,
    token_hash,
    account_username,
    created_at,
    expires_at,
    used_at,
    request_ip
  )
  VALUES (?, ?, ?, ?, ?, NULL, ?)
`);

const selectPasswordResetTokenStmt = db.prepare(`
  SELECT
    token_id,
    token_hash,
    account_username,
    created_at,
    expires_at,
    used_at,
    request_ip
  FROM password_reset_tokens
  WHERE token_id = ?
  LIMIT 1
`);

const selectActivePasswordResetTokensForUserStmt = db.prepare(`
  SELECT
    token_id,
    token_hash,
    account_username,
    created_at,
    expires_at,
    used_at,
    request_ip
  FROM password_reset_tokens
  WHERE account_username = ? COLLATE NOCASE
    AND used_at IS NULL
    AND expires_at > ?
  ORDER BY created_at ASC
`);

const markPasswordResetTokenUsedStmt = db.prepare(`
  UPDATE password_reset_tokens
  SET used_at = COALESCE(used_at, ?)
  WHERE token_id = ?
`);

const prunePasswordResetTokensStmt = db.prepare(`
  DELETE FROM password_reset_tokens
  WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)
`);

const revokeAllRefreshTokensForUserStmt = db.prepare(`
  UPDATE refresh_tokens
  SET revoked_at = COALESCE(revoked_at, ?)
  WHERE account_username = ? COLLATE NOCASE
`);

const deleteTotpRecoveryCodesStmt = db.prepare(`
  DELETE FROM totp_recovery_codes
  WHERE account_username = ? COLLATE NOCASE
`);

const insertTotpRecoveryCodeStmt = db.prepare(`
  INSERT INTO totp_recovery_codes (
    account_username,
    code_hash,
    created_at,
    used_at
  )
  VALUES (?, ?, ?, NULL)
`);

const consumeTotpRecoveryCodeStmt = db.prepare(`
  UPDATE totp_recovery_codes
  SET used_at = COALESCE(used_at, ?)
  WHERE account_username = ? COLLATE NOCASE
    AND code_hash = ?
    AND used_at IS NULL
`);

const insertInviteStmt = db.prepare(`
  INSERT INTO invites (
    invite_id,
    code_hash,
    label,
    created_by,
    max_uses,
    uses_remaining,
    expires_at,
    created_at,
    revoked_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
`);

const selectInviteByIdStmt = db.prepare(`
  SELECT
    invite_id,
    code_hash,
    label,
    created_by,
    max_uses,
    uses_remaining,
    expires_at,
    created_at,
    revoked_at
  FROM invites
  WHERE invite_id = ?
  LIMIT 1
`);

const selectInviteByCodeHashStmt = db.prepare(`
  SELECT
    invite_id,
    code_hash,
    label,
    created_by,
    max_uses,
    uses_remaining,
    expires_at,
    created_at,
    revoked_at
  FROM invites
  WHERE code_hash = ?
  LIMIT 1
`);

const selectInvitesStmt = db.prepare(`
  SELECT
    invite_id,
    label,
    created_by,
    max_uses,
    uses_remaining,
    expires_at,
    created_at,
    revoked_at
  FROM invites
  ORDER BY created_at DESC, invite_id DESC
`);

const revokeInviteStmt = db.prepare(`
  UPDATE invites
  SET revoked_at = COALESCE(revoked_at, ?)
  WHERE invite_id = ?
`);

const consumeInviteUseStmt = db.prepare(`
  UPDATE invites
  SET uses_remaining = uses_remaining - 1
  WHERE invite_id = ?
    AND uses_remaining > 0
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > ?)
`);

const insertInviteRedemptionStmt = db.prepare(`
  INSERT INTO invite_redemptions (invite_id, account_username, redeemed_at)
  VALUES (?, ?, ?)
`);

const selectPendingDeleteUsernamesStmt = db.prepare(`
  SELECT username
  FROM accounts
  WHERE pending_delete_at IS NOT NULL
    AND pending_delete_at <= ?
`);

const deleteUserStmt = db.prepare(`
  DELETE FROM users
  WHERE username = ? COLLATE NOCASE
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
      (from_user = ? COLLATE NOCASE AND to_user = ? COLLATE NOCASE)
      OR
      (from_user = ? COLLATE NOCASE AND to_user = ? COLLATE NOCASE)
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

const selectLoginAttemptStmt = db.prepare(`
  SELECT bucket_key, attempts, first_attempt_at, last_attempt_at, locked_until
  FROM login_attempts
  WHERE bucket_key = ?
`);

const upsertLoginAttemptStmt = db.prepare(`
  INSERT INTO login_attempts (
    bucket_key,
    attempts,
    first_attempt_at,
    last_attempt_at,
    locked_until
  )
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(bucket_key) DO UPDATE SET
    attempts = excluded.attempts,
    first_attempt_at = excluded.first_attempt_at,
    last_attempt_at = excluded.last_attempt_at,
    locked_until = excluded.locked_until
`);

const clearLoginAttemptStmt = db.prepare('DELETE FROM login_attempts WHERE bucket_key = ?');
const pruneLoginAttemptsStmt = db.prepare(`
  DELETE FROM login_attempts
  WHERE last_attempt_at < ? AND (locked_until IS NULL OR locked_until <= ?)
`);

const insertAuditLogStmt = db.prepare(`
  INSERT INTO security_audit_log (
    ts,
    event,
    actor_username,
    target_username,
    ip,
    user_agent,
    metadata_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectAuditLogStmt = db.prepare(`
  SELECT
    id,
    ts,
    event,
    actor_username,
    target_username,
    ip,
    user_agent,
    metadata_json
  FROM security_audit_log
  ORDER BY id DESC
  LIMIT ?
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
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function setMetadata(key, value) {
  insertMetadataStmt.run(key, value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
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
pruneRevokedAccessTokensStmt.run(Date.now());
prunePasswordResetTokensStmt.run(Date.now(), Date.now());

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
    const reactions = getReactionsForMessageIds(rows.map((row) => row.id));
    return rows.map((row) => hydrateMessage(row, reactions));
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
    if (!username) return null;
    return selectAccountByUsernameStmt.get(username) || null;
  },

  getAccountByEmail(email) {
    if (!email) return null;
    return selectAccountByEmailStmt.get(email) || null;
  },

  getAccountByPendingEmail(email) {
    if (!email) return null;
    return selectAccountByPendingEmailStmt.get(email) || null;
  },

  getFirstAccount() {
    return selectFirstAccountStmt.get() || null;
  },

  countAccounts() {
    return Number(countAccountsStmt.get()?.count || 0);
  },

  countAdminAccounts() {
    return Number(countAdminAccountsStmt.get()?.count || 0);
  },

  getAccountRole(username) {
    return selectAccountRoleStmt.get(username)?.role || null;
  },

  createAccount(username, passwordHash, options = {}) {
    if (selectAccountByUsernameStmt.get(username)) {
      return { ok: false, reason: 'account_exists' };
    }

    const createdAt = Math.floor(Date.now() / 1000);
    const displayName = options.displayName || username;

    runInTransaction(() => {
      insertUserStmt.run(username);
      insertAccountStmt.run(username, displayName, passwordHash, createdAt, createdAt);
    });

    return {
      ok: true,
      account: this.getAccount(username),
    };
  },

  createAccountWithInvite(username, passwordHash, options = {}) {
    if (selectAccountByUsernameStmt.get(username)) {
      return { ok: false, reason: 'account_exists' };
    }

    const createdAt = Math.floor(Date.now() / 1000);
    const displayName = options.displayName || username;
    const inviteCode = typeof options.inviteCode === 'string' ? options.inviteCode.trim() : '';
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    let failure = null;

    runInTransaction(() => {
      if (selectAccountByUsernameStmt.get(username)) {
        failure = { ok: false, reason: 'account_exists' };
        return;
      }

      if (options.useLegacyInvite) {
        insertUserStmt.run(username);
        insertAccountStmt.run(username, displayName, passwordHash, createdAt, createdAt);
        return;
      }

      const invite = selectInviteByCodeHashStmt.get(sha256(inviteCode));
      if (!invite || invite.revoked_at || invite.uses_remaining <= 0 || (invite.expires_at && invite.expires_at <= nowMs)) {
        failure = { ok: false, reason: 'invalid_invite' };
        return;
      }

      const consumed = consumeInviteUseStmt.run(invite.invite_id, nowMs);
      if (Number(consumed.changes || 0) !== 1) {
        failure = { ok: false, reason: 'invalid_invite' };
        return;
      }

      insertUserStmt.run(username);
      insertAccountStmt.run(username, displayName, passwordHash, createdAt, createdAt);
      insertInviteRedemptionStmt.run(invite.invite_id, username, nowMs);
    });

    if (failure) return failure;
    return {
      ok: true,
      account: this.getAccount(username),
    };
  },

  touchAccountLogin(username) {
    updateAccountLoginStmt.run(Math.floor(Date.now() / 1000), username);
  },

  updateAccountPasswordHash(username, passwordHash) {
    updateAccountPasswordHashStmt.run(passwordHash, username);
  },

  updateAccountDisplayName(username, displayName) {
    updateAccountDisplayNameStmt.run(displayName, username);
  },

  setAccountPendingEmail(username, emailPending, tokenHash, expiresAt) {
    updateAccountPendingEmailStmt.run(emailPending, tokenHash, expiresAt, username);
  },

  clearAccountPendingEmail(username) {
    clearAccountPendingEmailStmt.run(username);
  },

  confirmAccountPendingEmail(username, verifiedAt = Date.now()) {
    confirmAccountPendingEmailStmt.run(verifiedAt, username);
  },

  setAccountEmail(username, email, verifiedAt = Date.now()) {
    setAccountEmailStmt.run(email, verifiedAt, username);
  },

  setAccountLoginSecurity(username, { failedLoginCount = 0, lockedUntil = null }) {
    updateAccountLoginSecurityStmt.run(failedLoginCount, lockedUntil, username);
  },

  scheduleAccountDelete(username, pendingDeleteAt) {
    scheduleAccountDeleteStmt.run(pendingDeleteAt, username);
  },

  clearPendingAccountDelete(username) {
    clearAccountPendingDeleteStmt.run(username);
  },

  setAccountRole(username, role) {
    updateAccountRoleStmt.run(role, username);
  },

  setAccountDisabledAt(username, disabledAt = null) {
    updateAccountDisabledAtStmt.run(disabledAt, username);
  },

  setAccountTotpSecret(username, secret) {
    updateAccountTotpSecretStmt.run(secret, username);
  },

  enableAccountTotp(username, enabledAt = Date.now()) {
    updateAccountTotpEnabledStmt.run(enabledAt, username);
  },

  clearAccountTotp(username) {
    clearAccountTotpStmt.run(username);
  },

  bumpTokenVersion(username) {
    bumpAccountTokenVersionStmt.run(username);
    return selectAccountTokenVersionStmt.get(username)?.token_version || null;
  },

  insertRefreshToken({
    tokenId,
    tokenHash,
    accountUsername,
    familyId,
    accountTokenVersionAtIssue,
    deviceLabel,
    ip,
    userAgent,
    createdAt,
    lastUsedAt,
    expiresAt,
  }) {
    insertRefreshTokenStmt.run(
      tokenId,
      tokenHash,
      accountUsername,
      familyId,
      accountTokenVersionAtIssue,
      deviceLabel,
      ip,
      userAgent,
      createdAt,
      lastUsedAt,
      expiresAt,
    );
  },

  getRefreshToken(tokenId) {
    if (!tokenId) return null;
    return selectRefreshTokenStmt.get(tokenId) || null;
  },

  markRefreshReplaced(tokenId, replacedByTokenId, lastUsedAt = Date.now()) {
    updateRefreshTokenReplacementStmt.run(replacedByTokenId, lastUsedAt, tokenId);
  },

  revokeRefreshToken(tokenId, revokedAt = Date.now()) {
    updateRefreshTokenRevokedStmt.run(revokedAt, tokenId);
  },

  revokeRefreshFamily(familyId, revokedAt = Date.now()) {
    updateRefreshFamilyRevokedStmt.run(revokedAt, familyId);
  },

  listActiveRefreshTokens(username, now = Date.now()) {
    if (!username) return [];
    return selectActiveRefreshTokensForUserStmt.all(username, now);
  },

  revokeAllRefreshTokensForUser(username, revokedAt = Date.now()) {
    if (!username) return;
    revokeAllRefreshTokensForUserStmt.run(revokedAt, username);
  },

  replaceTotpRecoveryCodes(username, codeHashes = [], createdAt = Date.now()) {
    runInTransaction(() => {
      deleteTotpRecoveryCodesStmt.run(username);
      for (const codeHash of codeHashes) {
        insertTotpRecoveryCodeStmt.run(username, codeHash, createdAt);
      }
    });
  },

  consumeTotpRecoveryCode(username, codeHash, usedAt = Date.now()) {
    const result = consumeTotpRecoveryCodeStmt.run(usedAt, username, codeHash);
    return (result?.changes || 0) > 0;
  },

  createInvite({
    inviteId,
    code,
    label = null,
    createdBy,
    maxUses = 1,
    usesRemaining = maxUses,
    expiresAt = null,
    createdAt = Date.now(),
  }) {
    insertInviteStmt.run(
      inviteId,
      sha256(code),
      label,
      createdBy,
      maxUses,
      usesRemaining,
      expiresAt,
      createdAt,
    );
    return this.getInviteById(inviteId);
  },

  getInviteById(inviteId) {
    if (!inviteId) return null;
    return selectInviteByIdStmt.get(inviteId) || null;
  },

  listInvites() {
    return selectInvitesStmt.all();
  },

  revokeInvite(inviteId, revokedAt = Date.now()) {
    revokeInviteStmt.run(revokedAt, inviteId);
  },

  insertPasswordResetToken({
    tokenId,
    tokenHash,
    accountUsername,
    createdAt,
    expiresAt,
    requestIp = null,
  }) {
    insertPasswordResetTokenStmt.run(
      tokenId,
      tokenHash,
      accountUsername,
      createdAt,
      expiresAt,
      requestIp,
    );
  },

  getPasswordResetToken(tokenId) {
    if (!tokenId) return null;
    return selectPasswordResetTokenStmt.get(tokenId) || null;
  },

  listActivePasswordResetTokens(username, now = Date.now()) {
    if (!username) return [];
    return selectActivePasswordResetTokensForUserStmt.all(username, now);
  },

  markPasswordResetTokenUsed(tokenId, usedAt = Date.now()) {
    markPasswordResetTokenUsedStmt.run(usedAt, tokenId);
  },

  completePasswordReset({ tokenId, username, passwordHash, usedAt = Date.now() }) {
    runInTransaction(() => {
      markPasswordResetTokenUsedStmt.run(usedAt, tokenId);
      updateAccountPasswordHashStmt.run(passwordHash, username);
      bumpAccountTokenVersionStmt.run(username);
      revokeAllRefreshTokensForUserStmt.run(usedAt, username);
    });
  },

  revokeToken(tokenId, expiresAt) {
    if (!tokenId || !Number.isFinite(expiresAt)) return;
    insertRevokedTokenStmt.run(tokenId, Date.now(), expiresAt);
  },

  revokeAccessToken(tokenId, expiresAt) {
    if (!tokenId || !Number.isFinite(expiresAt)) return;
    insertRevokedAccessTokenStmt.run(tokenId, expiresAt);
  },

  isTokenRevoked(tokenId) {
    if (!tokenId) return false;
    pruneRevokedTokensStmt.run(Date.now());
    pruneRevokedAccessTokensStmt.run(Date.now());
    return Boolean(selectRevokedTokenStmt.get(tokenId) || selectRevokedAccessTokenStmt.get(tokenId));
  },

  pruneRevokedTokens(now = Date.now()) {
    pruneRevokedTokensStmt.run(now);
    pruneRevokedAccessTokensStmt.run(now);
    prunePasswordResetTokensStmt.run(now, now);
  },

  getLoginAttempt(bucketKey) {
    return selectLoginAttemptStmt.get(bucketKey) || null;
  },

  upsertLoginAttempt({ bucketKey, attempts, firstAttemptAt, lastAttemptAt, lockedUntil }) {
    upsertLoginAttemptStmt.run(bucketKey, attempts, firstAttemptAt, lastAttemptAt, lockedUntil);
  },

  clearLoginAttempt(bucketKey) {
    clearLoginAttemptStmt.run(bucketKey);
  },

  pruneLoginAttempts(staleBefore, unlockedBefore) {
    pruneLoginAttemptsStmt.run(staleBefore, unlockedBefore);
  },

  insertAuditLog({ ts, event, actorUsername, targetUsername, ip, userAgent, metadataJson }) {
    insertAuditLogStmt.run(ts, event, actorUsername, targetUsername, ip, userAgent, metadataJson);
  },

  getAuditLog(limit = 100) {
    return selectAuditLogStmt.all(limit).map((row) => ({
      ...row,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    }));
  },

  getAuditLogFiltered({ event = '', actor = '', since = null, until = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];

    if (event) {
      clauses.push('event = ?');
      params.push(event);
    }
    if (actor) {
      clauses.push('(actor_username = ? COLLATE NOCASE OR target_username = ? COLLATE NOCASE)');
      params.push(actor, actor);
    }
    if (Number.isFinite(since)) {
      clauses.push('ts >= ?');
      params.push(since);
    }
    if (Number.isFinite(until)) {
      clauses.push('ts <= ?');
      params.push(until);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const stmt = db.prepare(`
      SELECT
        id,
        ts,
        event,
        actor_username,
        target_username,
        ip,
        user_agent,
        metadata_json
      FROM security_audit_log
      ${where}
      ORDER BY id DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit);
    return rows.map((row) => ({
      ...row,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    }));
  },

  listAccounts({ query = '', disabled = '', limit = 100 } = {}) {
    const clauses = [];
    const params = [];

    if (query) {
      clauses.push('(username LIKE ? COLLATE NOCASE OR display_name LIKE ? COLLATE NOCASE OR email LIKE ? COLLATE NOCASE)');
      const pattern = `%${query}%`;
      params.push(pattern, pattern, pattern);
    }
    if (disabled === 'true') clauses.push('disabled_at IS NOT NULL');
    else if (disabled === 'false') clauses.push('disabled_at IS NULL');

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const stmt = db.prepare(`
      SELECT
        username,
        display_name,
        email,
        role,
        totp_enabled_at,
        disabled_at,
        pending_delete_at,
        created_at,
        last_login_at
      FROM accounts
      ${where}
      ORDER BY created_at ASC, username ASC
      LIMIT ?
    `);
    return stmt.all(...params, limit);
  },

  deleteExpiredPendingAccounts(now = Date.now()) {
    const usernames = selectPendingDeleteUsernamesStmt.all(now).map((row) => row.username);
    if (!usernames.length) return [];

    runInTransaction(() => {
      for (const username of usernames) {
        deleteUserStmt.run(username);
      }
    });

    return usernames;
  },

  close() {
    db.close();
  },
};
