// Mail from the relay Workers OpenInbox installs in other Cloudflare accounts (services/relay.ts).
// Authenticated by the relay's secret; exempt from CSRF and sessions.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { badRequest } from '../lib/errors';
import { handleRelayed } from '../services/relay';

export const relay = new Hono<AppBindings>();

relay.post('/:accountId', async (c) => {
  const accountId = c.req.param('accountId');
  if (!/^[\w-]{1,64}$/.test(accountId)) throw badRequest('Not an account id.');
  return c.json(await handleRelayed(c.env, c.executionCtx as unknown as ExecutionContext, accountId, c.req.raw));
});
