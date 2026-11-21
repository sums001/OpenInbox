// The phone's side of connecting by QR code (services/devices.ts). No session or key yet: a
// pairing code proves the request, then the secret it returns. Exempt from CSRF and sessions;
// wrong codes are rate-limited per address.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { body, intParam } from '../lib/validate';
import { HttpError } from '../lib/errors';
import { pairClaimSchema, pairCollectSchema } from '../../shared/schemas';
import { clientIp } from '../auth/middleware';
import { assertNotLimited, clientIpKey, PAIR_PER_IP, recordFailure } from '../auth/rate-limit';
import { claimPairing, collectPairing } from '../services/devices';

export const devices = new Hono<AppBindings>();

devices.post('/pair', async (c) => {
  const limitKey = clientIpKey('pair', clientIp(c));
  await assertNotLimited(c.env.DB, limitKey, PAIR_PER_IP);
  const input = await body(c, pairClaimSchema);
  const claimed = await claimPairing(c.env, input);
  if (!claimed) {
    await recordFailure(c.env.DB, limitKey, PAIR_PER_IP);
    throw new HttpError(404, 'pairing_not_found', 'This code is not valid or has expired. Show a new QR code in OpenInbox: Settings > Devices > Connect a phone.');
  }
  return c.json(claimed);
});

devices.post('/pair/:id', async (c) => {
  const { secret } = await body(c, pairCollectSchema);
  return c.json(await collectPairing(c.env, intParam(c, 'id'), secret));
});
