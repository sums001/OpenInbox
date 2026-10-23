// Connecting sending providers and setting up sending domains with them (register the domain,
// write its DNS records through the Cloudflare API, poll verification).
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { all, first, run } from '../db/db';
import { decryptJson, encrypt, encryptJson, randomToken } from '../lib/crypto';
import { newId } from '../lib/ids';
import { conflict, errorMessage, notFound } from '../lib/errors';
import { parseJson } from '../lib/json';
import { PROVIDER_INFO, type ProviderType } from '../../shared/constants';
import { adapterFor, createAdapter, maskedConfig, parseProviderConfig, type ProviderConfig, type ProviderRow } from '../providers';
import { ProviderError, type DomainSetup } from '../providers/types';
import { cfFromEnv } from '../cloudflare/client';
import { applyRecords, type AppliedRecord } from '../cloudflare/dns';
import { allQuotaUse } from './quota';
import { logError } from '../lib/log';

export async function getProvider(db: D1Database, id: number): Promise<ProviderRow> {
  const p = await first<ProviderRow>(db, 'SELECT * FROM providers WHERE id = ?', id);
  if (!p) throw notFound('Provider not found.');
  return p;
}

export async function listProviders(env: Env) {
  const rows = await all<ProviderRow>(env.DB, 'SELECT * FROM providers ORDER BY is_default DESC, priority, created_at');
  const usage = await allQuotaUse(env.DB);
  const domains = await all<{ provider_id: number; domain_id: number; name: string; status: string; records: string; last_error: string | null; checked_at: number | null }>(
    env.DB,
    'SELECT pd.provider_id, pd.domain_id, d.name, pd.status, pd.records, pd.last_error, pd.checked_at FROM provider_domains pd JOIN domains d ON d.id = pd.domain_id ORDER BY d.name',
  );
  return Promise.all(
    rows.map(async (p) => {
      let config: Record<string, string | number>;
      try {
        config = maskedConfig(p.type, await decryptJson<ProviderConfig>(env, p.config));
      } catch {
        config = {};
      }
      const u = usage.get(p.id) ?? { today: 0, month: 0 };
      return {
        id: p.id,
        type: p.type,
        name: p.name,
        status: p.status,
        lastError: p.last_error,
        checkedAt: p.checked_at,
        priority: p.priority,
        isDefault: !!p.is_default,
        dailyLimit: p.daily_limit,
        monthlyLimit: p.monthly_limit,
        usedToday: u.today,
        usedMonth: u.month,
        webhook: !!p.webhook_id,
        config,
        domains: domains
          .filter((d) => d.provider_id === p.id)
          .map((d) => ({ domainId: d.domain_id, name: d.name, status: d.status, records: parseJson(d.records, []), lastError: d.last_error, checkedAt: d.checked_at })),
      };
    }),
  );
}

export interface ProviderInput {
  type: ProviderType;
  name?: string;
  config: Record<string, unknown>;
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
}

// Validates credentials with the provider before saving anything.
export async function connectProvider(env: Env, settings: AppSettings, input: ProviderInput): Promise<{ id: number; note?: string }> {
  const config = parseProviderConfig(input.type, input.config);
  const adapter = createAdapter(env, input.type, config);
  const check = await adapter.validate();
  const id = newId();
  const info = PROVIDER_INFO[input.type];
  const count = await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM providers');
  const isFirst = !count?.n;
  await run(
    env.DB,
    `INSERT INTO providers (id, type, name, config, status, checked_at, priority, is_default, daily_limit, monthly_limit, created_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?)`,
    id,
    input.type,
    (input.name?.trim() || info.label) + (check.account ? '' : ''),
    await encryptJson(env, config),
    Date.now(),
    count?.n ?? 0,
    isFirst ? 1 : 0,
    input.dailyLimit === undefined ? info.dailyLimit : input.dailyLimit,
    input.monthlyLimit === undefined ? info.monthlyLimit : input.monthlyLimit,
    Date.now(),
  );
  // Webhooks need a public URL; register them when we know it.
  if (settings.appUrl && !settings.appUrl.includes('localhost')) await registerWebhook(env, settings, id).catch(() => undefined);
  return { id, note: check.note };
}

