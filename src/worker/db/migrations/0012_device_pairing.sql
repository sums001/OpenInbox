-- Phones connected to an account (the OpenInbox mobile app) get an Inbox API key of their own,
-- kind 'device', listed under Settings > Devices instead of with the API keys.
ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'key';
ALTER TABLE api_keys ADD COLUMN platform TEXT;

-- Connecting a phone by QR code (services/devices.ts). The signed-in web app creates a pairing;
-- the phone claims it with the code from the QR code (or the short code typed by hand); the web
-- app approves it; the phone collects its key once. Only hashes of the codes are kept.
CREATE TABLE device_pairings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the code in the QR code
  short_hash TEXT NOT NULL UNIQUE,  -- SHA-256 of the short code, for typing by hand
  claim_hash TEXT,                  -- SHA-256 of the secret the phone polls with, once claimed
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'claimed', 'approved', 'denied')),
  device_name TEXT,
  platform TEXT,
  token_enc TEXT,                   -- the phone's key, encrypted, until the phone collects it
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX device_pairings_user ON device_pairings (user_id);
