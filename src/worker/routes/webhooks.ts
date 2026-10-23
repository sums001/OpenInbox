// Provider delivery webhooks. Authenticated by signature (Resend) or a secret URL (Brevo, Mailjet);
// exempt from CSRF and sessions.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { intParam } from '../lib/validate';
import { handleBrevoWebhook, handleMailjetWebhook, handleResendWebhook } from '../services/webhooks';

export const webhooks = new Hono<AppBindings>();

webhooks.post('/resend/:id', async (c) => {
  await handleResendWebhook(c.env, intParam(c, 'id'), c.req.raw);
  return c.json({ ok: true });
});

webhooks.post('/brevo/:id/:token', async (c) => {
  await handleBrevoWebhook(c.env, intParam(c, 'id'), c.req.param('token'), c.req.raw);
  return c.json({ ok: true });
});

webhooks.post('/mailjet/:id/:token', async (c) => {
  await handleMailjetWebhook(c.env, intParam(c, 'id'), c.req.param('token'), c.req.raw);
  return c.json({ ok: true });
});
