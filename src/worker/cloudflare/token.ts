// Token checks: is it valid, and which permissions does it have? Cloudflare has no endpoint that
// lists a token's permissions without extra rights, so each one is probed with a read request.
import type { Cloudflare } from './client';
import { CfError } from './client';
import { TOKEN_PERMISSIONS } from '../../shared/constants';
import { listAccounts } from './workers';

export interface TokenStatus {
  valid: boolean;
  kind: 'user' | 'account' | null;
  message?: string;
}

export async function verifyToken(cf: Cloudflare): Promise<TokenStatus> {
  try {
    const r = await cf.get<{ status: string }>('/user/tokens/verify');
    if (r.status === 'active') return { valid: true, kind: 'user' };
    return { valid: false, kind: 'user', message: `Token status is ${r.status}.` };
  } catch {
    // Account-owned tokens verify at /accounts/{id}/tokens/verify instead.
  }
  let accounts;
  try {
    accounts = await listAccounts(cf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      valid: false,
      kind: null,
      message: /invalid api token|1000/i.test(msg)
        ? 'Cloudflare rejected this token. Check that it was copied completely and is not expired.'
        : `The token works but cannot list your account (${msg}). Add the Account Settings: Read permission.`,
    };
  }
  for (const a of accounts) {
    try {
      const r = await cf.get<{ status: string }>(`/accounts/${a.id}/tokens/verify`);
      if (r.status === 'active') return { valid: true, kind: 'account' };
    } catch {
      // try the next account
    }
  }
  // A user token that can list accounts is valid even if the verify endpoints disagree.
  return accounts.length ? { valid: true, kind: 'user' } : { valid: false, kind: null, message: 'Cloudflare rejected this token.' };
}

export interface PermissionCheck {
  key: string;
  name: string;
  scope: string;
  access: string;
  why: string;
  optional: boolean;
  ok: boolean;
  // Zone permissions can only be probed on a zone: with none in the account they stay unknown.
  untested?: boolean;
  error?: string;
}

type ProbeResult = { ok: boolean; untested?: boolean; error?: string };
const noZone: ProbeResult = { ok: false, untested: true, error: 'No zone to test with.' };

async function probe(fn: () => Promise<unknown>, okCodes: number[] = []): Promise<ProbeResult> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    // Some "errors" still prove access, e.g. R2 not yet enabled on the account (10042).
    if (e instanceof CfError && okCodes.some((c) => e.has(c))) return { ok: true };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function checkPermissions(cf: Cloudflare, accountId: string, zoneId: string | null): Promise<PermissionCheck[]> {
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const probes: Record<string, () => Promise<ProbeResult>> = {
    zone: () => probe(() => cf.get('/zones?per_page=5')),
    dns: () => (zoneId ? probe(() => cf.get(`/zones/${zoneId}/dns_records?per_page=5`)) : Promise.resolve(noZone)),
    // Email Routing's settings (status, enable, its DNS) sit under Zone Settings, not Email Routing Rules.
    zone_settings: () => (zoneId ? probe(() => cf.get(`/zones/${zoneId}/email/routing`)) : Promise.resolve(noZone)),
    email_routing_rules: () =>
      zoneId ? probe(() => cf.get(`/zones/${zoneId}/email/routing/rules?per_page=5`)) : Promise.resolve(noZone),
    workers_routes: () =>
      zoneId ? probe(() => cf.get(`/zones/${zoneId}/workers/routes`)) : Promise.resolve(noZone),
    analytics: () =>
      zoneId
        ? probe(() =>
            cf.graphql(
              'query($z: string, $d: Time) { viewer { zones(filter: {zoneTag: $z}) { emailRoutingAdaptive(limit: 1, filter: {datetime_geq: $d}) { datetime } } } }',
              { z: zoneId, d: day },
            ),
          )
        : Promise.resolve(noZone),
    workers_scripts: () => probe(() => cf.get(`/accounts/${accountId}/workers/scripts`)),
    email_routing_addresses: () => probe(() => cf.get(`/accounts/${accountId}/email/routing/addresses?per_page=5`)),
    account_analytics: () =>
      probe(() =>
        cf.graphql(
          'query($a: string, $d: Time) { viewer { accounts(filter: {accountTag: $a}) { workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $d}) { sum { requests } } } } }',
          { a: accountId, d: day },
        ),
      ),
    account_settings: () => probe(() => cf.get(`/accounts/${accountId}`)),
    workers_r2: () => probe(() => cf.get(`/accounts/${accountId}/r2/buckets`), [10042]),
  };
  const results = await Promise.all(
    TOKEN_PERMISSIONS.map(async (p) => {
      const r = await probes[p.key]();
      return { key: p.key, name: p.name, scope: p.scope, access: p.access, why: p.why, optional: p.optional, ...r };
    }),
  );
  return results;
}

export interface Zone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
}

export async function listZones(cf: Cloudflare, accountId?: string | null): Promise<Zone[]> {
  const q = accountId ? `/zones?account.id=${accountId}` : '/zones';
  return cf.paginate<Zone>(q, 50, 10);
}
