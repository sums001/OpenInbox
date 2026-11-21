// Domains whose zone sits in another Cloudflare account. Email Routing hands a zone's mail only to
// a Worker in that zone's own account, so OpenInbox installs a small relay Worker there
// (cloudflare/relay-worker.js) that passes each message on over HTTPS. The relay proves itself
// with a secret derived from ENCRYPTION_KEY and the account id (nothing new to store or rotate),
// and it may deliver only to domains in its own account.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { all, first } from '../db/db';
import { CfError, cfFromEnv, type Cloudflare } from '../cloudflare/client';
import { logError } from '../lib/log';
import { EncryptionKeyError, hmacSha256, safeEqual, toBase64Url } from '../lib/crypto';
import { badRequest, HttpError } from '../lib/errors';
import { domainOf, normalizeAddress } from '../mail/address';
import { logInbound } from './stats';
import { handleEmail } from './inbound';
import relaySource from '../cloudflare/relay-worker.js?raw';

const RELAY_COMPATIBILITY_DATE = '2026-10-01';

export function relayWorkerName(settings: Pick<AppSettings, 'cfWorkerName'>): string {
  return `${settings.cfWorkerName ?? 'openinbox'}-relay`;
}

async function secretFrom(key: string, accountId: string): Promise<string> {
  return toBase64Url(await hmacSha256(key, `openinbox relay ${accountId}`));
}

export async function relaySecret(env: Env, accountId: string): Promise<string> {
  if (!env.ENCRYPTION_KEY) throw new EncryptionKeyError('ENCRYPTION_KEY is not set.');
  return secretFrom(env.ENCRYPTION_KEY, accountId);
}

// During a key rotation, relays installed with the previous key keep working until repaired.
async function secretMatches(env: Env, accountId: string, given: string): Promise<boolean> {
  for (const key of [env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS]) {
    if (key && (await safeEqual(given, await secretFrom(key, accountId)))) return true;
  }
  return false;
}

// Uploads the relay Worker to the account, or updates it (its code, OpenInbox's address, the
// secret). Safe to run again.
export async function installRelay(cf: Cloudflare, env: Env, settings: AppSettings, accountId: string, appBase: string): Promise<void> {
  const metadata = {
    main_module: 'relay.js',
    compatibility_date: RELAY_COMPATIBILITY_DATE,
    bindings: [
      { type: 'plain_text', name: 'OPENINBOX_URL', text: appBase.replace(/\/+$/, '') },
      { type: 'plain_text', name: 'ACCOUNT_ID', text: accountId },
      { type: 'secret_text', name: 'RELAY_SECRET', text: await relaySecret(env, accountId) },
    ],
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('relay.js', new File([relaySource], 'relay.js', { type: 'application/javascript+module' }));
  await cf.request('PUT', `/accounts/${accountId}/workers/scripts/${relayWorkerName(settings)}`, form);
}

// Points every relay at a new app address. Failures are left for the domains' checks to show.
export async function updateRelays(env: Env, settings: AppSettings, appBase: string): Promise<void> {
  const cf = await cfFromEnv(env, settings);
  if (!cf || !settings.cfWorkerName) return;
  const accounts = await all<{ account_id: string }>(env.DB, 'SELECT DISTINCT account_id FROM domains WHERE account_id IS NOT NULL');
  for (const { account_id } of accounts) {
    await installRelay(cf, env, settings, account_id, appBase).catch((e) => logError('relay.update_failed', e, { account: account_id }));
  }
}

export async function removeRelay(cf: Cloudflare, settings: AppSettings, accountId: string): Promise<void> {
  await cf.request('DELETE', `/accounts/${accountId}/workers/scripts/${relayWorkerName(settings)}?force=true`);
}

// Whether the relay is in the account, and the address it passes mail to.
export async function relayState(cf: Cloudflare, settings: AppSettings, accountId: string): Promise<{ installed: boolean; url: string | null }> {
  try {
    const s = await cf.get<{ bindings?: { name: string; text?: string }[] }>(`/accounts/${accountId}/workers/scripts/${relayWorkerName(settings)}/settings`);
    return { installed: true, url: s.bindings?.find((b) => b.name === 'OPENINBOX_URL')?.text ?? null };
  } catch (e) {
    if (e instanceof CfError && (e.status === 404 || e.has(10007))) return { installed: false, url: null };
    throw e;
  }
}

export interface RelayAnswer {
  reject: string | null;
  forward: string[];
}

function envelopeHeader(req: Request, name: string): string {
  try {
    return decodeURIComponent(req.headers.get(name) ?? '');
  } catch {
    throw badRequest(`${name} is not URI-encoded.`);
  }
}

// One message from a relay. It runs through the same pipeline as mail that arrives directly; what
// would be done to the message (reject it, forward copies) goes back to the relay, which does it.
export async function handleRelayed(env: Env, ctx: ExecutionContext, accountId: string, req: Request): Promise<RelayAnswer> {
  const auth = req.headers.get('authorization') ?? '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!given || !(await secretMatches(env, accountId, given))) throw new HttpError(401, 'relay_auth', 'This relay is not known to OpenInbox.');
  const to = envelopeHeader(req, 'x-envelope-to');
  const from = envelopeHeader(req, 'x-envelope-from');
  if (!to) throw badRequest('X-Envelope-To is missing.');
  const bytes = new Uint8Array(await req.arrayBuffer());
  const answer: RelayAnswer = { reject: null, forward: [] };

  const domain = await first<{ account_id: string | null }>(env.DB, 'SELECT account_id FROM domains WHERE name = ?', domainOf(normalizeAddress(to)));
  if (domain?.account_id !== accountId) {
    answer.reject = '550 5.1.1 Unknown recipient.';
    await logInbound(env.DB, { from, to, size: bytes.byteLength, status: 'rejected', reason: 'relayed from another Cloudflare account' }, true);
    return answer;
  }

  const message = {
    from,
    to,
    raw: new Response(bytes).body,
    rawSize: bytes.byteLength,
    headers: new Headers(),
    setReject(reason: string) {
      answer.reject = reason;
    },
    async forward(address: string) {
      answer.forward.push(address);
    },
    async reply() {
      throw new Error('Replying is not available for relayed mail.');
    },
  } as unknown as ForwardableEmailMessage;
  await handleEmail(message, env, ctx);
  return answer;
}
