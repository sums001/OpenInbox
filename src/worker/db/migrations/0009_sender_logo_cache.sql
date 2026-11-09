-- Logos that sending domains publish (BIMI), shown next to their mail when the admin turns it
-- on. svg is NULL when the domain has no usable logo, so misses are cached too. seen_at is when
-- mail from the domain last passed DMARC; checked_at is when its logo was last looked up.
CREATE TABLE sender_logo_cache (
  domain TEXT PRIMARY KEY,
  svg TEXT,
  seen_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sender_logo_cache_due ON sender_logo_cache (checked_at);
