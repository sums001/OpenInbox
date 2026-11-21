// Automatic domains: every zone the Cloudflare token can reach, in any of the person's accounts, is
// added and set up without anyone picking it (Admin → Settings turns this off). Cloudflare's free
// plan allows 50 subrequests and 50 D1 queries per invocation, so the work comes in small pieces:
// addNewZones adds a few zones per call, and the cron finishes their setup a few steps a minute.
// The browser runs the same steps faster while someone is watching.
//
// A zone is left alone when taking it over would cut off mail it already gets (its MX records
// point to another provider), when the token can't manage it, and once an admin removed it.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { rawSetting, setRawSetting } from '../db/settings';
import { all } from '../db/db';
import { CfError, type Cloudflare } from '../cloudflare/client';
import { listZones } from '../cloudflare/token';
import { listAccounts } from '../cloudflare/workers';
import { parseJson } from '../lib/json';
import { logError } from '../lib/log';
import { createDomain, requireCf, runDomainStep } from './domains';

const SKIPPED_KEY = 'domains.auto_skipped';
const ZONES_PER_CALL = 8;
const STEPS_PER_TICK = 3;
const CF_MX = /\.mx\.cloudflare\.net\.?$/i;

export interface SkippedZone {
  zoneId: string;
  name: string;
  reason: 'mx_elsewhere' | 'no_access' | 'removed';
  detail: string;
  at: number;
}

export interface AutoAddResult {
  added: { id: number; name: string; relayed: boolean }[];
  // Zones left for an admin to add by hand, with the reason.
  skipped: SkippedZone[];
  // Zones still to look at: call again.
  remaining: number;
}

export async function skippedZones(db: D1Database): Promise<SkippedZone[]> {
  return parseJson<SkippedZone[]>(await rawSetting(db, SKIPPED_KEY), []);
}

async function saveSkipped(db: D1Database, list: SkippedZone[]): Promise<void> {
  await setRawSetting(db, SKIPPED_KEY, list.length ? JSON.stringify(list) : null);
}

// An admin removed the domain: don't bring it back. Adding it by hand clears this.
export async function rememberRemoved(db: D1Database, zone: { zoneId: string; name: string }): Promise<void> {
  const list = (await skippedZones(db)).filter((s) => s.zoneId !== zone.zoneId);
  list.push({ ...zone, reason: 'removed', detail: 'Removed by an admin.', at: Date.now() });
  await saveSkipped(db, list);
}

// Daily: look again at zones skipped for their MX records or access, which may have changed.
export async function pruneSkipped(db: D1Database): Promise<void> {
  const list = await skippedZones(db);
  const kept = list.filter((s) => s.reason === 'removed');
  if (kept.length !== list.length) await saveSkipped(db, kept);
}

const relayedZone = (settings: AppSettings, z: { account?: { id: string } }) => !!(settings.cfAccountId && z.account?.id && z.account.id !== settings.cfAccountId);

// Adds up to ZONES_PER_CALL zones that are not in OpenInbox yet. Their setup steps run afterwards
// (the cron, or the browser).
export async function addNewZones(env: Env, settings: AppSettings): Promise<AutoAddResult> {
  const cf = await requireCf(env, settings);
  const zones = await listZones(cf);
  const taken = new Set((await all<{ name: string }>(env.DB, 'SELECT name FROM domains')).map((d) => d.name.toLowerCase()));
  const skipped = (await skippedZones(env.DB)).filter((s) => !taken.has(s.name.toLowerCase()));
  const skippedIds = new Set(skipped.map((s) => s.zoneId));
  const candidates = zones.filter((z) => z.status === 'active' && !taken.has(z.name.toLowerCase()) && !skippedIds.has(z.id));
  const batch = candidates.slice(0, ZONES_PER_CALL);
  const added: AutoAddResult['added'] = [];
  const now = Date.now();
  for (const z of batch) {
    let mx: string[];
    try {
      const records = await cf.get<{ name: string; content: string }[]>(`/zones/${z.id}/dns_records?type=MX&per_page=50`);
      mx = records.filter((r) => r.name.toLowerCase() === z.name.toLowerCase()).map((r) => r.content);
    } catch (e) {
      if (!(e instanceof CfError && e.isAuth)) throw e;
      skipped.push({ zoneId: z.id, name: z.name, reason: 'no_access', detail: "The Cloudflare token can't manage this domain.", at: now });
      continue;
    }
    const foreign = mx.filter((h) => !CF_MX.test(h));
    if (foreign.length) {
      skipped.push({ zoneId: z.id, name: z.name, reason: 'mx_elsewhere', detail: `It receives mail at ${foreign.join(', ')}. Add it by hand to move its mail here.`, at: now });
      continue;
    }
    const relayed = relayedZone(settings, z);
    const d = await createDomain(env.DB, z, false, relayed ? z.account.id : null);
    added.push({ id: d.id, name: d.name, relayed });
  }
  await saveSkipped(env.DB, skipped);
  return { added, skipped, remaining: candidates.length - batch.length };
}

// Cron: a few setup steps for domains still being set up (added automatically, or left half-way).
// A step waiting on Cloudflare, or one that failed, stops that domain for this run.
export async function advancePendingDomains(env: Env, settings: AppSettings): Promise<number> {
  if (!settings.cfWorkerName || !settings.cfAccountId) return 0;
  const pending = await all<{ id: number }>(env.DB, "SELECT id FROM domains WHERE status = 'pending' ORDER BY created_at LIMIT ?", STEPS_PER_TICK);
  let steps = 0;
  for (const { id } of pending) {
    while (steps < STEPS_PER_TICK) {
      steps++;
      try {
        const r = await runDomainStep(env, settings, id, undefined, { appBase: settings.appUrl ?? undefined });
        if (r.done || r.domain.status !== 'pending' || r.steps.some((s) => s.status === 'running' || s.status === 'error')) break;
      } catch (e) {
        logError('domains.auto_step_failed', e, { domainId: id });
        break;
      }
    }
    if (steps >= STEPS_PER_TICK) break;
  }
  return steps;
}

export interface TokenAccount {
  id: string;
  name: string;
  // The account this Worker runs in.
  worker: boolean;
  zones: number;
  connected: number;
  // For another account with zones: whether the token can install the relay Worker there.
  relay: 'ok' | 'no_access' | null;
}

// Every account the token reaches, with its zones.
export async function tokenAccounts(cf: Cloudflare, settings: AppSettings, db: D1Database): Promise<TokenAccount[]> {
  const [accounts, zones] = await Promise.all([listAccounts(cf), listZones(cf)]);
  const taken = new Set((await all<{ name: string }>(db, 'SELECT name FROM domains')).map((d) => d.name.toLowerCase()));
  return Promise.all(
    accounts.map(async (a) => {
      const own = zones.filter((z) => z.account?.id === a.id);
      const worker = a.id === settings.cfAccountId;
      let relay: TokenAccount['relay'] = null;
      if (!worker && own.length) {
        relay = await cf.get(`/accounts/${a.id}/workers/scripts`).then(
          () => 'ok' as const,
          (e) => (e instanceof CfError && e.isAuth ? ('no_access' as const) : null),
        );
      }
      return { id: a.id, name: a.name, worker, zones: own.length, connected: own.filter((z) => taken.has(z.name.toLowerCase())).length, relay };
    }),
  );
}