export async function registerWebhook(env: Env, settings: AppSettings, providerId: number): Promise<boolean> {
  const p = await getProvider(env.DB, providerId);
  const adapter = await adapterFor(env, p);
  if (!adapter.setupWebhook || !settings.appUrl) return false;
  const token = randomToken(18);
  const url =
    p.type === 'resend' ? `${settings.appUrl}/api/webhooks/resend/${p.id}` : `${settings.appUrl}/api/webhooks/${p.type}/${p.id}/${token}`;
  const hook = await adapter.setupWebhook(url);
  if (!hook) return false;
  // Re-registering replaces the old webhook instead of leaving it behind at the provider.
  await removeWebhook(env, p);
  const secret = p.type === 'resend' ? hook.secret ?? null : token;
  await run(
    env.DB,
    'UPDATE providers SET webhook_id = ?, webhook_secret = ? WHERE id = ?',
    hook.id,
    secret ? await encrypt(env, secret) : null,
    p.id,
  );
  return true;
}

export async function updateProvider(
  env: Env,
  id: number,
  patch: { name?: string; config?: Record<string, unknown>; dailyLimit?: number | null; monthlyLimit?: number | null; isDefault?: boolean; priority?: number },
): Promise<void> {
  const p = await getProvider(env.DB, id);
  let configEnc = p.config;
  if (patch.config && Object.keys(patch.config).length) {
    const current = await decryptJson<ProviderConfig>(env, p.config);
    // Masked fields left unchanged in the form keep their stored values.
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch.config)) if (typeof v !== 'string' || !v.includes('••')) merged[k] = v;
    const config = parseProviderConfig(p.type, merged);
    await createAdapter(env, p.type, config).validate();
    configEnc = await encryptJson(env, config);
  }
  const stmts: D1PreparedStatement[] = [];
  if (patch.isDefault) stmts.push(env.DB.prepare('UPDATE providers SET is_default = 0'));
  stmts.push(
    env.DB.prepare(
      'UPDATE providers SET name = ?, config = ?, daily_limit = ?, monthly_limit = ?, is_default = ?, priority = ?, status = ?, last_error = ? WHERE id = ?',
    ).bind(
      patch.name?.trim() || p.name,
      configEnc,
      patch.dailyLimit === undefined ? p.daily_limit : patch.dailyLimit,
      patch.monthlyLimit === undefined ? p.monthly_limit : patch.monthlyLimit,
      patch.isDefault === undefined ? p.is_default : patch.isDefault ? 1 : 0,
      patch.priority ?? p.priority,
      configEnc !== p.config ? 'connected' : p.status,
      configEnc !== p.config ? null : p.last_error,
      id,
    ),
  );
  await env.DB.batch(stmts);
}

