// Public tracking endpoints, in the mail recipients' clients: the open pixel and the click
// redirect. No session; the random token in the URL identifies the message. Unknown tokens still
// get the pixel, and links of a deleted message still redirect. Events are recorded after the
// response, so a database hiccup never keeps a reader from the link.
import { Hono, type Context } from 'hono';
import type { AppBindings } from '../types';
import { clientIp } from '../auth/middleware';
import { notFound } from '../lib/errors';
import { logError } from '../lib/log';
import { lookupHit, type Hit } from '../services/tracking';

export const tracking = new Hono<AppBindings>();

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
const TOKEN = /^[A-Za-z0-9_-]{16,40}$/;

function hit(c: Context<AppBindings>): Hit {
  const cf = c.req.raw.cf as { asOrganization?: string; country?: string } | undefined;
  return { method: c.req.method, userAgent: c.req.header('user-agent') ?? '', ip: clientIp(c) === 'unknown' ? null : clientIp(c), country: cf?.country ?? null, org: cf?.asOrganization ?? '' };
}

tracking.get('/:file', (c) => {
  const token = c.req.param('file').replace(/\.gif$/, '');
  if (TOKEN.test(token)) {
    const h = hit(c);
    c.executionCtx.waitUntil(
      lookupHit(c.env.DB, token, 'open', null)
        .then((found) => found?.record(h))
        .catch((e) => logError('tracking.open_failed', e)),
    );
  }
  return new Response(GIF, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, private, max-age=0' } });
});

tracking.get('/:token/:link', async (c) => {
  const token = c.req.param('token');
  const link = Number(c.req.param('link'));
  if (!TOKEN.test(token) || !Number.isInteger(link) || link < 0) throw notFound('Unknown link.');
  const found = await lookupHit(c.env.DB, token, 'click', link);
  if (!found?.url) throw notFound('Unknown link.');
  c.executionCtx.waitUntil(found.record(hit(c)).catch((e) => logError('tracking.click_failed', e)));
  c.header('Cache-Control', 'no-store');
  return c.redirect(found.url, 302);
});
