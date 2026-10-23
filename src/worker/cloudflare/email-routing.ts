// Email Routing: enable it on a zone, route the catch-all to this Worker, manage forwarding
// destination addresses. Every call here is safe to repeat.
import type { Cloudflare } from './client';
import { CfError } from './client';

export interface RoutingSettings {
  enabled: boolean;
  status: string; // ready | unconfigured | misconfigured | misconfigured/locked | unlocked
  name?: string;
}

export interface RoutingRule {
  id?: string;
  tag?: string;
  name?: string;
  enabled: boolean;
  priority?: number;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
}

export async function getRouting(cf: Cloudflare, zoneId: string): Promise<RoutingSettings> {
  return cf.get<RoutingSettings>(`/zones/${zoneId}/email/routing`);
}

// Enables Email Routing on the zone apex. Cloudflare adds its MX, SPF and DKIM records if they
// are missing and reuses existing ones. An empty body targets the apex (Phase 0: passing a name
// is for subdomains and returns error 2007 on the apex).
export async function enableRouting(cf: Cloudflare, zoneId: string): Promise<RoutingSettings> {
  try {
    return await cf.request<RoutingSettings>('POST', `/zones/${zoneId}/email/routing/dns`, {});
  } catch (e) {
    // Older zones only accept the legacy enable endpoint.
    if (e instanceof CfError && !e.isAuth) return cf.request<RoutingSettings>('POST', `/zones/${zoneId}/email/routing/enable`, {});
    throw e;
  }
}

// DNS records Email Routing still needs, as Cloudflare reports them.
export async function routingDnsProblems(cf: Cloudflare, zoneId: string): Promise<string[]> {
  try {
    const r = await cf.get<{ errors?: { code: string; missing?: { type: string; name: string } }[] } | unknown[]>(
      `/zones/${zoneId}/email/routing/dns`,
    );
    if (Array.isArray(r)) return [];
    return (r.errors ?? []).map((e) => (e.missing ? `Missing ${e.missing.type} record at ${e.missing.name}` : e.code));
  } catch {
    return [];
  }
}

export async function getCatchAll(cf: Cloudflare, zoneId: string): Promise<RoutingRule | null> {
  try {
    return await cf.get<RoutingRule>(`/zones/${zoneId}/email/routing/rules/catch_all`);
  } catch (e) {
    if (e instanceof CfError && e.status === 404) return null;
    throw e;
  }
}

export function catchAllTargetsWorker(rule: RoutingRule | null, worker: string): boolean {
  return !!rule?.enabled && rule.actions.some((a) => a.type === 'worker' && a.value?.includes(worker));
}

export async function setCatchAllToWorker(cf: Cloudflare, zoneId: string, worker: string): Promise<RoutingRule> {
  return cf.request<RoutingRule>('PUT', `/zones/${zoneId}/email/routing/rules/catch_all`, {
    name: 'OpenInbox catch-all',
    enabled: true,
    matchers: [{ type: 'all' }],
    actions: [{ type: 'worker', value: [worker] }],
  });
}

export async function disableCatchAll(cf: Cloudflare, zoneId: string): Promise<void> {
  await cf.request('PUT', `/zones/${zoneId}/email/routing/rules/catch_all`, {
    name: 'Catch-all',
    enabled: false,
    matchers: [{ type: 'all' }],
    actions: [{ type: 'drop' }],
  });
}

export async function listRules(cf: Cloudflare, zoneId: string): Promise<RoutingRule[]> {
  return cf.paginate<RoutingRule>(`/zones/${zoneId}/email/routing/rules`, 50, 5);
}

// Enabled rules for specific addresses take precedence over the catch-all, so mail for them never
// reaches OpenInbox. Returns those addresses.
export function conflictingRules(rules: RoutingRule[], worker: string): { id?: string; address: string; action: string }[] {
  return rules
    .filter((r) => r.enabled && r.matchers.some((m) => m.type === 'literal'))
    .filter((r) => !r.actions.some((a) => a.type === 'worker' && a.value?.includes(worker)))
    .map((r) => ({
      id: r.id ?? r.tag,
      address: r.matchers.find((m) => m.type === 'literal')?.value ?? '',
      action: r.actions.map((a) => (a.value?.length ? `${a.type} ${a.value.join(', ')}` : a.type)).join('; '),
    }));
}

export async function disableRule(cf: Cloudflare, zoneId: string, rule: RoutingRule): Promise<void> {
  const id = rule.id ?? rule.tag;
  await cf.request('PUT', `/zones/${zoneId}/email/routing/rules/${id}`, { ...rule, enabled: false });
}

export interface DestinationAddress {
  id?: string;
  tag?: string;
  email: string;
  verified: string | null;
}

export async function listDestinations(cf: Cloudflare, accountId: string): Promise<DestinationAddress[]> {
  return cf.paginate<DestinationAddress>(`/accounts/${accountId}/email/routing/addresses`, 50, 10);
}

// Cloudflare emails a verification link to the address; message.forward() works once verified.
export async function createDestination(cf: Cloudflare, accountId: string, email: string): Promise<DestinationAddress> {
  return cf.request<DestinationAddress>('POST', `/accounts/${accountId}/email/routing/addresses`, { email });
}

export async function deleteDestination(cf: Cloudflare, accountId: string, id: string): Promise<void> {
  await cf.request('DELETE', `/accounts/${accountId}/email/routing/addresses/${id}`);
}
