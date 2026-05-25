CREATE TABLE IF NOT EXISTS invites (
  invite_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_by TEXT NOT NULL REFERENCES accounts(username),
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses_remaining INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS invite_redemptions (
  invite_id TEXT NOT NULL REFERENCES invites(invite_id) ON DELETE CASCADE,
  account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (invite_id, account_username)
);
