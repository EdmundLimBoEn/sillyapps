CREATE TABLE admin_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX admin_sessions_expires_at ON admin_sessions (expires_at);
