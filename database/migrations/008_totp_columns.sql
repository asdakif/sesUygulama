CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (account_username, code_hash)
);
