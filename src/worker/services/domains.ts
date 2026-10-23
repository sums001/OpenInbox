// Domain automation. Each step is idempotent and its state is saved in domains.setup_state, so
// setup can resume after a failure or a closed tab, and "repair" simply runs the steps again.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { all, first, run } from '../db/db';
import { CfError, cfFromEnv, type Cloudflare } from '../cloudflare/client';
import {
  catchAllTargetsWorker,
  conflictingRules,
  disableCatchAll,
  enableRouting,
  getCatchAll,
  getRouting,
  listRules,
  routingDnsProblems,
  setCatchAllToWorker,
} from '../cloudflare/email-routing';
import { applyActions, listRecords, planRecords, type CfDnsRecord } from '../cloudflare/dns';
import { isSpf, spfIncludes, spfLookupCount, unquoteTxt } from '../cloudflare/spf';
import { attachCustomDomain } from '../cloudflare/workers';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { parseJson } from '../lib/json';
import { newId } from '../lib/ids';

export const DOMAIN_STEPS = [
  { id: 'routing', label: 'Turn on Email Routing' },
  { id: 'catchall', label: 'Route all mail for the domain to OpenInbox' },
  { id: 'dmarc', label: 'Add a DMARC record' },
  { id: 'verify', label: 'Check that mail can arrive' },
] as const;

export type StepId = (typeof DOMAIN_STEPS)[number]['id'];

export interface StepState {
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  message?: string;
  at?: number;
}

export interface SetupState {
  replaceMx?: boolean;
  steps: Partial<Record<StepId, StepState>>;
}

export interface DomainRow {
  id: number;
  name: string;
  zone_id: string;
  status: 'pending' | 'active' | 'error' | 'disabled';
  catch_all_mailbox_id: number | null;
  provider_id: number | null;
  setup_state: string;
  health: string;
  health_checked_at: number | null;
  app_hostname: string | null;
  created_at: number;
}

const CF_MX = /\.mx\.cloudflare\.net\.?$/i;

export async function getDomain(db: D1Database, id: number): Promise<DomainRow> {
  const d = await first<DomainRow>(db, 'SELECT * FROM domains WHERE id = ?', id);
  if (!d) throw notFound('Domain not found.');
  return d;
}

export async function requireCf(env: Env, settings: AppSettings): Promise<Cloudflare> {
  const cf = await cfFromEnv(env, settings);
  if (!cf) throw new HttpError(409, 'no_cf_token', 'Connect a Cloudflare API token first (Integrations > Cloudflare).');
  return cf;
}

export function requireWorker(settings: AppSettings): { accountId: string; workerName: string } {
  if (!settings.cfAccountId || !settings.cfWorkerName) {
    throw new HttpError(409, 'worker_unknown', 'OpenInbox has not identified its Worker yet. Open the setup page from the workers.dev address.');
  }
  return { accountId: settings.cfAccountId, workerName: settings.cfWorkerName };
}

export interface MxInspection {
  zoneId: string;
  name: string;
  mx: { host: string; priority?: number }[];
  mxState: 'none' | 'cloudflare' | 'other';
  routing: { enabled: boolean; status: string } | null;
  catchAll: 'openinbox' | 'other' | 'none';
  conflicts: { address: string; action: string }[];
}

