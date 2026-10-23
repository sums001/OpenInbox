// Admin API: dashboard data, users, mailboxes, domains, providers, Cloudflare token, storage,
// settings, logs and maintenance. Mounted behind requireAdmin.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { body, intParam } from '../lib/validate';
import {
  addDomainSchema,
  aliasSchema,
  appDomainSchema,
  createMailboxSchema,
  createUserSchema,
  destinationSchema,
  domainPatchSchema,
  membersSchema,
  providerPatchSchema,
  providerSchema,
  r2Schema,
  settingsSchema,
  blockSchema,
  setupTokenSchema,
  updateMailboxSchema,
  updateUserSchema,
} from '../../shared/schemas';
import { all, first, run } from '../db/db';
import { loadSettings, saveSettings, type AppSettings } from '../db/settings';
import { clientIp, currentUser } from '../auth/middleware';
import { badRequest, conflict, errorMessage, HttpError, notFound } from '../lib/errors';
import { decrypt, encrypt, encryptJson } from '../lib/crypto';
import { newId } from '../lib/ids';
import { parseJson } from '../lib/json';
import { audit } from '../services/audit';
import { overview } from '../services/overview';
import { cloudflareUsage, growthEstimate, storageSummary } from '../services/usage';
import { checkForUpdate } from '../services/updates';
import { createUser, deleteUser, listUsers, resetUserPassword, resetUserTotp, updateUser } from '../services/users';
import {
  addAlias,
  createMailbox,
  deleteMailbox,
  getMailbox,
  listMailboxesAdmin,
  mailboxSettings,
  removeAlias,
  setMembers,
  updateMailbox,
} from '../services/mailboxes';
import {
  attachAppDomain,
  checkDomainHealth,
  createDomain,
  deleteDomain,
  domainStatePayload,
  getDomain,
  inspectZone,
  requireCf,
  requireWorker,
  resetDomainSteps,
  runDomainStep,
  type StepId,
} from '../services/domains';
import {
  checkSendingDomain,
  connectProvider,
  deleteProvider,
  listProviders,
  registerWebhook,
  setupSendingDomain,
  testProvider,
  updateProvider,
} from '../services/providers';
import { listSuppressions, removeSuppression } from '../services/webhooks';
import { retryMessage } from '../services/send';
import { deleteBlobs } from '../services/threads';
import { Cloudflare, cfFromEnv, DEFAULT_CF_API } from '../cloudflare/client';
import { checkPermissions, listZones, verifyToken } from '../cloudflare/token';
import { createDestination, deleteDestination, disableRule, listDestinations, listRules } from '../cloudflare/email-routing';
import { R2S3Store, type R2Config } from '../storage/r2';
import { detectWorker } from '../cloudflare/workers';

export const admin = new Hono<AppBindings>();

const settingsOf = (c: { env: AppBindings['Bindings'] }) => loadSettings(c.env.DB);

// Dashboard ----------------------------------------------------------------------------------------

admin.get('/overview', async (c) => {
  const settings = await settingsOf(c);
  const [data, storage, update] = await Promise.all([overview(c.env, settings), storageSummary(c.env, settings), checkForUpdate(c.env)]);
  const daysUntilFull = await growthEstimate(c.env.DB, storage.d1Bytes);
  return c.json({ ...data, storage: { ...storage, daysUntilFull }, update });
});

admin.get('/usage', async (c) => {
  const settings = await settingsOf(c);
  return c.json(await cloudflareUsage(c.env, settings, c.req.query('fresh') === '1'));
});

admin.get('/updates', async (c) => c.json(await checkForUpdate(c.env, c.req.query('fresh') === '1')));

// Users --------------------------------------------------------------------------------------------

admin.get('/users', async (c) => c.json(await listUsers(c.env.DB)));

admin.post('/users', async (c) => {
  const input = await body(c, createUserSchema);
  return c.json(await createUser(c.env, currentUser(c), input, clientIp(c)));
});

admin.patch('/users/:id', async (c) => {
  await updateUser(c.env, currentUser(c), intParam(c, 'id'), await body(c, updateUserSchema), clientIp(c));
  return c.json({ ok: true });
});

