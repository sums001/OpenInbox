-- Inbox API: per-user API keys and idempotent sends.

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,           -- the first characters of the key, to recognize it in the UI
  key_hash TEXT NOT NULL UNIQUE,  -- SHA-256 hex of the key; the key itself is never stored
  scopes TEXT NOT NULL,           -- JSON array of 'read', 'send', 'modify'
  mailbox_ids TEXT,               -- JSON array the key is limited to, or NULL for all of the user's mailboxes
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  last_used_ip TEXT
);
CREATE INDEX api_keys_user ON api_keys (user_id);

-- A retried POST /api/v1/messages with the same Idempotency-Key returns the first message
-- instead of sending again. Kept for a day.
CREATE TABLE api_idempotency (
  key_id INTEGER NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  idem_key TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  send_at INTEGER,                   -- the request's sendAt, for finishing an interrupted send
  queued INTEGER NOT NULL DEFAULT 0, -- 1 once the message has been handed to the send pipeline
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, idem_key)
);

-- Polling (GET /api/v1/messages): each message gets the next number when it becomes visible
-- (received, or sent), in the same batch that does it. D1 runs batches one at a time, so the
-- numbers follow commit order even when deliveries overlap, and a cursor never skips one.
CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
ALTER TABLE messages ADD COLUMN seq INTEGER;
UPDATE messages SET seq = x.n
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS n FROM messages
         WHERE (direction = 'in' AND status != 'unparsed') OR status IN ('sent', 'delivered', 'bounced', 'complained')) AS x
 WHERE x.id = messages.id;
INSERT INTO sequences (name, value) SELECT 'messages', COALESCE(MAX(seq), 0) FROM messages;
CREATE INDEX messages_seq ON messages (mailbox_id, seq) WHERE seq IS NOT NULL;
-- Where polling starts for ?since=.
CREATE INDEX messages_created ON messages (mailbox_id, created_at);
