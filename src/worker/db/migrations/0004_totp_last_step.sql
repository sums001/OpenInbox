-- The last TOTP time step accepted for each user, so a code can't be used twice (RFC 6238 §5.2).
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