admin.post('/users/:id/reset-password', async (c) => {
  return c.json({ password: await resetUserPassword(c.env, currentUser(c), intParam(c, 'id'), clientIp(c)) });
});

admin.post('/users/:id/reset-2fa', async (c) => {
  await resetUserTotp(c.env, currentUser(c), intParam(c, 'id'), clientIp(c));
  return c.json({ ok: true });
});

admin.delete('/users/:id', async (c) => {
  const reassign = c.req.query('reassignTo') ? Number(c.req.query('reassignTo')) : null;
  await deleteUser(c.env, currentUser(c), intParam(c, 'id'), reassign, clientIp(c));
  return c.json({ ok: true });
});

// Mailboxes ----------------------------------------------------------------------------------------

admin.get('/mailboxes', async (c) => c.json(await listMailboxesAdmin(c.env.DB)));

admin.post('/mailboxes', async (c) => {
  const input = await body(c, createMailboxSchema);
  const id = await createMailbox(c.env.DB, input);
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'mailbox.created', target: String(id), details: { localPart: input.localPart }, ip: clientIp(c) });
  return c.json({ id });
});

admin.get('/mailboxes/:id', async (c) => {
  const m = await getMailbox(c.env.DB, intParam(c, 'id'));
  return c.json({ id: m.id, address: m.address, displayName: m.display_name, kind: m.kind, ...mailboxSettings(m) });
});

admin.patch('/mailboxes/:id', async (c) => {
  const id = intParam(c, 'id');
  await updateMailbox(c.env.DB, id, await body(c, updateMailboxSchema));
  return c.json({ ok: true });
});

admin.delete('/mailboxes/:id', async (c) => {
  const id = intParam(c, 'id');
  const m = await getMailbox(c.env.DB, id);
  if (c.req.query('confirm') !== m.address) throw badRequest(`Type the address (${m.address}) to confirm deleting the mailbox and all its mail.`);
  const raws = await deleteMailbox(c.env.DB, id);
  await deleteBlobs(c.env, await settingsOf(c), [...raws.d1.map((k) => ({ raw_key: k, raw_store: 'd1' as const })), ...raws.r2.map((k) => ({ raw_key: k, raw_store: 'r2' as const }))]);
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'mailbox.deleted', target: m.address, ip: clientIp(c) });
  return c.json({ ok: true });
});

admin.post('/mailboxes/:id/aliases', async (c) => {
  const { localPart, domainId } = await body(c, aliasSchema);
  const address = await addAlias(c.env.DB, intParam(c, 'id'), localPart, domainId);
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'alias.created', target: address, ip: clientIp(c) });
  return c.json({ address });
});

admin.delete('/mailboxes/:id/aliases/:aliasId', async (c) => {
  await removeAlias(c.env.DB, intParam(c, 'id'), intParam(c, 'aliasId'));
  return c.json({ ok: true });
});

admin.put('/mailboxes/:id/members', async (c) => {
  const id = intParam(c, 'id');
  const { members } = await body(c, membersSchema);
  await setMembers(c.env.DB, id, members);
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'mailbox.members_changed', target: String(id), details: { members: members.map((m) => m.userId) }, ip: clientIp(c) });
  return c.json({ ok: true });
});

// Domains ------------------------------------------------------------------------------------------

admin.get('/domains', async (c) => {
  const rows = await all<{ id: number; name: string; zone_id: string; status: string; catch_all_mailbox_id: number | null; provider_id: number | null; setup_state: string; health: string; health_checked_at: number | null; app_hostname: string | null; created_at: number }>(
    c.env.DB,
    'SELECT * FROM domains ORDER BY name',
  );
  const counts = await all<{ domain_id: number; n: number }>(c.env.DB, 'SELECT domain_id, COUNT(*) AS n FROM addresses GROUP BY domain_id');
  return c.json(
    rows.map((d) => ({
      id: d.id,
      name: d.name,
      zoneId: d.zone_id,
      status: d.status,
      catchAllMailboxId: d.catch_all_mailbox_id,
      providerId: d.provider_id,
      appHostname: d.app_hostname,
      addresses: counts.find((x) => x.domain_id === d.id)?.n ?? 0,
      health: d.health_checked_at ? parseJson(d.health, null) : null,
      healthCheckedAt: d.health_checked_at,
      setup: domainStatePayload(d as never),
      createdAt: d.created_at,
    })),
  );
});

