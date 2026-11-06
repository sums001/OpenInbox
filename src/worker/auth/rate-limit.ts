// Fixed-window attempt counters in D1, for login and other password or key checks.
import { tooMany } from '../lib/errors';

export interface Limit {
  max: number;
  windowMs: number;
}

export const LOGIN_PER_IP: Limit = { max: 20, windowMs: 15 * 60_000 };
export const LOGIN_PER_ACCOUNT: Limit = { max: 6, windowMs: 15 * 60_000 };
export const KEY_CHECK_PER_IP: Limit = { max: 6, windowMs: 15 * 60_000 };

export const clientIpKey = (scope: string, ip: string) => `${scope}:ip:${ip}`;
export const accountKey = (scope: string, email: string) => `${scope}:user:${email.toLowerCase()}`;

interface Row {
  count: number;
  window_start: number;
}

// Seconds until the key may try again, or null when it isn't limited.
export async function limitedFor(db: D1Database, key: string, limit: Limit): Promise<number | null> {
  const row = await db.prepare('SELECT count, window_start FROM auth_attempts WHERE key = ?').bind(key).first<Row>();
  const now = Date.now();
  if (row && now - row.window_start < limit.windowMs && row.count >= limit.max) return Math.ceil((row.window_start + limit.windowMs - now) / 1000);
  return null;
}

export function limitedError(retryAfter: number) {
  return tooMany(`Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`, retryAfter);
}

export async function assertNotLimited(db: D1Database, key: string, limit: Limit): Promise<void> {
  const retryAfter = await limitedFor(db, key, limit);
  if (retryAfter !== null) throw limitedError(retryAfter);
}

export async function recordFailure(db: D1Database, key: string, limit: Limit): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO auth_attempts (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END`,
    )
    .bind(key, now, now, limit.windowMs, now, limit.windowMs, now)
    .run();
}

// The network an address counts as for "signed in from here before": the IPv4 address itself, or
// the /64 of an IPv6 address, written out in full. Anything unrecognized stays as it is.
export function loginNetwork(ip: string): string | null {
  if (!ip || ip === 'unknown') return null;
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail, extra] = ip.split('::');
  if (extra !== undefined) return ip;
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

export async function rememberLogin(db: D1Database, userId: number, ip: string): Promise<void> {
  const network = loginNetwork(ip);
  if (!network) return;
  await db
    .prepare('INSERT INTO known_logins (user_id, network, last_at) VALUES (?, ?, ?) ON CONFLICT (user_id, network) DO UPDATE SET last_at = excluded.last_at')
    .bind(userId, network, Date.now())
    .run();
}

export async function knownLogin(db: D1Database, userId: number, ip: string): Promise<boolean> {
  const network = loginNetwork(ip);
  if (!network) return false;
  return !!(await db.prepare('SELECT 1 AS hit FROM known_logins WHERE user_id = ? AND network = ?').bind(userId, network).first());
}

export async function clearFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
}
