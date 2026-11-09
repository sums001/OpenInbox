// Public sender logo files (BIMI), fetched by mail apps. No session; the logo is an admin's SVG,
// so it is served with a CSP that sandboxes it and blocks everything it could load or run.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { notFound } from '../lib/errors';
import { senderLogoFile } from '../services/bimi';

export const bimi = new Hono<AppBindings>();

bimi.get('/:domain/:file', async (c) => {
  const f = await senderLogoFile(c.env, c.req.param('domain'), c.req.param('file'));
  if (!f) throw notFound('No such logo.');
  return c.body(f.body, 200, {
    'Content-Type': `${f.type}; charset=utf-8`,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'public, max-age=3600',
  });
});
