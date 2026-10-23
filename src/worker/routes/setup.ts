// First-run setup API. Every endpoint here stops working once the instance is claimed.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { body } from '../lib/validate';
import { claimSchema, setupTokenSchema } from '../../shared/schemas';
import { isSetupComplete, loadSettings } from '../db/settings';
import { conflict, HttpError } from '../lib/errors';
import { safeEqual } from '../lib/crypto';
import { setupStatus, saveToken } from '../services/setup';
import { claimInstance } from '../services/users';
import { inspectZone } from '../services/domains';
import { Cloudflare, cfFromEnv, DEFAULT_CF_API } from '../cloudflare/client';
import { verifyToken } from '../cloudflare/token';
import { createSession } from '../auth/session';
import { assertNotLimited, clientIpKey, KEY_CHECK_PER_IP, recordFailure } from '../auth/rate-limit';
import { clientIp } from '../auth/middleware';

export const setup = new Hono<AppBindings>();

setup.use('*', async (c, next) => {
  if (await isSetupComplete(c.env.DB)) throw conflict('This instance is already set up.', 'already_setup');
  return next();
});

setup.get('/status', async (c) => {
  const status = await setupStatus(c.env, new URL(c.req.url).host, c.req.query('refresh') === '1');
  return c.json(status);
});

setup.post('/token', async (c) => {
  const { token } = await body(c, setupTokenSchema);
  const check = await verifyToken(new Cloudflare(token, c.env.CF_API_BASE || DEFAULT_CF_API));
  if (!check.valid) throw new HttpError(400, 'invalid_token', check.message ?? 'Cloudflare rejected this token.');
  await saveToken(c.env, token);
  return c.json({ ok: true });
});

setup.get('/zones/:zoneId', async (c) => {
  const settings = await loadSettings(c.env.DB, true);
  const cf = await cfFromEnv(c.env, settings);
  if (!cf) throw new HttpError(409, 'no_cf_token', 'Connect a Cloudflare token first.');
  return c.json(await inspectZone(cf, c.req.param('zoneId'), settings.cfWorkerName));
});

setup.post('/claim', async (c) => {
  const input = await body(c, claimSchema);
  const ip = clientIp(c);
  await assertNotLimited(c.env.DB, clientIpKey('setup', ip), KEY_CHECK_PER_IP);
  if (!c.env.ENCRYPTION_KEY || !(await safeEqual(input.setupKey.trim(), c.env.ENCRYPTION_KEY))) {
    await recordFailure(c.env.DB, clientIpKey('setup', ip), KEY_CHECK_PER_IP);
    throw new HttpError(403, 'bad_setup_key', 'That is not the ENCRYPTION_KEY of this deployment.');
  }
  const settings = await loadSettings(c.env.DB, true);
  if (!settings.cfWorkerName) throw new HttpError(409, 'worker_unknown', 'Finish the checks above first.');
  const cf = await cfFromEnv(c.env, settings);
  if (!cf) throw new HttpError(409, 'no_cf_token', 'Connect a Cloudflare token first.');
  const inspection = await inspectZone(cf, input.zoneId, settings.cfWorkerName);
  if (inspection.mxState === 'other' && !input.replaceMx) {
    throw new HttpError(409, 'mx_conflict', `${inspection.name} already receives mail elsewhere. Confirm that OpenInbox should take over its mail.`, {
      mx: inspection.mx,
    });
  }
  const origin = new URL(c.req.url).origin;
  const { userId, domainId } = await claimInstance(c.env, cf, input, origin, ip);
  await createSession(c, userId);
  return c.json({ ok: true, domainId });
});
