import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppBindings } from '../types';
import { forbidden, HttpError, unauthorized } from '../lib/errors';
import { CSRF_COOKIE } from './session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF: state-changing requests must come from this origin and echo the CSRF cookie in a header
// (double submit). Webhooks are exempt; they are authenticated by signatures or secret URLs.
export const csrfProtection: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || c.req.path.startsWith('/api/webhooks/')) return next();
  const origin = c.req.header('origin');
  const self = new URL(c.req.url).origin;
  if (origin && origin !== self) throw new HttpError(403, 'csrf', 'Cross-site request blocked.');
  const site = c.req.header('sec-fetch-site');
  if (!origin && site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'csrf', 'Cross-site request blocked.');
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header('x-csrf-token');
  if (!cookie || !header || cookie !== header) throw new HttpError(403, 'csrf', 'Your session token is missing or stale. Reload the page.');
  return next();
};

export function currentUser(c: Context<AppBindings>) {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

// Signed in, second factor done, and no pending forced password change.
export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session) throw unauthorized();
  if (session.mfaPending) throw new HttpError(401, 'mfa_required', 'Enter your two-factor code.');
  if (user.mustChangePassword) throw new HttpError(403, 'password_change_required', 'Choose a new password first.');
  return next();
};

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const user = c.get('user');
  if (!user || (user.role !== 'admin' && user.role !== 'owner')) throw forbidden('Only admins can do this.');
  return next();
};

export const requireOwner: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get('user')?.role !== 'owner') throw forbidden('Only the owner can do this.');
  return next();
};

export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}
