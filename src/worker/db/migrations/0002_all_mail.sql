-- The All mail view: every thread of a mailbox outside Spam and Trash, newest first. Walking this
-- index reads about one page, skipping the few Spam and Trash threads in between.
CREATE INDEX IF NOT EXISTS threads_recent ON threads (mailbox_id, last_message_at DESC);
