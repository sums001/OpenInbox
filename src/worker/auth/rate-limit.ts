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

export async function assertNotLimited(db: D1Database, key: string, limit: Limit): Promise<void> {
  const row = await db.prepare('SELECT count, window_start FROM auth_attempts WHERE key = ?').bind(key).first<Row>();
  const now = Date.now();
  if (row && now - row.window_start < limit.windowMs && row.count >= limit.max) {
    const retryAfter = Math.ceil((row.window_start + limit.windowMs - now) / 1000);
    throw tooMany(`Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`, retryAfter);
  }
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

export async function clearFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
}
