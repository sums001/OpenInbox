-- Cloudflare Email Sending is a new provider type. SQLite cannot widen a CHECK constraint in
-- place, so providers is rebuilt with the wider list. Dropping it cascades into provider_domains
-- and quota_usage, and sets the sending override on domains and messages to NULL, so everything
-- that points at a provider is copied aside first and restored in the same transaction.
-- defer_foreign_keys moves the checks to commit, when the tables are whole again.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE _provider_domains_backup AS SELECT * FROM provider_domains;
CREATE TABLE _quota_usage_backup AS SELECT * FROM quota_usage;
CREATE TABLE _domain_provider_backup AS SELECT id, provider_id FROM domains WHERE provider_id IS NOT NULL;
CREATE TABLE _message_provider_backup AS SELECT id, provider_id FROM messages WHERE provider_id IS NOT NULL;

CREATE TABLE providers_new (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('resend', 'brevo', 'mailjet', 'smtp', 'cloudflare')),
  name TEXT NOT NULL,
  config TEXT NOT NULL,           -- encrypted JSON credentials
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'connected', 'error')),
  last_error TEXT,
  checked_at INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,      -- fallback order, lowest first
  is_default INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER,
  monthly_limit INTEGER,
  webhook_secret TEXT,            -- encrypted
  webhook_id TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO providers_new (id, type, name, config, status, last_error, checked_at, priority, is_default, daily_limit, monthly_limit, webhook_secret, webhook_id, created_at)
  SELECT id, type, name, config, status, last_error, checked_at, priority, is_default, daily_limit, monthly_limit, webhook_secret, webhook_id, created_at FROM providers;

DROP TABLE provider_domains;
DROP TABLE quota_usage;
DROP TABLE providers;

ALTER TABLE providers_new RENAME TO providers;

CREATE TABLE provider_domains (
  provider_id INTEGER NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  domain_id INTEGER NOT NULL REFERENCES domains (id) ON DELETE CASCADE,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
  records TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  checked_at INTEGER,
  PRIMARY KEY (provider_id, domain_id)
);
CREATE INDEX provider_domains_domain ON provider_domains (domain_id);
INSERT INTO provider_domains SELECT * FROM _provider_domains_backup;

CREATE TABLE quota_usage (
  provider_id INTEGER NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  day TEXT NOT NULL,              -- UTC YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, day)
);
INSERT INTO quota_usage SELECT * FROM _quota_usage_backup;

UPDATE domains SET provider_id = (SELECT b.provider_id FROM _domain_provider_backup b WHERE b.id = domains.id)
  WHERE id IN (SELECT id FROM _domain_provider_backup);
UPDATE messages SET provider_id = (SELECT b.provider_id FROM _message_provider_backup b WHERE b.id = messages.id)
  WHERE id IN (SELECT id FROM _message_provider_backup);

DROP TABLE _provider_domains_backup;
DROP TABLE _quota_usage_backup;
DROP TABLE _domain_provider_backup;
DROP TABLE _message_provider_backup;
