CREATE TABLE IF NOT EXISTS security_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  actor_username TEXT,
  target_username TEXT,
  ip TEXT,
  user_agent TEXT,
  metadata_json TEXT
);