admin.get('/zones', async (c) => {
  const settings = await settingsOf(c);
  const cf = await requireCf(c.env, settings);
  const zones = await listZones(cf, settings.cfAccountId);
  const taken = new Set((await all<{ name: string }>(c.env.DB, 'SELECT name FROM domains')).map((d) => d.name));
  return c.json(zones.map((z) => ({ id: z.id, name: z.name, status: z.status, connected: taken.has(z.name) })));
});

admin.get('/zones/:zoneId', async (c) => {
  const settings = await settingsOf(c);
  return c.json(await inspectZone(await requireCf(c.env, settings), c.req.param('zoneId'), settings.cfWorkerName));
});

admin.post('/domains', async (c) => {
  const settings = await settingsOf(c);
  const cf = await requireCf(c.env, settings);
  requireWorker(settings);
  const input = await body(c, addDomainSchema);
  const zone = await cf.get<{ id: string; name: string }>(`/zones/${input.zoneId}`);
  const inspection = await inspectZone(cf, input.zoneId, settings.cfWorkerName);
  if (inspection.mxState === 'other' && !input.replaceMx) {
    throw new HttpError(409, 'mx_conflict', `${zone.name} already receives mail elsewhere. Confirm that OpenInbox should take over its mail.`, { mx: inspection.mx });
  }
  const d = await createDomain(c.env.DB, zone, input.replaceMx);
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'domain.added', target: zone.name, ip: clientIp(c) });
  return c.json({ id: d.id });
});

admin.post('/domains/:id/setup', async (c) => {
  const settings = await settingsOf(c);
  const step = (c.req.query('step') as StepId | undefined) || undefined;
  if (c.req.query('reset') === '1') await resetDomainSteps(c.env.DB, intParam(c, 'id'), c.req.query('replaceMx') === '1' ? true : undefined);
  const r = await runDomainStep(c.env, settings, intParam(c, 'id'), step);
  return c.json({ status: r.domain.status, steps: r.steps, done: r.done });
});

admin.post('/domains/:id/check', async (c) => {
  return c.json(await checkDomainHealth(c.env, await settingsOf(c), intParam(c, 'id')));
});

// Repair: runs every setup step again and re-syncs sending DNS records.
admin.post('/domains/:id/repair', async (c) => {
  const settings = await settingsOf(c);
  const id = intParam(c, 'id');
  await resetDomainSteps(c.env.DB, id);
  let r = await runDomainStep(c.env, settings, id);
  for (let i = 0; i < 4 && !r.done && !r.steps.some((s) => s.status === 'error'); i++) r = await runDomainStep(c.env, settings, id);
  const providers = await all<{ provider_id: number }>(c.env.DB, 'SELECT provider_id FROM provider_domains WHERE domain_id = ?', id);
  for (const p of providers) await setupSendingDomain(c.env, settings, p.provider_id, id).catch(() => undefined);
  const health = await checkDomainHealth(c.env, settings, id).catch(() => null);
  return c.json({ steps: r.steps, done: r.done, health });
});

admin.patch('/domains/:id', async (c) => {
  const id = intParam(c, 'id');
  const d = await getDomain(c.env.DB, id);
  const input = await body(c, domainPatchSchema);
  if (input.catchAllMailboxId) {
    const m = await getMailbox(c.env.DB, input.catchAllMailboxId);
    if (m.domain_id !== id) {
      // A catch-all can deliver to a mailbox on another domain; that's allowed.
    }
  }
  await run(
    c.env.DB,
    'UPDATE domains SET catch_all_mailbox_id = ?, provider_id = ?, status = COALESCE(?, status) WHERE id = ?',
    input.catchAllMailboxId === undefined ? d.catch_all_mailbox_id : input.catchAllMailboxId,
    input.providerId === undefined ? d.provider_id : input.providerId,
    input.status ?? null,
    id,
  );
  return c.json({ ok: true });
});