export async function testProvider(env: Env, id: number): Promise<{ ok: boolean; message: string }> {
  const p = await getProvider(env.DB, id);
  try {
    const r = await (await adapterFor(env, p)).validate();
    await run(env.DB, "UPDATE providers SET status = 'connected', last_error = NULL, checked_at = ? WHERE id = ?", Date.now(), id);
    return { ok: true, message: r.note ?? (r.account ? `Connected (${r.account}).` : 'Connected.') };
  } catch (e) {
    await run(env.DB, "UPDATE providers SET status = 'error', last_error = ?, checked_at = ? WHERE id = ?", errorMessage(e), Date.now(), id);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function deleteProvider(env: Env, id: number): Promise<void> {
  const p = await getProvider(env.DB, id);
  const dependent = await first<{ name: string }>(env.DB, 'SELECT name FROM domains WHERE provider_id = ? LIMIT 1', id);
  if (dependent) throw conflict(`${dependent.name} is set to send through ${p.name}. Change that domain first.`);
  await removeWebhook(env, p);
  const stmts = [env.DB.prepare('DELETE FROM providers WHERE id = ?').bind(id)];
  if (p.is_default) {
    stmts.push(env.DB.prepare('UPDATE providers SET is_default = 1 WHERE id = (SELECT id FROM providers WHERE id != ? ORDER BY priority LIMIT 1)').bind(id));
  }
  await env.DB.batch(stmts);
}

// Best effort: a webhook the provider already lost, or a revoked key, must not block removal.
// Webhooks added by hand ('manual') were never ours to delete.
async function removeWebhook(env: Env, p: ProviderRow): Promise<void> {
  if (!p.webhook_id || p.webhook_id === 'manual') return;
  try {
    const adapter = await adapterFor(env, p);
    await adapter.removeWebhook?.(p.webhook_id);
  } catch (e) {
    logError('provider.webhook_remove_failed', e, { provider: p.type });
  }
}

export interface DomainSyncResult {
  status: DomainSetup['status'];
  records: DomainSetup['records'];
  dns: AppliedRecord[];
  message?: string;
}

// Registers the domain with the provider and writes the DNS records it asks for.
export async function setupSendingDomain(env: Env, settings: AppSettings, providerId: number, domainId: number): Promise<DomainSyncResult> {
  const p = await getProvider(env.DB, providerId);
  const d = await first<{ id: number; name: string; zone_id: string }>(env.DB, 'SELECT id, name, zone_id FROM domains WHERE id = ?', domainId);
  if (!d) throw notFound('Domain not found.');
  const adapter = await adapterFor(env, p);
  let setup: DomainSetup;
  try {
    setup = await adapter.addDomain(d.name);
  } catch (e) {
    await saveProviderDomain(env.DB, p.id, d.id, { externalId: null, status: 'failed', records: [] }, errorMessage(e));
    throw e;
  }
  let dns: AppliedRecord[] = [];
  if (setup.records.length) {
    const cf = await cfFromEnv(env, settings);
    if (cf) dns = await applyRecords(cf, d.zone_id, d.name, setup.records);
  }
  // Ask for verification right away; DNS on Cloudflare is usually live within seconds.
  try {
    setup = await adapter.checkDomain(d.name, setup.externalId);
  } catch {
    // keep the addDomain status
  }
  const failed = dns.filter((r) => !r.ok);
  const message = failed.length ? failed.map((f) => `${f.name}: ${f.message}`).join('; ') : setup.message;
  await saveProviderDomain(env.DB, p.id, d.id, setup, message ?? null);
  return { status: setup.status, records: setup.records, dns, message };
}

export async function checkSendingDomain(env: Env, providerId: number, domainId: number): Promise<DomainSyncResult> {
  const p = await getProvider(env.DB, providerId);
  const row = await first<{ name: string; external_id: string | null }>(
    env.DB,
    'SELECT d.name, pd.external_id FROM provider_domains pd JOIN domains d ON d.id = pd.domain_id WHERE pd.provider_id = ? AND pd.domain_id = ?',
    providerId,
    domainId,
  );
  if (!row) throw notFound('Set up this domain with the provider first.');
  const adapter = await adapterFor(env, p);
  try {
    const setup = await adapter.checkDomain(row.name, row.external_id);
    await saveProviderDomain(env.DB, providerId, domainId, setup, setup.message ?? null);
    return { status: setup.status, records: setup.records, dns: [], message: setup.message };
  } catch (e) {
    await run(env.DB, 'UPDATE provider_domains SET last_error = ?, checked_at = ? WHERE provider_id = ? AND domain_id = ?', errorMessage(e), Date.now(), providerId, domainId);
    throw e;
  }
}

async function saveProviderDomain(db: D1Database, providerId: number, domainId: number, s: DomainSetup, error: string | null): Promise<void> {
  await run(
    db,
    `INSERT INTO provider_domains (provider_id, domain_id, external_id, status, records, last_error, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider_id, domain_id) DO UPDATE SET external_id = COALESCE(excluded.external_id, external_id), status = excluded.status,
       records = CASE WHEN excluded.records = '[]' THEN records ELSE excluded.records END, last_error = excluded.last_error, checked_at = excluded.checked_at`,
    providerId,
    domainId,
    s.externalId,
    s.status,
    JSON.stringify(s.records),
    error,
    Date.now(),
  );
}

// Cron: re-checks domains still waiting for provider verification, a few per run.
export async function refreshPendingDomains(env: Env, limit = 2): Promise<void> {
  const rows = await all<{ provider_id: number; domain_id: number }>(
    env.DB,
    "SELECT provider_id, domain_id FROM provider_domains WHERE status = 'pending' AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at LIMIT ?",
    Date.now() - 10 * 60_000,
    limit,
  );
  for (const r of rows) await checkSendingDomain(env, r.provider_id, r.domain_id).catch(() => undefined);
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
