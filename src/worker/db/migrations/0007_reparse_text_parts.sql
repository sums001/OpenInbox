-- Received mail stored while the scanner treated text and HTML parts with a Content-ID as
-- attachments: the body showed empty, with files called "attachment". The cron reads each one
-- again from its kept raw message (services/reparse.ts) and removes it from the queue.
CREATE TABLE reparse_queue (
  message_id INTEGER PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO reparse_queue (message_id)
  SELECT DISTINCT a.message_id FROM attachments a JOIN messages g ON g.id = a.message_id
   WHERE a.content_type IN ('text/plain', 'text/html') AND g.direction = 'in' AND g.raw_key IS NOT NULL;