admin.post('/domains/:id/app-domain', async (c) => {
  const { subdomain } = await body(c, appDomainSchema);
  const hostname = await attachAppDomain(c.env, await settingsOf(c), intParam(c, 'id'), subdomain);
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'domain.app_domain', target: hostname, ip: clientIp(c) });
  return c.json({ hostname, url: `https://${hostname}` });
});

admin.post('/domains/:id/disable-rule', async (c) => {
  const settings = await settingsOf(c);
  const cf = await requireCf(c.env, settings);
  const d = await getDomain(c.env.DB, intParam(c, 'id'));
  const { address } = (await c.req.json()) as { address?: string };
  const rule = (await listRules(cf, d.zone_id)).find((r) => r.matchers.some((m) => m.type === 'literal' && m.value === address));
  if (!rule) throw notFound('Rule not found.');
  await disableRule(cf, d.zone_id, rule);
  return c.json({ ok: true });
});

admin.delete('/domains/:id', async (c) => {
  const d = await getDomain(c.env.DB, intParam(c, 'id'));
  await deleteDomain(c.env, await settingsOf(c), d.id);
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'domain.removed', target: d.name, ip: clientIp(c) });
  return c.json({ ok: true });
});

// Sending providers --------------------------------------------------------------------------------

admin.get('/providers', async (c) => c.json(await listProviders(c.env)));

admin.post('/providers', async (c) => {
  const settings = await settingsOf(c);
  const input = await body(c, providerSchema);
  const r = await connectProvider(c.env, settings, input);
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'provider.connected', target: input.type, ip: clientIp(c) });
  // Set up sending for every domain right away; failures show per domain and can be retried.
  const domains = await all<{ id: number }>(c.env.DB, "SELECT id FROM domains WHERE status != 'disabled'");
  const results = [];
  for (const d of domains) {
    try {
      results.push({ domainId: d.id, ...(await setupSendingDomain(c.env, settings, r.id, d.id)) });
    } catch (e) {
      results.push({ domainId: d.id, status: 'failed', error: errorMessage(e) });
    }
  }
  return c.json({ id: r.id, note: r.note, domains: results });
});

admin.patch('/providers/:id', async (c) => {
  await updateProvider(c.env, intParam(c, 'id'), await body(c, providerPatchSchema));
  return c.json({ ok: true });
});

admin.post('/providers/:id/test', async (c) => c.json(await testProvider(c.env, intParam(c, 'id'))));

admin.post('/providers/:id/webhook', async (c) => {
  const ok = await registerWebhook(c.env, await settingsOf(c), intParam(c, 'id'));
  return c.json({ ok });
});

admin.post('/providers/:id/webhook-secret', async (c) => {
  const { secret } = (await c.req.json()) as { secret?: string };
  if (!secret || secret.length < 10) throw badRequest('Paste the signing secret from the provider dashboard.');
  await run(c.env.DB, "UPDATE providers SET webhook_secret = ?, webhook_id = COALESCE(webhook_id, 'manual') WHERE id = ?", await encrypt(c.env, secret.trim()), intParam(c, 'id'));
  return c.json({ ok: true });
});

admin.delete('/providers/:id', async (c) => {
  await deleteProvider(c.env, intParam(c, 'id'));
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'provider.removed', target: c.req.param('id'), ip: clientIp(c) });
  return c.json({ ok: true });
});

admin.post('/providers/:id/domains/:domainId', async (c) => {
  return c.json(await setupSendingDomain(c.env, await settingsOf(c), intParam(c, 'id'), intParam(c, 'domainId')));
});

admin.post('/providers/:id/domains/:domainId/check', async (c) => {
  return c.json(await checkSendingDomain(c.env, intParam(c, 'id'), intParam(c, 'domainId')));
});

// Cloudflare token ---------------------------------------------------------------------------------

