CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  account_token_version_at_issue INTEGER NOT NULL DEFAULT 1,
  device_label TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  replaced_by_token_id TEXT,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS revoked_access_tokens (
  token_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
