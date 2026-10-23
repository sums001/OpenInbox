// D1-backed sessions. The cookie holds a random token; D1 stores only its SHA-256, so a database
// leak doesn't hand out live sessions.
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppBindings, SessionInfo, SessionUser } from '../types';
import { randomToken, sha256Hex } from '../lib/crypto';
import { DAY, MINUTE } from '../lib/time';
import { parseJson } from '../lib/json';
import type { Role } from '../../shared/constants';

export const SESSION_COOKIE = 'oi_session';
export const CSRF_COOKIE = 'oi_csrf';
const SESSION_DAYS = 30;

interface SessionRow {
  id: string;
  user_id: number;
  mfa_pending: number;
  expires_at: number;
  last_seen_at: number;
  email: string;
  name: string;
  role: Role;
  status: string;
  must_change_password: number;
  totp_enabled: number;
  preferences: string;
}

function secure(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

export async function createSession(c: Context<AppBindings>, userId: number, mfaPending = false): Promise<void> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, csrf, mfa_pending, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      userId,
      randomToken(16),
      mfaPending ? 1 : 0,
      c.req.header('cf-connecting-ip') ?? null,
      (c.req.header('user-agent') ?? '').slice(0, 300),
      now,
      now,
      now + SESSION_DAYS * DAY,
    )
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secure(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function loadSession(c: Context<AppBindings>): Promise<{ user: SessionUser; session: SessionInfo } | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const id = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.mfa_pending, s.expires_at, s.last_seen_at, u.email, u.name, u.role, u.status,
            u.must_change_password, u.totp_enabled, u.preferences
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<SessionRow>();
  const now = Date.now();
  if (!row || row.expires_at < now || row.status !== 'active') return null;
  // Sliding expiry, written at most every 10 minutes to spare D1's daily write budget.
  if (now - row.last_seen_at > 10 * MINUTE) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
        .bind(now, now + SESSION_DAYS * DAY, id)
        .run()
        .catch(() => undefined),
    );
  }
  return {
    session: { id: row.id, mfaPending: !!row.mfa_pending },
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      mustChangePassword: !!row.must_change_password,
      totpEnabled: !!row.totp_enabled,
      preferences: parseJson(row.preferences, {}),
    },
  };
}

export async function destroySession(c: Context<AppBindings>): Promise<void> {
  const session = c.get('session');
  if (session) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(session.id).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function ensureCsrfCookie(c: Context<AppBindings>): string {
  let token = getCookie(c, CSRF_COOKIE);
  if (!token || token.length < 16 || token.length > 100) {
    token = randomToken(18);
    // Readable by the app's JavaScript (double-submit pattern), never sent cross-site.
    setCookie(c, CSRF_COOKIE, token, { httpOnly: false, secure: secure(c), sameSite: 'Strict', path: '/', maxAge: 365 * 86_400 });
  }
  return token;
}