admin.get('/cloudflare', async (c) => {
  const settings = await settingsOf(c);
  const cf = await cfFromEnv(c.env, settings).catch(() => null);
  if (!cf) return c.json({ connected: false, source: null, permissions: [] });
  const token = await verifyToken(cf);
  const zone = await first<{ zone_id: string }>(c.env.DB, 'SELECT zone_id FROM domains LIMIT 1');
  const permissions = token.valid && settings.cfAccountId ? await checkPermissions(cf, settings.cfAccountId, zone?.zone_id ?? null) : [];
  return c.json({
    connected: token.valid,
    message: token.message,
    source: c.env.CF_API_TOKEN ? 'secret' : 'stored',
    account: { id: settings.cfAccountId, name: settings.cfAccountName },
    worker: { name: settings.cfWorkerName, subdomain: settings.cfWorkersSubdomain, d1Id: settings.cfD1Id },
    permissions,
  });
});

admin.post('/cloudflare/token', async (c) => {
  const { token } = await body(c, setupTokenSchema);
  if (c.env.CF_API_TOKEN) throw conflict('The token is set as the CF_API_TOKEN secret. Change it in the Worker settings instead.');
  const cf = new Cloudflare(token, c.env.CF_API_BASE || DEFAULT_CF_API);
  const check = await verifyToken(cf);
  if (!check.valid) throw new HttpError(400, 'invalid_token', check.message ?? 'Cloudflare rejected this token.');
  await saveSettings(c.env.DB, { cfTokenEnc: await encrypt(c.env, token) });
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'cloudflare.token_replaced', ip: clientIp(c) });
  return c.json({ ok: true });
});

admin.post('/cloudflare/detect', async (c) => {
  const settings = await loadSettings(c.env.DB, true);
  const cf = await requireCf(c.env, settings);
  const id = await detectWorker(cf, new URL(c.req.url).host, c.env.WORKER_NAME);
  await saveSettings(c.env.DB, { cfAccountId: id.accountId, cfAccountName: id.accountName, cfWorkerName: id.workerName, cfWorkersSubdomain: id.workersSubdomain, cfD1Id: id.d1Id });
  return c.json(id);
});

// Attachments (R2 through the S3 API) -----------------------------------------------------------

async function r2Info(c: { env: AppBindings['Bindings'] }, settings: AppSettings) {
  let config: Omit<R2Config, 'secretAccessKey'> | null = null;
  if (settings.r2Enc) {
    try {
      const { secretAccessKey: _secret, ...rest } = await decryptJsonSafe(c.env, settings.r2Enc);
      config = rest;
    } catch {
      config = null;
    }
  }
  return { mode: settings.storageMode, configured: !!config, bucket: config?.bucket ?? null, accessKeyId: config?.accessKeyId ? `${config.accessKeyId.slice(0, 6)}…` : null };
}

async function decryptJsonSafe(env: AppBindings['Bindings'], value: string): Promise<R2Config> {
  return JSON.parse(await decrypt(env, value)) as R2Config;
}

admin.get('/storage', async (c) => {
  const settings = await settingsOf(c);
  const summary = await storageSummary(c.env, settings);
  let r2Enabled: boolean | null = null;
  let bucketPermission = false;
  const cf = await cfFromEnv(c.env, settings).catch(() => null);
  if (cf && settings.cfAccountId) {
    try {
      await cf.get(`/accounts/${settings.cfAccountId}/r2/buckets`);
      r2Enabled = true;
      bucketPermission = true;
    } catch (e) {
      r2Enabled = /10042|enable R2/i.test(errorMessage(e)) ? false : null;
    }
  }
  return c.json({ ...(await r2Info(c, settings)), summary, r2Enabled, bucketPermission, accountId: settings.cfAccountId });
});

admin.post('/storage/bucket', async (c) => {
  const settings = await settingsOf(c);
  const cf = await requireCf(c.env, settings);
  const { bucket } = (await c.req.json()) as { bucket?: string };
  const name = (bucket || 'openinbox-mail').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) throw badRequest('Bucket names use 3-63 lowercase letters, digits and dashes.');
  try {
    await cf.request('POST', `/accounts/${settings.cfAccountId}/r2/buckets`, { name });
  } catch (e) {
    if (!/already exists|10004/i.test(errorMessage(e))) throw new HttpError(400, 'bucket_failed', errorMessage(e));
  }
  return c.json({ bucket: name });
});