// What a zone looks like before OpenInbox takes over its mail.
export async function inspectZone(cf: Cloudflare, zoneId: string, workerName: string | null): Promise<MxInspection> {
  const zone = await cf.get<{ id: string; name: string }>(`/zones/${zoneId}`);
  const records = await cf.paginate<CfDnsRecord>(`/zones/${zoneId}/dns_records?type=MX`, 100, 3);
  const mx = records
    .filter((r) => r.name.toLowerCase() === zone.name.toLowerCase())
    .map((r) => ({ host: r.content, priority: r.priority }));
  const mxState = !mx.length ? 'none' : mx.every((m) => CF_MX.test(m.host)) ? 'cloudflare' : 'other';
  let routing: MxInspection['routing'] = null;
  let catchAll: MxInspection['catchAll'] = 'none';
  let conflicts: MxInspection['conflicts'] = [];
  try {
    const r = await getRouting(cf, zoneId);
    routing = { enabled: r.enabled, status: r.status };
    const rule = await getCatchAll(cf, zoneId);
    catchAll = workerName && catchAllTargetsWorker(rule, workerName) ? 'openinbox' : rule?.enabled ? 'other' : 'none';
    if (workerName) conflicts = conflictingRules(await listRules(cf, zoneId), workerName).map(({ address, action }) => ({ address, action }));
  } catch {
    // Email Routing was never set up on this zone.
  }
  return { zoneId, name: zone.name, mx, mxState, routing, catchAll, conflicts };
}

export async function createDomain(db: D1Database, zone: { id: string; name: string }, replaceMx: boolean): Promise<DomainRow> {
  const existing = await first<DomainRow>(db, 'SELECT * FROM domains WHERE name = ?', zone.name);
  if (existing) {
    if (replaceMx) {
      const state = parseJson<SetupState>(existing.setup_state, { steps: {} });
      state.replaceMx = true;
      await run(db, 'UPDATE domains SET setup_state = ? WHERE id = ?', JSON.stringify(state), existing.id);
    }
    return getDomain(db, existing.id);
  }
  const id = newId();
  const state: SetupState = { replaceMx, steps: {} };
  await run(
    db,
    'INSERT INTO domains (id, name, zone_id, status, setup_state, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    zone.name.toLowerCase(),
    zone.id,
    'pending',
    JSON.stringify(state),
    Date.now(),
  );
  return getDomain(db, id);
}

export function domainStatePayload(d: DomainRow) {
  const state = parseJson<SetupState>(d.setup_state, { steps: {} });
  return {
    steps: DOMAIN_STEPS.map((s) => ({ id: s.id, label: s.label, ...(state.steps[s.id] ?? { status: 'pending' as const }) })),
    done: DOMAIN_STEPS.every((s) => state.steps[s.id]?.status === 'done' || state.steps[s.id]?.status === 'skipped'),
  };
}

// The token permission each step needs, named in the error when Cloudflare refuses it.
const STEP_PERMISSION: Record<StepId, string> = {
  routing: 'Zone → Zone Settings → Edit',
  catchall: 'Zone → Email Routing Rules → Edit',
  dmarc: 'Zone → DNS → Edit',
  verify: 'Zone → Zone Settings and Zone → Email Routing Rules',
};

async function saveState(db: D1Database, d: DomainRow, state: SetupState, status?: DomainRow['status']): Promise<void> {
  await run(db, 'UPDATE domains SET setup_state = ?, status = COALESCE(?, status) WHERE id = ?', JSON.stringify(state), status ?? null, d.id);
}

async function stepRouting(cf: Cloudflare, d: DomainRow, state: SetupState): Promise<string> {
  const records = await cf.paginate<CfDnsRecord>(`/zones/${d.zone_id}/dns_records?type=MX`, 100, 3);
  const foreign = records.filter((r) => r.name.toLowerCase() === d.name && !CF_MX.test(r.content));
  if (foreign.length) {
    if (!state.replaceMx) {
      throw badRequest(
        `${d.name} already receives mail at ${foreign.map((r) => r.content).join(', ')}. Confirm replacing these MX records to continue.`,
        'mx_conflict',
      );
    }
    for (const r of foreign) await cf.request('DELETE', `/zones/${d.zone_id}/dns_records/${r.id}`);
  }
  const current = await getRouting(cf, d.zone_id).catch(() => null);
  if (!current?.enabled) await enableRouting(cf, d.zone_id);
  const after = await getRouting(cf, d.zone_id);
  if (!after.enabled) throw new Error(`Email Routing is still off (status: ${after.status}).`);
  return foreign.length ? `Enabled; replaced ${foreign.length} old MX record(s).` : 'Enabled.';
}

