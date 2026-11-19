CREATE TABLE IF NOT EXISTS hub_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  document TEXT NOT NULL
);
INSERT OR IGNORE INTO hub_state (id, revision, document) VALUES (1, 0, '{}');
CREATE TABLE IF NOT EXISTS hub_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT,
  expires INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO hub_guard (id) VALUES (1);