admin.post('/storage/r2', async (c) => {
  const settings = await settingsOf(c);
  if (!settings.cfAccountId) throw conflict('OpenInbox does not know your Cloudflare account yet.');
  const input = await body(c, r2Schema);
  const config: R2Config = { accountId: settings.cfAccountId, bucket: input.bucket, accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey };
  try {
    await new R2S3Store(config).selfTest();
  } catch (e) {
    throw new HttpError(400, 'r2_test_failed', `R2 test failed: ${errorMessage(e)}`);
  }
  await saveSettings(c.env.DB, { r2Enc: await encryptJson(c.env, config), storageMode: 'r2' });
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'storage.r2_enabled', target: input.bucket, ip: clientIp(c) });
  return c.json({ ok: true });
});

admin.post('/storage/test', async (c) => {
  const settings = await settingsOf(c);
  if (!settings.r2Enc) throw conflict('R2 is not configured.');
  try {
    await new R2S3Store(await decryptJsonSafe(c.env, settings.r2Enc)).selfTest();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, message: errorMessage(e) });
  }
});

admin.post('/storage/mode', async (c) => {
  const { mode } = (await c.req.json()) as { mode?: string };
  if (mode !== 'text' && mode !== 'r2') throw badRequest('Unknown mode.');
  const settings = await settingsOf(c);
  if (mode === 'r2' && !settings.r2Enc) throw conflict('Connect R2 first.');
  await saveSettings(c.env.DB, { storageMode: mode });
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'storage.mode', target: mode, ip: clientIp(c) });
  return c.json({ ok: true });
});

// Settings -----------------------------------------------------------------------------------------

admin.get('/settings', async (c) => {
  const s = await settingsOf(c);
  return c.json({
    instanceName: s.instanceName,
    maxInboundMb: s.maxInboundMb,
    trashRetentionDays: s.trashRetentionDays,
    spamRetentionDays: s.spamRetentionDays,
    spamPolicy: s.spamPolicy,
    remoteImages: s.remoteImages,
    appUrl: s.appUrl,
    version: __APP_VERSION__,
    keyRotation: !!c.env.ENCRYPTION_KEY_PREVIOUS,
  });
});

admin.patch('/settings', async (c) => {
  const input = await body(c, settingsSchema);
  await saveSettings(c.env.DB, { ...input, appUrl: input.appUrl?.replace(/\/$/, '') });
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'settings.updated', details: input, ip: clientIp(c) });
  return c.json({ ok: true });
});

// Re-encrypts every stored secret with the current ENCRYPTION_KEY (key rotation step 2 of 3).
admin.post('/reencrypt', async (c) => {
  const db = c.env.DB;
  const env = c.env;
  let count = 0;
  const providers = await all<{ id: number; config: string; webhook_secret: string | null }>(db, 'SELECT id, config, webhook_secret FROM providers');
  for (const p of providers) {
    await run(db, 'UPDATE providers SET config = ?, webhook_secret = ? WHERE id = ?', await encrypt(env, await decrypt(env, p.config)), p.webhook_secret ? await encrypt(env, await decrypt(env, p.webhook_secret)) : null, p.id);
    count++;
  }
  const users = await all<{ id: number; totp_secret: string }>(db, 'SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL');
  for (const u of users) {
    await run(db, 'UPDATE users SET totp_secret = ? WHERE id = ?', await encrypt(env, await decrypt(env, u.totp_secret)), u.id);
    count++;
  }
  const s = await loadSettings(db, true);
  await saveSettings(db, {
    cfTokenEnc: s.cfTokenEnc ? await encrypt(env, await decrypt(env, s.cfTokenEnc)) : null,
    r2Enc: s.r2Enc ? await encrypt(env, await decrypt(env, s.r2Enc)) : null,
    keyCheck: await encrypt(env, 'openinbox'),
  });
  await audit(db, { userId: currentUser(c).id, action: 'crypto.reencrypted', details: { count }, ip: clientIp(c) });
  return c.json({ ok: true, count });
});

// Logs ---------------------------------------------------------------------------------------------

