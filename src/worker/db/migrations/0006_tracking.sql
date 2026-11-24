-- Open and click tracking for mail people send (web app and Inbox API).

-- A row outlives its message (message_id becomes NULL), so links in mail already delivered keep
-- redirecting after the sender deletes it. Such rows are removed a year after sending.
CREATE TABLE tracked_messages (
  token TEXT PRIMARY KEY,           -- random, in the pixel and link URLs
  message_id INTEGER UNIQUE REFERENCES messages (id) ON DELETE SET NULL,
  links TEXT NOT NULL DEFAULT '[]', -- JSON array of the original URLs, by index, set when sent
  sent_at INTEGER,                  -- when the tracked copy went out, to spot instant scanner hits
  events INTEGER NOT NULL DEFAULT 0 -- events recorded, up to a cap, so a hit never counts rows
);

-- source: human (a person, as far as we can tell), proxy (a mail provider's image proxy fetching
-- for a person, e.g. Gmail), apple (Apple Mail Privacy Protection preloading, not an open) or
-- scanner (security scanners and bots following links).
CREATE TABLE tracking_events (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('open', 'click')),
  link INTEGER,
  source TEXT NOT NULL CHECK (source IN ('human', 'proxy', 'apple', 'scanner')),
  ip TEXT,
  user_agent TEXT,
  country TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX tracking_events_message ON tracking_events (message_id, created_at);
