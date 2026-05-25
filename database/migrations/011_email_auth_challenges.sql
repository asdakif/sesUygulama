CREATE TABLE IF NOT EXISTS email_auth_challenges (
  challenge_id TEXT PRIMARY KEY,
  account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'mfa',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_email_auth_challenges_account
  ON email_auth_challenges (account_username, expires_at);
