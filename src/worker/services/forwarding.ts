// Forwarding destinations are Email Routing destination addresses. Cloudflare emails each one a
// verification link and message.forward() works only once it has been clicked, which happens in
// someone else's inbox: the verified state lives on Cloudflare, and this keeps the local copy in step.
// Addresses verified in Cloudflare before OpenInbox, or added in its dashboard, show up here too.
//
// Cloudflare's own forwarding rules for single addresses (alice@ → alice@gmail.com) take precedence
// over the catch-all, so that mail never reaches OpenInbox. They are listed for the admin, who can
// turn one off or move it in: a mailbox for the address that keeps a copy and forwards as before.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { all, first, run } from '../db/db';
import { cfFromEnv } from '../cloudflare/client';
import { disableRule, listDestinations, listRules, setRuleEnabled, type RoutingRule } from '../cloudflare/email-routing';
import { notFound } from '../lib/errors';
import { parseJson } from '../lib/json';
import { createMailbox } from './mailboxes';
import { getDomain, requireCf } from './domains';

export interface Destination {
  address: string;
  verified: boolean;
}

// The stored destinations, with the verification state refreshed from Cloudflare when asked to
// (always), or only while one is still waiting (pending). Falls back to the stored state when
// Cloudflare can't be reached or the token lacks Email Routing Addresses access.
export async function forwardDestinations(env: Env, settings: AppSettings, refresh: 'always' | 'pending'): Promise<Destination[]> {
  const local = await all<{ address: string; verified_at: number | null }>(env.DB, 'SELECT address, verified_at FROM forward_destinations ORDER BY address');
  const wanted = refresh === 'always' || local.some((l) => !l.verified_at);
  if (wanted && settings.cfAccountId) {
    try {
      const cf = await cfFromEnv(env, settings);
      if (cf) {
        const remote = await listDestinations(cf, settings.cfAccountId);
        if (refresh === 'always') await importDestinations(env.DB, local, remote);
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

// Adds the Cloudflare destination addresses not stored here yet, to `local` too.
async function importDestinations(
  db: D1Database,
  local: { address: string; verified_at: number | null }[],
  remote: { id?: string; tag?: string; email: string; verified: string | null }[],
): Promise<void> {
  const known = new Set(local.map((l) => l.address.toLowerCase()));
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const r of remote) {
    const address = r.email.toLowerCase();
    if (known.has(address)) continue;
    known.add(address);
    const verified = r.verified ? Date.parse(r.verified) : null;
    stmts.push(db.prepare('INSERT INTO forward_destinations (address, cf_id, verified_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (address) DO NOTHING').bind(address, r.id ?? r.tag ?? null, verified, now));
    local.push({ address, verified_at: verified });
  }
  if (!stmts.length) return;
  await db.batch(stmts);
  local.sort((a, b) => a.address.localeCompare(b.address));
}

export interface ForwardRule {
  domainId: number;
  domain: string;
  ruleId: string;
  address: string;
  to: string[];
  enabled: boolean;
  // A mailbox in OpenInbox has this address already.
  inOpenInbox: boolean;
}

function forwardOf(rule: RoutingRule): { address: string; to: string[] } | null {
  const address = rule.matchers.find((m) => m.type === 'literal' && m.value)?.value?.toLowerCase();
  const to = rule.actions.find((a) => a.type === 'forward')?.value ?? [];
  return address && to.length ? { address, to: to.map((t) => t.toLowerCase()) } : null;
}

// Cloudflare's forwarding rules for single addresses, on every domain here.
export async function forwardRules(env: Env, settings: AppSettings): Promise<ForwardRule[]> {
  const cf = await cfFromEnv(env, settings);
  if (!cf) return [];
  const domains = await all<{ id: number; name: string; zone_id: string }>(env.DB, "SELECT id, name, zone_id FROM domains WHERE status != 'disabled' ORDER BY name LIMIT 40");
  const mine = new Set((await all<{ address: string }>(env.DB, 'SELECT address FROM addresses')).map((a) => a.address.toLowerCase()));
  const out: ForwardRule[] = [];
  await Promise.all(
    domains.map(async (d) => {
      let rules: RoutingRule[];
      try {
        rules = await listRules(cf, d.zone_id);
      } catch {
        return; // the token can't read this zone's rules: nothing to show
      }
      for (const r of rules) {
        const f = forwardOf(r);
        if (f) out.push({ domainId: d.id, domain: d.name, ruleId: (r.id ?? r.tag)!, ...f, enabled: r.enabled, inOpenInbox: mine.has(f.address) });
      }
    }),
  );
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

async function findRule(env: Env, settings: AppSettings, domainId: number, ruleId: string) {
  const cf = await requireCf(env, settings);
  const d = await getDomain(env.DB, domainId);
  const rule = (await listRules(cf, d.zone_id)).find((r) => (r.id ?? r.tag) === ruleId);
  if (!rule) throw notFound('That rule is no longer in Cloudflare.');
  return { cf, d, rule };
}

export async function setForwardRuleEnabled(env: Env, settings: AppSettings, domainId: number, ruleId: string, enabled: boolean): Promise<void> {
  const { cf, d, rule } = await findRule(env, settings, domainId, ruleId);
  await setRuleEnabled(cf, d.zone_id, rule, enabled);
}

// Moves a Cloudflare forwarding rule into OpenInbox: a mailbox for the address (a new one with no
// members, or the one that has it) forwards to the same addresses, and the rule is turned off so
// the mail reaches OpenInbox. Nobody sees that mailbox until an admin adds members.
export async function moveForwardRule(env: Env, settings: AppSettings, domainId: number, ruleId: string): Promise<{ address: string; mailboxId: number; to: string[] }> {
  const { cf, d, rule } = await findRule(env, settings, domainId, ruleId);
  const f = forwardOf(rule);
  if (!f) throw notFound('That rule does not forward to an address.');
  // Cloudflare forwards there already, so the addresses are its destinations: store them with
  // their verification state.
  if (settings.cfAccountId) {
    const remote = await listDestinations(cf, settings.cfAccountId).catch(() => []);
    const local = await all<{ address: string; verified_at: number | null }>(env.DB, 'SELECT address, verified_at FROM forward_destinations');
    await importDestinations(
      env.DB,
      local,
      remote.filter((r) => f.to.includes(r.email.toLowerCase())),
    );
  }
  const existing = await first<{ mailbox_id: number }>(env.DB, 'SELECT mailbox_id FROM addresses WHERE address = ?', f.address);
  const mailboxId =
    existing?.mailbox_id ?? (await createMailbox(env.DB, { localPart: f.address.split('@')[0], domainId: d.id, displayName: '', kind: 'personal', members: [] }));
  const box = await first<{ forward_to: string }>(env.DB, 'SELECT forward_to FROM mailboxes WHERE id = ?', mailboxId);
  const forwardTo = [...new Set([...parseJson<string[]>(box?.forward_to, []), ...f.to])];
  await run(env.DB, 'UPDATE mailboxes SET forward_to = ?, state = state + 1 WHERE id = ?', JSON.stringify(forwardTo), mailboxId);
  if (rule.enabled) await disableRule(cf, d.zone_id, rule);
  return { address: f.address, mailboxId, to: f.to };
}
