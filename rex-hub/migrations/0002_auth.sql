CREATE TABLE IF NOT EXISTS auth_admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
    bucket TEXT PRIMARY KEY NOT NULL,
    count INTEGER NOT NULL CHECK (count > 0),
    resets_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_attempts_expiry ON auth_attempts (resets_at);
