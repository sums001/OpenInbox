-- Networks each user has completed a sign-in from: the IPv4 address, or the first 64 bits of an
-- IPv6 address (devices rotate the rest for privacy). Wrong passwords sent from elsewhere don't
-- lock a user out of these (see the per-account login limit in routes/auth.ts).
CREATE TABLE known_logins (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  network TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, network)
);

-- Earlier IPv4 sign-ins from the audit log; IPv6 networks are learned at the next sign-in.
INSERT OR IGNORE INTO known_logins (user_id, network, last_at)
  SELECT user_id, ip, MAX(created_at) FROM audit_log
   WHERE action = 'auth.login' AND user_id IS NOT NULL AND ip IS NOT NULL AND ip NOT LIKE '%:%' AND ip != 'unknown'
   GROUP BY user_id, ip;
