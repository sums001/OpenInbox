// The Hono API. Static assets (the web app) are served by Cloudflare before the Worker runs;
// wrangler.jsonc sends only /api/* here (run_worker_first).
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppBindings } from './types';
import type { Env } from './env';
import { errorMessage, HttpError } from './lib/errors';
import { ensureMigrated } from './db/migrate';
import { EncryptionKeyError } from './lib/crypto';
import { CfError } from './cloudflare/client';
import { ProviderError } from './providers/types';
import { logError } from './lib/log';
import { isSetupComplete, loadSettings } from './db/settings';
import { loadSession } from './auth/session';
import { csrfProtection, requireAdmin, requireUser } from './auth/middleware';
import { setup } from './routes/setup';
import { auth } from './routes/auth';
import { account } from './routes/account';
import { mail } from './routes/mail';
import { compose } from './routes/compose';
import { admin } from './routes/admin';
import { webhooks } from './routes/webhooks';
import { devices } from './routes/devices';
import { api } from './routes/api';
import { apiKeyAuth } from './auth/api-key';
import { bimi } from './routes/bimi';

export const app = new Hono<AppBindings>().basePath('/api');

app.onError((err, c) => {
  if (err instanceof HttpError) {
    if (err.status === 429 && (err.details as { retryAfter?: number })?.retryAfter) {
      c.header('Retry-After', String((err.details as { retryAfter: number }).retryAfter));
    }
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  }
  if (err instanceof CfError) {
    return c.json({ error: { code: err.isAuth ? 'cloudflare_permission' : 'cloudflare_error', message: `Cloudflare: ${err.message}` } }, 502);
  }
  if (err instanceof ProviderError) return c.json({ error: { code: 'provider_error', message: err.message } }, 502);
  if (err instanceof EncryptionKeyError) return c.json({ error: { code: 'encryption_key', message: err.message } }, 500);
  logError('api.unhandled', err, { path: c.req.path });
  return c.json({ error: { code: 'internal', message: 'Something went wrong. Check the Worker logs for details.' } }, 500);
});

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such API route.' } }, 404));

// Security headers for every API response.
app.use('*', async (c, next) => {
  await next();
  // Drain request bodies a handler didn't read, so the HTTP connection can be reused.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.raw.body && !c.req.raw.bodyUsed) {
    await c.req.raw.arrayBuffer().catch(() => undefined);
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

// The Inbox API authenticates with a key in the Authorization header, never with cookies, so
// apps running in a browser, on any site, may call it (like GitHub's API): the browser adds no
// credential to these requests. /health lets such an app check an address is OpenInbox.
const API_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Access-Control-Max-Age': '86400',
};
const apiCors: MiddlewareHandler<AppBindings> = async (c, next) => {
  for (const [k, v] of Object.entries(API_CORS)) c.header(k, v);
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
};
app.use('/v1/*', apiCors);
app.use('/health', apiCors);
app.use('/devices/pair', apiCors);
app.use('/devices/pair/*', apiCors);

app.get('/health', (c) => c.json({ ok: true, version: __APP_VERSION__ }));

async function migrated(env: Env): Promise<void> {
  if (!env.DB) throw new HttpError(500, 'no_database', 'This Worker has no D1 database bound as DB. Redeploy it from its repository so Cloudflare creates one.');
  try {
    await ensureMigrated(env.DB);
  } catch (e) {
    logError('db.migrate_failed', e);
    throw new HttpError(500, 'migration_failed', errorMessage(e));
  }
}

app.use('*', csrfProtection);

// Session and the setup gate: until the owner claims the instance, only setup and session
// endpoints answer.
app.use('*', async (c, next) => {
  await migrated(c.env);
  c.set('settings', await loadSettings(c.env.DB));
  const path = c.req.path;
  c.set('apiKey', null);
  if (path.startsWith('/api/webhooks/') || path.startsWith('/api/bimi/')) return next();
  // The Inbox API never reads the session cookie; apiKeyAuth sets the user from the key.
  if (path.startsWith('/api/v1/')) {
    if (!(await isSetupComplete(c.env.DB))) throw new HttpError(409, 'setup_required', 'Finish setup first.');
    return next();
  }
  const s = await loadSession(c);
  c.set('user', s?.user ?? null);
  c.set('session', s?.session ?? null);
  if (!path.startsWith('/api/setup/') && path !== '/api/auth/session' && !(await isSetupComplete(c.env.DB))) {
    throw new HttpError(409, 'setup_required', 'Finish setup first.');
  }
  return next();
});

app.route('/setup', setup);
app.route('/auth', auth);
app.route('/webhooks', webhooks);
app.route('/devices', devices);
app.route('/bimi', bimi);

app.use('/v1/*', apiKeyAuth);
app.route('/v1', api);

// A forced password change still allows changing the password (and reading the session).
app.use('/account/*', async (c, next) => {
  if (c.req.path === '/api/account/password' && c.get('user') && !c.get('session')?.mfaPending) return next();
  return requireUser(c, next);
});
app.route('/account', account);

app.use('/admin/*', requireUser, requireAdmin);
app.route('/admin', admin);

app.use('*', requireUser);
app.route('/', mail);
app.route('/', compose);