admin.get('/audit', async (c) => {
  const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  const rows = await all<{ id: number; action: string; target: string | null; details: string | null; ip: string | null; created_at: number; name: string | null; email: string | null }>(
    c.env.DB,
    'SELECT a.id, a.action, a.target, a.details, a.ip, a.created_at, u.name, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.created_at < ? ORDER BY a.created_at DESC LIMIT 100',
    before,
  );
  return c.json(rows.map((r) => ({ id: r.id, action: r.action, target: r.target, details: parseJson(r.details, null), ip: r.ip, at: r.created_at, by: r.name ?? r.email })));
});

admin.get('/mailflow', async (c) => {
  const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  const status = c.req.query('status');
  const rows = await all<{ id: number; received_at: number; mail_from: string; rcpt_to: string; subject: string; size: number; status: string; reason: string | null; message_id: number | null }>(
    c.env.DB,
    `SELECT * FROM inbound_log WHERE received_at < ? ${status ? 'AND status = ?' : ''} ORDER BY received_at DESC LIMIT 100`,
    before,
    ...(status ? [status] : []),
  );
  return c.json(rows.map((r) => ({ id: r.id, at: r.received_at, from: r.mail_from, to: r.rcpt_to, subject: r.subject, size: r.size, status: r.status, reason: r.reason })));
});

// Cloudflare's own Email Routing log: includes mail rejected before it reached OpenInbox.
admin.get('/mailflow/cloudflare', async (c) => {
  const settings = await settingsOf(c);
  const cf = await requireCf(c.env, settings);
  const zones = await all<{ zone_id: string; name: string }>(c.env.DB, 'SELECT zone_id, name FROM domains');
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const out: { domain: string; datetime: string; from: string; to: string; subject: string; status: string; action: string; errorDetail: string | null; spf: string; dkim: string; dmarc: string }[] = [];
  for (const z of zones) {
    try {
      const r = await cf.graphql<{ viewer: { zones: { emailRoutingAdaptive: Omit<(typeof out)[number], 'domain'>[] }[] } }>(
        `query($zoneTag: string, $since: Time) { viewer { zones(filter: { zoneTag: $zoneTag }) {
          emailRoutingAdaptive(limit: 50, filter: { datetime_geq: $since }, orderBy: [datetime_DESC]) { datetime from to subject status action errorDetail spf dkim dmarc }
        } } }`,
        { zoneTag: z.zone_id, since },
      );
      for (const e of r.viewer.zones[0]?.emailRoutingAdaptive ?? []) out.push({ domain: z.name, ...e });
    } catch (e) {
      return c.json({ available: false, reason: /authoriz|permission/i.test(errorMessage(e)) ? 'The token needs Zone Analytics: Read.' : errorMessage(e), events: [] });
    }
  }
  out.sort((a, b) => b.datetime.localeCompare(a.datetime));
  return c.json({ available: true, events: out.slice(0, 100) });
});

admin.get('/failures', async (c) => {
  const rows = await all<{ id: number; thread_id: number; mailbox_id: number; direction: string; status: string; subject: string; from_addr: string; to_addrs: string; error: string | null; attempts: number; send_at: number | null; created_at: number; address: string }>(
    c.env.DB,
    `SELECT g.id, g.thread_id, g.mailbox_id, g.direction, g.status, g.subject, g.from_addr, g.to_addrs, g.error, g.attempts, g.send_at, g.created_at, m.address
       FROM messages g JOIN mailboxes m ON m.id = g.mailbox_id WHERE g.status IN ('failed', 'unparsed') ORDER BY g.created_at DESC LIMIT 200`,
  );
  return c.json(rows.map((r) => ({ id: r.id, threadId: r.thread_id, mailbox: r.address, kind: r.status, subject: r.subject, from: r.from_addr, to: parseJson(r.to_addrs, []), error: r.error, attempts: r.attempts, retryAt: r.send_at, at: r.created_at })));
});

admin.post('/failures/:id/retry', async (c) => c.json(await retryMessage(c.env, null, intParam(c, 'id'))));

