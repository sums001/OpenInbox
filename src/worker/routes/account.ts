// The signed-in user's own account: profile, password, two-factor, sessions, trusted senders.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { body } from '../lib/validate';
import { apiKeySchema, passwordChangeSchema, profileSchema, totpSchema, trustedSenderSchema } from '../../shared/schemas';
import { all, first, run } from '../db/db';
import { currentUser, clientIp } from '../auth/middleware';
import { verifyPassword } from '../lib/password';
import { decrypt, encrypt } from '../lib/crypto';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from '../lib/totp';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { changePassword, type UserRow } from '../services/users';
import { audit } from '../services/audit';
import { accessibleMailboxes } from '../auth/access';
import { newApiKey } from '../auth/api-key';
import { newId } from '../lib/ids';
import { parseJson } from '../lib/json';

export const account = new Hono<AppBindings>();

account.patch('/', async (c) => {
  const user = currentUser(c);
  const input = await body(c, profileSchema);
  const prefs = input.preferences ? JSON.stringify({ ...user.preferences, ...input.preferences }).slice(0, 10_000) : null;
  await run(c.env.DB, 'UPDATE users SET name = COALESCE(?, name), preferences = COALESCE(?, preferences) WHERE id = ?', input.name ?? null, prefs, user.id);
  return c.json({ ok: true });
});

// Allowed while a password change is forced (see app.ts).
account.post('/password', async (c) => {
  const user = currentUser(c);
  const { current, next } = await body(c, passwordChangeSchema);
  const row = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', user.id);
  if (!row) throw notFound();
  if (!row.must_change_password && !(await verifyPassword(current, row.password_hash))) {
    throw new HttpError(400, 'wrong_password', 'Your current password is not correct.');
  }
  if (await verifyPassword(next, row.password_hash)) throw badRequest('Choose a password different from the current one.');
  await changePassword(c.env.DB, user.id, next, c.get('session')?.id);
  await audit(c.env.DB, { userId: user.id, action: 'account.password_changed', ip: clientIp(c) });
  return c.json({ ok: true });
});

account.post('/2fa/setup', async (c) => {
  const user = currentUser(c);
  const secret = newTotpSecret();
  // Stored as pending (not enabled) until a code proves the app is set up.
  await run(c.env.DB, 'UPDATE users SET totp_secret = ? WHERE id = ? AND totp_enabled = 0', await encrypt(c.env, secret), user.id);
  return c.json({ secret, uri: otpauthUri(secret, user.email) });
});

account.post('/2fa/enable', async (c) => {
  const user = currentUser(c);
  const { code } = await body(c, totpSchema);
  const row = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', user.id);
  if (!row?.totp_secret) throw badRequest('Start two-factor setup first.');
  if (!(await verifyTotp(await decrypt(c.env, row.totp_secret), code))) throw new HttpError(400, 'invalid_code', 'That code is not valid.');
  const codes = newRecoveryCodes();
  const hashes = await Promise.all(codes.map(hashRecoveryCode));
  await run(c.env.DB, 'UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?', JSON.stringify(hashes), user.id);
  await audit(c.env.DB, { userId: user.id, action: 'account.2fa_enabled', ip: clientIp(c) });
  return c.json({ recoveryCodes: codes });
});

account.post('/2fa/disable', async (c) => {
  const user = currentUser(c);
  const { current } = await body(c, passwordChangeSchema.pick({ current: true }));
  const row = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', user.id);
  if (!row || !(await verifyPassword(current, row.password_hash))) throw new HttpError(400, 'wrong_password', 'Your password is not correct.');
  await run(c.env.DB, 'UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = ?', user.id);
  await audit(c.env.DB, { userId: user.id, action: 'account.2fa_disabled', ip: clientIp(c) });
  return c.json({ ok: true });
});

account.get('/sessions', async (c) => {
  const user = currentUser(c);
  const rows = await all<{ id: string; ip: string | null; user_agent: string | null; created_at: number; last_seen_at: number }>(
    c.env.DB,
    'SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND mfa_pending = 0 ORDER BY last_seen_at DESC',
    user.id,
  );
  const current = c.get('session')?.id;
  // Session ids are hashes of the cookie token; exposing a prefix lets the user revoke one.
  return c.json(rows.map((r) => ({ id: r.id.slice(0, 16), ip: r.ip, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === current })));
});

account.delete('/sessions/:id', async (c) => {
  const user = currentUser(c);
  const prefix = c.req.param('id');
  if (!/^[0-9a-f]{16}$/.test(prefix)) throw badRequest('Invalid session.');
  await run(c.env.DB, 'DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?', user.id, prefix);
  return c.json({ ok: true });
});

