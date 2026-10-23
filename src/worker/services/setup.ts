// First-run setup: checks the deployment, then lets the owner claim the instance by creating the
// admin mailbox on one of their domains. Claiming needs the ENCRYPTION_KEY from the deploy form,
// so nobody who merely finds the workers.dev URL first can take over a fresh instance.
import type { Env } from '../env';
import { loadSettings, saveSettings, type AppSettings } from '../db/settings';
import { first } from '../db/db';
import { cfFromEnv } from '../cloudflare/client';
import { checkPermissions, listZones, verifyToken, type PermissionCheck } from '../cloudflare/token';
import { detectWorker } from '../cloudflare/workers';
import { encrypt } from '../lib/crypto';
import { errorMessage } from '../lib/errors';

export interface CheckResult {
  ok: boolean;
  message: string;
  warning?: boolean;
}

export interface SetupStatus {
  setupComplete: boolean;
  checks: {
    database: CheckResult;
    encryptionKey: CheckResult;
    cloudflare: CheckResult & { source: 'secret' | 'stored' | null };
    worker: CheckResult & { name?: string; subdomain?: string | null; accountName?: string };
    zones: CheckResult & { count: number };
  };
  permissions: PermissionCheck[];
  zones: { id: string; name: string; status: string }[];
}

export async function setupStatus(env: Env, host: string, refresh = false): Promise<SetupStatus> {
  const checks = {} as SetupStatus['checks'];
  let settings: AppSettings | null = null;

  try {
    await first(env.DB, 'SELECT COUNT(*) AS n FROM users');
    settings = await loadSettings(env.DB, true);
    checks.database = { ok: true, message: 'Database is ready.' };
  } catch (e) {
    checks.database = {
      ok: false,
      message: /no such table/i.test(errorMessage(e))
        ? 'Database migrations have not run. Redeploy with the deploy command `npm run deploy`.'
        : `Database error: ${errorMessage(e)}`,
    };
  }

  const key = env.ENCRYPTION_KEY ?? '';
  checks.encryptionKey = !key
    ? { ok: false, message: 'ENCRYPTION_KEY is not set. Add it in the Worker settings (Variables and Secrets) and reload.' }
    : key.length < 32
      ? { ok: true, warning: true, message: `ENCRYPTION_KEY is short (${key.length} characters). 32 or more is recommended.` }
      : { ok: true, message: 'Encryption key is set.' };

  const empty: SetupStatus = {
    setupComplete: !!settings?.setupCompletedAt,
    checks: {
      ...checks,
      cloudflare: { ok: false, source: null, message: 'Waiting for the checks above.' },
      worker: { ok: false, message: 'Waiting for the Cloudflare token.' },
      zones: { ok: false, count: 0, message: 'Waiting for the Cloudflare token.' },
    },
    permissions: [],
    zones: [],
  };
  if (!settings || !checks.encryptionKey.ok) return empty;

  let cf;
  try {
    cf = await cfFromEnv(env, settings);
  } catch (e) {
    empty.checks.cloudflare = { ok: false, source: 'stored', message: errorMessage(e) };
    return empty;
  }
  if (!cf) {
    empty.checks.cloudflare = { ok: false, source: null, message: 'No Cloudflare API token yet. Paste one below.' };
    return empty;
  }
  const source = env.CF_API_TOKEN ? 'secret' : 'stored';
  const token = await verifyToken(cf);
  if (!token.valid) {
    empty.checks.cloudflare = { ok: false, source, message: token.message ?? 'Cloudflare rejected the token.' };
    return empty;
  }
  checks.cloudflare = { ok: true, source, message: `Token is valid (${token.kind === 'account' ? 'account' : 'user'} token).` };

  let identity = settings.cfAccountId && settings.cfWorkerName && !refresh
    ? { accountId: settings.cfAccountId, accountName: settings.cfAccountName ?? '', workerName: settings.cfWorkerName, workersSubdomain: settings.cfWorkersSubdomain, d1Id: settings.cfD1Id }
    : null;
  if (!identity) {
    try {
      identity = await detectWorker(cf, host, env.WORKER_NAME);
      await saveSettings(env.DB, {
        cfAccountId: identity.accountId,
        cfAccountName: identity.accountName,
        cfWorkerName: identity.workerName,
        cfWorkersSubdomain: identity.workersSubdomain,
        cfD1Id: identity.d1Id,
      });
    } catch (e) {
      checks.worker = { ok: false, message: errorMessage(e) };
    }
  }
  if (identity) {
    checks.worker = {
      ok: true,
      name: identity.workerName,
      subdomain: identity.workersSubdomain,
      accountName: identity.accountName,
      message: `Found the ${identity.workerName} Worker in ${identity.accountName || 'your account'}.`,
    };
  }

  let zones: SetupStatus['zones'] = [];
  try {
    zones = (await listZones(cf, identity?.accountId)).map((z) => ({ id: z.id, name: z.name, status: z.status }));
    checks.zones = zones.length
      ? { ok: true, count: zones.length, message: `${zones.length} domain${zones.length === 1 ? '' : 's'} found.` }
      : { ok: false, count: 0, message: 'No domains in this account. Add your domain to Cloudflare first, then reload.' };
  } catch (e) {
    checks.zones = { ok: false, count: 0, message: errorMessage(e) };
  }

  const permissions = identity ? await checkPermissions(cf, identity.accountId, zones.find((z) => z.status === 'active')?.id ?? zones[0]?.id ?? null) : [];
  return { setupComplete: !!settings.setupCompletedAt, checks, permissions, zones };
}

// Stores a token pasted on the setup page (when the CF_API_TOKEN secret isn't set).
export async function saveToken(env: Env, token: string): Promise<void> {
  await saveSettings(env.DB, {
    cfTokenEnc: await encrypt(env, token.trim()),
    cfAccountId: null,
    cfWorkerName: null,
    cfAccountName: null,
    cfWorkersSubdomain: null,
    cfD1Id: null,
  });
}
