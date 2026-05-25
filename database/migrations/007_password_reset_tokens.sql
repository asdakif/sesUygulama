CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  request_ip TEXT
);
