// Forwarding destinations are Email Routing destination addresses. Cloudflare emails each one a
// verification link and message.forward() works only once it has been clicked, which happens in
// someone else's inbox: the verified state lives on Cloudflare, and this keeps the local copy in step.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { all, run } from '../db/db';
import { cfFromEnv } from '../cloudflare/client';
import { listDestinations } from '../cloudflare/email-routing';

export interface Destination {
  address: string;
  verified: boolean;
}

// The stored destinations, with the verification state refreshed from Cloudflare when asked to
// (always), or only while one is still waiting (pending). Falls back to the stored state when
// Cloudflare can't be reached or the token lacks Email Routing Addresses access.
export async function forwardDestinations(env: Env, settings: AppSettings, refresh: 'always' | 'pending'): Promise<Destination[]> {
  const local = await all<{ address: string; verified_at: number | null }>(env.DB, 'SELECT address, verified_at FROM forward_destinations ORDER BY address');
  const wanted = refresh === 'always' ? local.length > 0 : local.some((l) => !l.verified_at);
  if (wanted && settings.cfAccountId) {
    try {
      const cf = await cfFromEnv(env, settings);
      if (cf) {
        const remote = await listDestinations(cf, settings.cfAccountId);
        for (const l of local) {
          const r = remote.find((x) => x.email.toLowerCase() === l.address.toLowerCase());
          const verified = r?.verified ? Date.parse(r.verified) : null;
          if (verified !== l.verified_at) {
            await run(env.DB, 'UPDATE forward_destinations SET verified_at = ? WHERE address = ?', verified, l.address);
            l.verified_at = verified;
          }
        }
      }
    } catch {
      // show the stored state
    }
  }
  return local.map((l) => ({ address: l.address, verified: !!l.verified_at }));
}