admin.get('/suppressions', async (c) => c.json(await listSuppressions(c.env.DB)));
admin.delete('/suppressions/:address', async (c) => {
  await removeSuppression(c.env.DB, decodeURIComponent(c.req.param('address')));
  return c.json({ ok: true });
});

admin.get('/blocked', async (c) => {
  return c.json(
    await all<{ id: number; mailbox_id: number | null; pattern: string; created_at: number; address: string | null }>(
      c.env.DB,
      'SELECT b.id, b.mailbox_id, b.pattern, b.created_at, m.address FROM blocked_senders b LEFT JOIN mailboxes m ON m.id = b.mailbox_id ORDER BY b.created_at DESC',
    ),
  );
});

admin.post('/blocked', async (c) => {
  const input = await body(c, blockSchema);
  await run(c.env.DB, 'INSERT INTO blocked_senders (id, mailbox_id, pattern, created_at) VALUES (?, ?, ?, ?)', newId(), input.mailboxId ?? null, input.pattern.toLowerCase(), Date.now());
  return c.json({ ok: true });
});

admin.delete('/blocked/:id', async (c) => {
  await run(c.env.DB, 'DELETE FROM blocked_senders WHERE id = ?', intParam(c, 'id'));
  return c.json({ ok: true });
});

// Forwarding destinations (Email Routing destination addresses) ---------------------------------

admin.get('/forwarding', async (c) => {
  const settings = await settingsOf(c);
  const cf = await cfFromEnv(c.env, settings).catch(() => null);
  const local = await all<{ address: string; cf_id: string | null; verified_at: number | null }>(c.env.DB, 'SELECT address, cf_id, verified_at FROM forward_destinations ORDER BY address');
  if (cf && settings.cfAccountId && local.length) {
    // Refresh verification status from Cloudflare.
    try {
      const remote = await listDestinations(cf, settings.cfAccountId);
      for (const l of local) {
        const r = remote.find((x) => x.email.toLowerCase() === l.address);
        const verified = r?.verified ? Date.parse(r.verified) : null;
        if (verified !== l.verified_at) {
          await run(c.env.DB, 'UPDATE forward_destinations SET verified_at = ? WHERE address = ?', verified, l.address);
          l.verified_at = verified;
        }
      }
    } catch {
      // show the stored status
    }
  }
  return c.json(local.map((l) => ({ address: l.address, verified: !!l.verified_at })));
});

admin.post('/forwarding', async (c) => {
  const settings = await settingsOf(c);
  const cf = await requireCf(c.env, settings);
  const { email } = await body(c, destinationSchema);
  const address = email.toLowerCase();
  let created;
  try {
    created = await createDestination(cf, settings.cfAccountId!, address);
  } catch (e) {
    const existing = (await listDestinations(cf, settings.cfAccountId!)).find((d) => d.email.toLowerCase() === address);
    if (!existing) throw new HttpError(400, 'destination_failed', errorMessage(e));
    created = existing;
  }
  await run(
    c.env.DB,
    'INSERT INTO forward_destinations (address, cf_id, verified_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (address) DO UPDATE SET cf_id = excluded.cf_id, verified_at = excluded.verified_at',
    address,
    created.id ?? created.tag ?? null,
    created.verified ? Date.parse(created.verified) : null,
    Date.now(),
  );
  await audit(c.env.DB, { userId: currentUser(c).id, action: 'forwarding.added', target: address, ip: clientIp(c) });
  return c.json({ ok: true, verified: !!created.verified });
});

admin.delete('/forwarding/:address', async (c) => {
  const settings = await settingsOf(c);
  const address = decodeURIComponent(c.req.param('address')).toLowerCase();
  const row = await first<{ cf_id: string | null }>(c.env.DB, 'SELECT cf_id FROM forward_destinations WHERE address = ?', address);
  const cf = await cfFromEnv(c.env, settings).catch(() => null);
  if (cf && row?.cf_id && settings.cfAccountId) await deleteDestination(cf, settings.cfAccountId, row.cf_id).catch(() => undefined);
  await run(c.env.DB, 'DELETE FROM forward_destinations WHERE address = ?', address);
  return c.json({ ok: true });
});