async function stepCatchAll(cf: Cloudflare, d: DomainRow, workerName: string): Promise<string> {
  const rule = await getCatchAll(cf, d.zone_id);
  if (catchAllTargetsWorker(rule, workerName)) return 'Already routed to OpenInbox.';
  await setCatchAllToWorker(cf, d.zone_id, workerName);
  return `All mail for ${d.name} now goes to the ${workerName} Worker.`;
}

async function stepDmarc(cf: Cloudflare, d: DomainRow): Promise<string> {
  const existing = await listRecords(cf, d.zone_id);
  const actions = planRecords(d.name, existing, [{ type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none', purpose: 'dmarc' }]);
  if (actions.every((a) => a.op === 'noop')) return 'A DMARC record already exists; left unchanged.';
  const results = await applyActions(cf, d.zone_id, actions);
  const failed = results.find((r) => !r.ok);
  if (failed) throw new Error(failed.message ?? 'Could not write the DMARC record.');
  return 'Added v=DMARC1; p=none.';
}

async function stepVerify(cf: Cloudflare, d: DomainRow, workerName: string): Promise<string> {
  const routing = await getRouting(cf, d.zone_id);
  if (routing.status !== 'ready') {
    const problems = await routingDnsProblems(cf, d.zone_id);
    throw new Error(`Email Routing status is "${routing.status}". ${problems.join('. ')}`.trim());
  }
  const rule = await getCatchAll(cf, d.zone_id);
  if (!catchAllTargetsWorker(rule, workerName)) throw new Error('The catch-all rule does not point at OpenInbox.');
  const conflicts = conflictingRules(await listRules(cf, d.zone_id), workerName);
  return conflicts.length
    ? `Ready. Note: ${conflicts.map((c) => c.address).join(', ')} have their own routing rules and bypass OpenInbox.`
    : 'Ready to receive mail.';
}

export async function runDomainStep(env: Env, settings: AppSettings, domainId: number, stepId?: StepId) {
  const cf = await requireCf(env, settings);
  const { workerName } = requireWorker(settings);
  let d = await getDomain(env.DB, domainId);
  const state = parseJson<SetupState>(d.setup_state, { steps: {} });
  const step = stepId ?? DOMAIN_STEPS.find((s) => state.steps[s.id]?.status !== 'done' && state.steps[s.id]?.status !== 'skipped')?.id;
  if (!step) return { domain: d, ...domainStatePayload(d) };
  try {
    let message: string;
    if (step === 'routing') message = await stepRouting(cf, d, state);
    else if (step === 'catchall') message = await stepCatchAll(cf, d, workerName);
    else if (step === 'dmarc') message = await stepDmarc(cf, d);
    else message = await stepVerify(cf, d, workerName);
    state.steps[step] = { status: 'done', message, at: Date.now() };
    const allDone = DOMAIN_STEPS.every((s) => state.steps[s.id]?.status === 'done' || state.steps[s.id]?.status === 'skipped');
    await saveState(env.DB, d, state, allDone ? 'active' : undefined);
  } catch (e) {
    const message =
      e instanceof CfError && e.isAuth
        ? `Cloudflare refused this: the token needs ${STEP_PERMISSION[step]}. Edit the token in Cloudflare, then retry.`
        : e instanceof Error
          ? e.message
          : String(e);
    state.steps[step] = { status: 'error', message, at: Date.now() };
    await saveState(env.DB, d, state, 'error');
    if (e instanceof HttpError && e.code === 'mx_conflict') throw e;
  }
  d = await getDomain(env.DB, domainId);
  return { domain: d, ...domainStatePayload(d) };
}

export async function resetDomainSteps(db: D1Database, domainId: number, replaceMx?: boolean): Promise<void> {
  const d = await getDomain(db, domainId);
  const state = parseJson<SetupState>(d.setup_state, { steps: {} });
  state.steps = {};
  if (replaceMx !== undefined) state.replaceMx = replaceMx;
  await saveState(db, d, state);
}

export interface HealthItem {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface DomainHealth {
  items: HealthItem[];
  conflicts: { id?: string; address: string; action: string }[];
  checkedAt: number;
}

// Live check of everything mail for this domain depends on.
export async function checkDomainHealth(env: Env, settings: AppSettings, domainId: number): Promise<DomainHealth> {
  const cf = await requireCf(env, settings);
  const d = await getDomain(env.DB, domainId);
  const workerName = settings.cfWorkerName ?? '';
  const items: HealthItem[] = [];
  const records = await listRecords(cf, d.zone_id);
  const at = (name: string) => records.filter((r) => r.name.toLowerCase() === name.toLowerCase());

  const mx = at(d.name).filter((r) => r.type === 'MX');
  items.push(
    !mx.length
      ? { key: 'mx', label: 'MX records', status: 'error', detail: 'No MX records: mail cannot arrive.' }
      : mx.every((r) => CF_MX.test(r.content))
        ? { key: 'mx', label: 'MX records', status: 'ok', detail: `${mx.length} Cloudflare MX records.` }
        : { key: 'mx', label: 'MX records', status: 'error', detail: `Some MX records point elsewhere: ${mx.filter((r) => !CF_MX.test(r.content)).map((r) => r.content).join(', ')}` },
  );

  let routingOk = false;
  try {
    const routing = await getRouting(cf, d.zone_id);
    routingOk = routing.enabled && routing.status === 'ready';
    items.push({
      key: 'routing',
      label: 'Email Routing',
      status: routingOk ? 'ok' : 'error',
      detail: routingOk ? 'Enabled and ready.' : `Status: ${routing.enabled ? routing.status : 'disabled'}.`,
    });
    const rule = await getCatchAll(cf, d.zone_id);
    const toUs = catchAllTargetsWorker(rule, workerName);
    items.push({
      key: 'catchall',
      label: 'Catch-all rule',
      status: toUs ? 'ok' : 'error',
      detail: toUs ? `Routes to the ${workerName} Worker.` : 'Does not route to OpenInbox.',
    });
  } catch (e) {
    items.push({ key: 'routing', label: 'Email Routing', status: 'error', detail: e instanceof Error ? e.message : String(e) });
  }

  const spf = at(d.name).filter((r) => r.type === 'TXT' && isSpf(r.content));
  const providerIncludes = await providerSpfIncludes(env.DB, d.id);
  if (!spf.length) items.push({ key: 'spf', label: 'SPF', status: 'error', detail: 'No SPF record at the domain.' });
  else if (spf.length > 1) items.push({ key: 'spf', label: 'SPF', status: 'error', detail: `${spf.length} SPF records: receivers treat this as an error. Repair merges them.` });
  else {
    const content = unquoteTxt(spf[0].content);
    const includes = spfIncludes(content);
    const missing = ['_spf.mx.cloudflare.net', ...providerIncludes].filter((i) => !includes.includes(i));
    const lookups = spfLookupCount(content);
    items.push(
      missing.length
        ? { key: 'spf', label: 'SPF', status: 'warn', detail: `Missing include:${missing.join(', include:')}.` }
        : lookups > 10
          ? { key: 'spf', label: 'SPF', status: 'warn', detail: `${lookups} DNS lookups; SPF allows 10.` }
          : { key: 'spf', label: 'SPF', status: 'ok', detail: content },
    );
  }

  const dkim = at(`cf2024-1._domainkey.${d.name}`).length > 0;
  items.push({
    key: 'dkim',
    label: 'DKIM (Cloudflare)',
    status: dkim ? 'ok' : 'warn',
    detail: dkim ? 'cf2024-1._domainkey is published.' : 'Cloudflare DKIM key not found; Email Routing adds it when enabled.',
  });

  const dmarc = at(`_dmarc.${d.name}`).find((r) => r.type === 'TXT' && /^v=DMARC1/i.test(unquoteTxt(r.content)));
  items.push(
    dmarc
      ? { key: 'dmarc', label: 'DMARC', status: 'ok', detail: unquoteTxt(dmarc.content) }
      : { key: 'dmarc', label: 'DMARC', status: 'warn', detail: 'No DMARC record. Repair adds v=DMARC1; p=none.' },
  );

  const providers = await all<{ name: string; type: string; status: string; last_error: string | null }>(
    env.DB,
    `SELECT p.name, p.type, pd.status, pd.last_error FROM provider_domains pd JOIN providers p ON p.id = pd.provider_id WHERE pd.domain_id = ?`,
    d.id,
  );
  for (const p of providers) {
    items.push({
      key: `provider:${p.type}`,
      label: `Sending (${p.name})`,
      status: p.status === 'verified' ? 'ok' : p.status === 'failed' ? 'error' : 'warn',
      detail: p.status === 'verified' ? 'Domain verified.' : p.last_error || 'Waiting for verification.',
    });
  }
  if (!providers.length) items.push({ key: 'provider', label: 'Sending', status: 'warn', detail: 'No sending provider set up for this domain yet.' });

  let conflicts: DomainHealth['conflicts'];
  try {
    conflicts = conflictingRules(await listRules(cf, d.zone_id), workerName);
  } catch {
    conflicts = [];
  }
  const health: DomainHealth = { items, conflicts, checkedAt: Date.now() };
  const status = items.some((i) => i.status === 'error') ? 'error' : routingOk ? 'active' : d.status;
  await run(env.DB, 'UPDATE domains SET health = ?, health_checked_at = ?, status = ? WHERE id = ?', JSON.stringify(health), health.checkedAt, status, d.id);
  return health;
}

async function providerSpfIncludes(db: D1Database, domainId: number): Promise<string[]> {
  const rows = await all<{ records: string }>(db, 'SELECT records FROM provider_domains WHERE domain_id = ?', domainId);
  return rows.flatMap((r) =>
    parseJson<{ type: string; name: string; content: string; purpose?: string }[]>(r.records, [])
      .filter((x) => x.type === 'TXT' && x.purpose === 'spf' && (x.name === '@' || x.name === ''))
      .flatMap((x) => spfIncludes(x.content)),
  );
}

export async function attachAppDomain(env: Env, settings: AppSettings, domainId: number, sub = 'mail'): Promise<string> {
  const cf = await requireCf(env, settings);
  const { accountId, workerName } = requireWorker(settings);
  const d = await getDomain(env.DB, domainId);
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(sub)) throw badRequest('Use letters, digits and dashes for the subdomain.');
  const hostname = `${sub.toLowerCase()}.${d.name}`;
  const existing = await cf.paginate<CfDnsRecord>(`/zones/${d.zone_id}/dns_records?name=${encodeURIComponent(hostname)}`, 50, 1);
  if (existing.length) throw conflict(`${hostname} already has DNS records. Pick another subdomain or remove them first.`);
  await attachCustomDomain(cf, accountId, d.zone_id, hostname, workerName);
  await run(env.DB, 'UPDATE domains SET app_hostname = ? WHERE id = ?', hostname, d.id);
  return hostname;
}

export async function deleteDomain(env: Env, settings: AppSettings, domainId: number): Promise<void> {
  const d = await getDomain(env.DB, domainId);
  const used = await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM mailboxes WHERE domain_id = ?', d.id);
  if (used && used.n > 0) throw conflict('Delete or move the mailboxes on this domain first.');
  const cf = await cfFromEnv(env, settings);
  if (cf && settings.cfWorkerName) {
    try {
      const rule = await getCatchAll(cf, d.zone_id);
      if (catchAllTargetsWorker(rule, settings.cfWorkerName)) await disableCatchAll(cf, d.zone_id);
    } catch {
      // The zone may be gone already; deleting the row is still right.
    }
  }
  await run(env.DB, 'DELETE FROM domains WHERE id = ?', d.id);
}
