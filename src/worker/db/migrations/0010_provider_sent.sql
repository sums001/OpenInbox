-- Mail a provider reports sending that OpenInbox didn't send: another app using the same Resend
-- account, for example over SMTP (issue #17). The webhook notes it here and the cron imports it a
-- minute later, once OpenInbox's own sends have stored their provider IDs and can be told apart.
CREATE TABLE provider_sent (
  provider_id INTEGER NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  message_id TEXT,                -- Message-ID without angle brackets
  from_addr TEXT NOT NULL,        -- lowercase address
  from_name TEXT NOT NULL DEFAULT '',
  to_addrs TEXT NOT NULL DEFAULT '[]',      -- JSON [{name, address}]
  subject TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  noted_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, provider_message_id)
);
CREATE INDEX provider_sent_due ON provider_sent (noted_at);

-- The event list a provider's webhook was registered with, so webhooks registered before
-- email.sent was added are registered again.
ALTER TABLE providers ADD COLUMN webhook_version INTEGER NOT NULL DEFAULT 0;