account.post('/sessions/revoke-others', async (c) => {
  const user = currentUser(c);
  await run(c.env.DB, 'DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, c.get('session')?.id ?? '');
  await audit(c.env.DB, { userId: user.id, action: 'account.sessions_revoked', ip: clientIp(c) });
  return c.json({ ok: true });
});

account.get('/trusted-senders', async (c) => {
  const user = currentUser(c);
  return c.json(await all<{ pattern: string }>(c.env.DB, 'SELECT pattern FROM trusted_senders WHERE user_id = ? ORDER BY pattern', user.id));
});

account.post('/trusted-senders', async (c) => {
  const user = currentUser(c);
  const { pattern } = await body(c, trustedSenderSchema);
  await run(c.env.DB, 'INSERT OR IGNORE INTO trusted_senders (user_id, pattern) VALUES (?, ?)', user.id, pattern.toLowerCase());
  return c.json({ ok: true });
});

account.delete('/trusted-senders/:pattern', async (c) => {
  const user = currentUser(c);
  await run(c.env.DB, 'DELETE FROM trusted_senders WHERE user_id = ? AND pattern = ?', user.id, decodeURIComponent(c.req.param('pattern')));
  return c.json({ ok: true });
});

// Inbox API keys. The key is shown once, when created; only its hash is stored.
const MAX_API_KEYS = 20;

account.get('/api-keys', async (c) => {
  const user = currentUser(c);
  const rows = await all<{ id: number; name: string; prefix: string; scopes: string; mailbox_ids: string | null; created_at: number; expires_at: number | null; last_used_at: number | null; last_used_ip: string | null }>(
    c.env.DB,
    'SELECT id, name, prefix, scopes, mailbox_ids, created_at, expires_at, last_used_at, last_used_ip FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
    user.id,
  );
  return c.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: parseJson<string[]>(r.scopes, []),
      mailboxIds: parseJson<number[] | null>(r.mailbox_ids, null),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      lastUsedIp: r.last_used_ip,
    })),
  );
});

account.post('/api-keys', async (c) => {
  const user = currentUser(c);
  const input = await body(c, apiKeySchema);
  const row = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', user.id);
  if (!row || !(await verifyPassword(input.password, row.password_hash))) throw new HttpError(400, 'wrong_password', 'Your password is not correct.');
  const count = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?', user.id);
  if ((count?.n ?? 0) >= MAX_API_KEYS) throw badRequest(`You can have at most ${MAX_API_KEYS} API keys. Delete one you no longer use.`);
  let mailboxIds: number[] | null = null;
  if (input.mailboxIds?.length) {
    const own = (await accessibleMailboxes(c.env.DB, user)).map((a) => a.mailboxId);
    mailboxIds = [...new Set(input.mailboxIds)];
    if (mailboxIds.some((id) => !own.includes(id))) throw badRequest('You can only limit a key to mailboxes you are a member of.');
  }
  const scopes = [...new Set(input.scopes)];
  const { key, prefix, hash } = await newApiKey();
  const id = newId();
  const now = Date.now();
  const expiresAt = input.expiresInDays ? now + input.expiresInDays * 86_400_000 : null;
  await run(
    c.env.DB,
    'INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, mailbox_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    user.id,
    input.name,
    prefix,
    hash,
    JSON.stringify(scopes),
    mailboxIds ? JSON.stringify(mailboxIds) : null,
    now,
    expiresAt,
  );
  await audit(c.env.DB, { userId: user.id, action: 'account.api_key_created', target: prefix, details: { name: input.name, scopes, mailboxIds }, ip: clientIp(c) });
  return c.json({ id, key, name: input.name, prefix, scopes, mailboxIds, createdAt: now, expiresAt, lastUsedAt: null, lastUsedIp: null });
});

account.delete('/api-keys/:id', async (c) => {
  const user = currentUser(c);
  const id = Number(c.req.param('id'));
  const key = await first<{ prefix: string }>(c.env.DB, 'SELECT prefix FROM api_keys WHERE id = ? AND user_id = ?', id, user.id);
  if (!key) throw notFound('API key not found.');
  await run(c.env.DB, 'DELETE FROM api_keys WHERE id = ?', id);
  await audit(c.env.DB, { userId: user.id, action: 'account.api_key_deleted', target: key.prefix, ip: clientIp(c) });
  return c.json({ ok: true });
});
