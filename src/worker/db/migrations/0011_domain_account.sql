-- A domain whose zone sits in another Cloudflare account than OpenInbox's Worker. Email Routing
-- can only hand mail to a Worker in the zone's own account, so OpenInbox installs a small relay
-- Worker there (services/relay.ts). NULL: the zone is in OpenInbox's own account.
ALTER TABLE domains ADD COLUMN account_id TEXT;
