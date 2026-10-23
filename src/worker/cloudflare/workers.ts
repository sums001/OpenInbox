// Finds this Worker in the account. The runtime doesn't expose the Worker's own name, and the
// Deploy button lets users rename it, so it is read from the request host: a fresh deploy is only
// reachable at <worker>.<subdomain>.workers.dev. The API confirms it and gives the D1 id.
import type { Cloudflare } from './client';
import { CfError } from './client';

export interface Account {
  id: string;
  name: string;
}

export interface WorkerIdentity {
  accountId: string;
  accountName: string;
  workerName: string;
  workersSubdomain: string | null;
  d1Id: string | null;
}

export async function listAccounts(cf: Cloudflare): Promise<Account[]> {
  return cf.paginate<Account>('/accounts', 50, 5);
}

interface ScriptSettings {
  bindings?: { type: string; name: string; id?: string; database_id?: string }[];
}

export async function scriptD1Id(cf: Cloudflare, accountId: string, worker: string): Promise<string | null> {
  const s = await cf.get<ScriptSettings>(`/accounts/${accountId}/workers/scripts/${worker}/settings`);
  const b = s.bindings?.find((x) => x.type === 'd1' && x.name === 'DB');
  return b?.id ?? b?.database_id ?? null;
}

export async function detectWorker(cf: Cloudflare, host: string, nameOverride?: string): Promise<WorkerIdentity> {
  const accounts = await listAccounts(cf);
  if (!accounts.length) throw new Error('The Cloudflare token cannot see any account. Check its Account permissions.');
  const hostname = host.split(':')[0].toLowerCase();
  const labels = hostname.split('.');
  let workerName = nameOverride || null;
  let subdomain: string | null = null;
  let account: Account | null = null;

  if (hostname.endsWith('.workers.dev') && labels.length >= 4) {
    workerName ??= labels[0];
    subdomain = labels[1];
    for (const a of accounts) {
      try {
        const s = await cf.get<{ subdomain: string }>(`/accounts/${a.id}/workers/subdomain`);
        if (s.subdomain?.toLowerCase() === subdomain) {
          account = a;
          break;
        }
      } catch {
        // not this account
      }
    }
    // The subdomain names the account. A same-named Worker in another account is someone else's.
    if (!account) throw new Error(`None of the accounts this token can see owns ${subdomain}.workers.dev.`);
  } else if (!workerName) {
    // Reached through a custom domain: ask each account which Worker serves this hostname.
    for (const a of accounts) {
      try {
        const domains = await cf.get<{ hostname: string; service: string }[]>(
          `/accounts/${a.id}/workers/domains?hostname=${encodeURIComponent(hostname)}`,
        );
        const d = domains.find((x) => x.hostname.toLowerCase() === hostname);
        if (d) {
          account = a;
          workerName = d.service;
          break;
        }
      } catch {
        // not this account
      }
    }
  }

  if (!workerName) throw new Error(`Could not work out this Worker's name from ${hostname}. Open the app at its workers.dev address.`);
  const candidates = account ? [account] : accounts;
  for (const a of candidates) {
    try {
      const d1Id = await scriptD1Id(cf, a.id, workerName);
      let sub = subdomain;
      if (!sub) {
        try {
          sub = (await cf.get<{ subdomain: string }>(`/accounts/${a.id}/workers/subdomain`)).subdomain ?? null;
        } catch {
          sub = null;
        }
      }
      return { accountId: a.id, accountName: a.name, workerName, workersSubdomain: sub, d1Id };
    } catch (e) {
      if (e instanceof CfError && e.isAuth) throw e;
      // Worker not in this account; try the next one.
    }
  }
  throw new Error(`Worker "${workerName}" was not found in the accounts this token can see.`);
}

// Setting a secret deploys a new version of the Worker with it. Later deploys keep it.
export async function putWorkerSecret(cf: Cloudflare, accountId: string, worker: string, name: string, text: string): Promise<void> {
  await cf.request('PUT', `/accounts/${accountId}/workers/scripts/${worker}/secrets`, { name, text, type: 'secret_text' });
}

export interface CustomDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
}

export async function listCustomDomains(cf: Cloudflare, accountId: string, service: string): Promise<CustomDomain[]> {
  const all = await cf.get<CustomDomain[]>(`/accounts/${accountId}/workers/domains?service=${encodeURIComponent(service)}`);
  return all.filter((d) => d.service === service);
}

export async function attachCustomDomain(cf: Cloudflare, accountId: string, zoneId: string, hostname: string, service: string): Promise<CustomDomain> {
  return cf.request<CustomDomain>('PUT', `/accounts/${accountId}/workers/domains`, {
    hostname,
    service,
    zone_id: zoneId,
    environment: 'production',
  });
}

export async function detachCustomDomain(cf: Cloudflare, accountId: string, id: string): Promise<void> {
  await cf.request('DELETE', `/accounts/${accountId}/workers/domains/${id}`);
}
