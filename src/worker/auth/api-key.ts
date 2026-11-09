// Inbox API keys: `Authorization: Bearer oik_…` on /api/v1. A key acts as its user, limited to its
// scopes and, optionally, to some of the user's mailboxes. Keys are 192 random bits, so a plain
// SHA-256 is enough to store them (no slow hash needed, unlike passwords).
import type { Context, MiddlewareHandler } from 'hono';
import type { ApiKeyInfo, AppBindings } from '../types';
import { API_KEY_PREFIX, type ApiScope, type Role } from '../../shared/constants';
import { first } from '../db/db';
import { parseJson } from '../lib/json';
import { randomToken, sha256Hex } from '../lib/crypto';
import { forbidden, HttpError, notFound } from '../lib/errors';
import { MINUTE } from '../lib/time';
import { accessibleMailboxes, type MailboxAccess } from './access';
import { API_PER_USER, countUse } from './rate-limit';
import { clientIp } from './middleware';

export async function newApiKey(): Promise<{ key: string; prefix: string; hash: string }> {
  const key = API_KEY_PREFIX + randomToken(24);
  return { key, prefix: key.slice(0, 12), hash: await sha256Hex(key) };
}

interface KeyRow {
  id: number;
  user_id: number;
  scopes: string;
  mailbox_ids: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  email: string;
  name: string;
  role: Role;
  status: string;
  totp_enabled: number;
  preferences: string;
}

const KEY_RE = new RegExp(`^Bearer\\s+(${API_KEY_PREFIX}[A-Za-z0-9_-]{20,100})$`);

export const apiKeyAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const m = KEY_RE.exec((c.req.header('authorization') ?? '').trim());
  if (!m) throw new HttpError(401, 'unauthorized', `Send an API key as "Authorization: Bearer ${API_KEY_PREFIX}…". Create one in Settings > API keys.`);
  const db = c.env.DB;
  const row = await first<KeyRow>(
    db,
    `SELECT k.id, k.user_id, k.scopes, k.mailbox_ids, k.expires_at, k.last_used_at, u.email, u.name, u.role, u.status, u.totp_enabled, u.preferences
       FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`,
    await sha256Hex(m[1]),
  );
  const now = Date.now();
  if (!row || row.status !== 'active' || (row.expires_at !== null && row.expires_at <= now)) {
    throw new HttpError(401, 'invalid_api_key', 'This API key is not valid. It may have been deleted or expired, or its user disabled.');
  }
  const wait = await countUse(db, `api:user:${row.user_id}`, API_PER_USER);
  if (wait !== null) {
    throw new HttpError(429, 'rate_limited', `Too many requests: your API keys may make ${API_PER_USER.max} per minute together.`, { retryAfter: wait });
  }
  // Written at most once a minute, like session activity.
  if (!row.last_used_at || now - row.last_used_at > MINUTE) {
    c.executionCtx.waitUntil(
      db.prepare('UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?').bind(now, clientIp(c), row.id).run().catch(() => undefined),
    );
  }
  c.set('user', {
    id: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    mustChangePassword: false,
    totpEnabled: !!row.totp_enabled,
    preferences: parseJson(row.preferences, {}),
  });
  c.set('apiKey', { id: row.id, scopes: parseJson<ApiScope[]>(row.scopes, []), mailboxIds: parseJson<number[] | null>(row.mailbox_ids, null) });
  return next();
};

export function currentKey(c: Context<AppBindings>): ApiKeyInfo {
  const key = c.get('apiKey');
  if (!key) throw new HttpError(401, 'unauthorized', 'API key required.');
  return key;
}

export function requireScope(scope: ApiScope): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!currentKey(c).scopes.includes(scope)) throw forbidden(`This API key lacks the "${scope}" permission.`);
    return next();
  };
}

// The user's mailboxes, narrowed to the ones the key is limited to.
export async function keyMailboxes(c: Context<AppBindings>): Promise<MailboxAccess[]> {
  const key = currentKey(c);
  const access = await accessibleMailboxes(c.env.DB, c.get('user')!);
  return key.mailboxIds ? access.filter((a) => key.mailboxIds!.includes(a.mailboxId)) : access;
}

export function assertKeyMailbox(c: Context<AppBindings>, mailboxId: number): void {
  const ids = currentKey(c).mailboxIds;
  if (ids && !ids.includes(mailboxId)) throw notFound('Mailbox not found.');
}
