// Web Push (RFC 8291 message encryption & RFC 8292 VAPID authentication)
// Runs directly on Cloudflare Workers using standard Web Crypto API.
import type { Env } from '../env';
import { all, first } from '../db/db';
import { loadSettings } from '../db/settings';
import { decrypt, encrypt, fromBase64Url, toBase64Url } from '../lib/crypto';
import { log, logError } from '../lib/log';
import { isPushEndpoint } from '../../shared/schemas';

export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string | null;
  created_at: number;
  last_used_at: number;
  // The owner's users.preferences JSON, when the query selected it.
  preferences?: string | null;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  threadId?: number;
  tag?: string;
  icon?: string;
}

// Who sees what: most people get "New mail, from X", which is safe on a lock screen. Someone who
// turns on "Show the subject" in Settings gets the subject too (pushPreview: 'subject').
export type PushContent = PushPayload | ((sub: PushSubscriptionRow) => PushPayload);

export function wantsSubject(sub: PushSubscriptionRow): boolean {
  try {
    return (JSON.parse(sub.preferences ?? '{}') as { pushPreview?: unknown }).pushPreview === 'subject';
  } catch {
    return false;
  }
}

// A Topic lets the push service replace a notice for the same conversation that hasn't been
// delivered yet (a phone that is offline gets one notice, not five). At most 32 URL-safe characters.
export const pushTopic = (tag: string | undefined) => (tag ? tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined : undefined);

interface VapidKeys {
  publicKey: string;
  privateKey: CryptoKey;
}

// The imported key, reused while the stored (encrypted) value is unchanged.
let cachedKeys: (VapidKeys & { stored: string }) | null = null;

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, curr) => acc + curr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

async function storedKeys(env: Env): Promise<{ pub?: string; priv?: string }> {
  const rows = await all<{ key: string; value: string }>(
    env.DB,
    "SELECT key, value FROM settings WHERE key IN ('vapid.public_key', 'vapid.private_key')",
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return { pub: map.get('vapid.public_key'), priv: map.get('vapid.private_key') };
}

// The instance's VAPID key pair, generated on first use. Every browser subscription is bound to
// the public key, so the pair is never replaced on its own: if the private key can't be decrypted
// (ENCRYPTION_KEY changed without a re-encrypt), this throws instead.
export async function getOrGenerateVapidKeys(env: Env): Promise<VapidKeys> {
  let { pub, priv } = await storedKeys(env);
  if (!pub || !priv) {
    log('vapid.generating_keys');
    const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const rawPub = new Uint8Array((await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer);
    const privEncrypted = await encrypt(env, JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey)));
    const now = Date.now();
    // DO NOTHING: when two isolates generate at once, the first pair written wins for both.
    const insert = 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING';
    await env.DB.batch([
      env.DB.prepare(insert).bind('vapid.public_key', toBase64Url(rawPub), now),
      env.DB.prepare(insert).bind('vapid.private_key', privEncrypted, now),
    ]);
    ({ pub, priv } = await storedKeys(env));
    if (!pub || !priv) throw new Error('VAPID keys could not be stored.');
  }
  if (cachedKeys?.stored === priv && cachedKeys.publicKey === pub) return cachedKeys;
  const jwk = JSON.parse(await decrypt(env, priv)) as JsonWebKey;
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cachedKeys = { publicKey: pub, privateKey, stored: priv };
  return cachedKeys;
}

function getAudience(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

async function getVapidSubject(env: Env): Promise<string> {
  const settings = await loadSettings(env.DB);
  if (settings.appUrl) {
    try {
      const u = new URL(settings.appUrl);
      if (u.hostname && !u.hostname.includes('localhost') && !u.hostname.endsWith('.local') && u.hostname.includes('.')) {
        return `mailto:postmaster@${u.hostname}`;
      }
    } catch {
      // ignore
    }
  }

  const domain = await first<{ name: string }>(env.DB, "SELECT name FROM domains WHERE status = 'active' LIMIT 1");
  if (domain?.name && !domain.name.includes('localhost') && !domain.name.endsWith('.local') && domain.name.includes('.')) {
    return `mailto:postmaster@${domain.name}`;
  }

  // A subject the instance controls, never someone else's domain.
  return settings.appUrl?.startsWith('https://') ? settings.appUrl : 'mailto:postmaster@localhost';
}

async function createVapidAuthHeader(endpoint: string, privateKey: CryptoKey, publicKey: string, subject: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: getAudience(endpoint),
        exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiration
        sub: subject,
      }),
    ),
  );
  const input = `${header}.${claims}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(input),
  );
  const jwt = `${input}.${toBase64Url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${publicKey}`;
}

async function encryptPayload(clientP256dh: string, clientAuth: string, payload: PushPayload): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const clientPublicRaw = fromBase64Url(clientP256dh);
  const clientAuthBytes = fromBase64Url(clientAuth);
  const payloadBytes = encoder.encode(JSON.stringify(payload));

  // Ephemeral server ECDH key
  const serverEcdh = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const serverPublicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', serverEcdh.publicKey)) as ArrayBuffer);

  // Peer client key
  const peerKey = await crypto.subtle.importKey('raw', clientPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // Shared secret
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey, $public: peerKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, serverEcdh.privateKey, 256);

  // IKM derivation
  const baseKey = await crypto.subtle.importKey('raw', new Uint8Array(sharedBits), 'HKDF', false, ['deriveBits']);
  const keyInfo = concatBytes(encoder.encode('WebPush: info\0'), clientPublicRaw, serverPublicRaw);
  const ikmBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: clientAuthBytes, info: keyInfo },
    baseKey,
    256,
  );

  // Derive AES-GCM key and nonce
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', new Uint8Array(ikmBits), 'HKDF', false, ['deriveKey', 'deriveBits']);

  const cekKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('Content-Encoding: aes128gcm\0') },
    ikmKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt'],
  );

  const nonceBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('Content-Encoding: nonce\0') },
    ikmKey,
    96,
  );
  const nonce = new Uint8Array(nonceBits);

  // Record: payload + 0x02 delimiter
  const record = concatBytes(payloadBytes, new Uint8Array([2]));
  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, record);
  const cipherBytes = new Uint8Array(cipherBuffer);

  // RFC 8291 body format: salt(16) + rs(4) + idlen(1) + serverPublicKey(65) + cipherBytes
  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // 4096 bytes record size
  const idlen = new Uint8Array([serverPublicRaw.length]);
  return concatBytes(salt, rs, idlen, serverPublicRaw, cipherBytes);
}

// Each push is one subrequest. The free plan allows 50 per invocation, D1 calls included, and
// the email handler has used about 15 by the time it gets here; 20 pushes plus the 3 D1 calls
// around them leave room for an auto-reply. Most recently active devices go first.
export const MAX_PUSHES_PER_MESSAGE = 20;

type Outcome = 'sent' | 'gone' | 'failed';

interface Sender {
  publicKey: string;
  privateKey: CryptoKey;
  subject: string;
}

// Resolved once per message, not once per push.
async function pushSender(env: Env): Promise<Sender> {
  const { publicKey, privateKey } = await getOrGenerateVapidKeys(env);
  return { publicKey, privateKey, subject: await getVapidSubject(env) };
}

// One push. Never throws, and leaves the database alone: the caller records all outcomes at once.
async function deliver(sender: Sender, sub: PushSubscriptionRow, payload: PushPayload): Promise<Outcome> {
  // Routes validate endpoints already; this keeps any other row from reaching fetch().
  if (!isPushEndpoint(sub.endpoint)) {
    log('webpush.endpoint_refused', { id: sub.id });
    return 'failed';
  }
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
        // Mail can wait for the phone's next wake-up; 'high' costs battery on Android.
        'Urgency': 'normal',
        ...(pushTopic(payload.tag) ? { Topic: pushTopic(payload.tag)! } : {}),
        'Authorization': await createVapidAuthHeader(sub.endpoint, sender.privateKey, sender.publicKey, sender.subject),
      },
      body: await encryptPayload(sub.p256dh, sub.auth, payload),
    });
    if (res.status === 404 || res.status === 410) {
      // The browser dropped this subscription.
      log('webpush.prune_expired', { id: sub.id, status: res.status });
      return 'gone';
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logError('webpush.send_failed', new Error(`Push server returned ${res.status}: ${text.slice(0, 200)}`), { id: sub.id, status: res.status });
      return 'failed';
    }
    return 'sent';
  } catch (e) {
    logError('webpush.error', e, { id: sub.id });
    return 'failed';
  }
}

// Sends one payload to many subscriptions, then records the outcomes in a single D1 batch.
async function sendAll(env: Env, subs: PushSubscriptionRow[], content: PushContent): Promise<number> {
  if (!subs.length) return 0;
  let sender: Sender;
  try {
    sender = await pushSender(env);
  } catch (e) {
    logError('webpush.keys_failed', e);
    return 0;
  }
  const outcomes = await Promise.all(subs.map((sub) => deliver(sender, sub, typeof content === 'function' ? content(sub) : content)));
  const now = Date.now();
  const stmts = subs.flatMap((sub, i) =>
    outcomes[i] === 'gone'
      ? [env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id)]
      : outcomes[i] === 'sent'
        ? [env.DB.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?').bind(now, sub.id)]
        : [],
  );
  if (stmts.length) await env.DB.batch(stmts);
  return outcomes.filter((o) => o === 'sent').length;
}

export async function sendWebPush(env: Env, sub: PushSubscriptionRow, payload: PushPayload): Promise<boolean> {
  return (await sendAll(env, [sub], payload)) === 1;
}

function capped(subs: PushSubscriptionRow[], fields: Record<string, unknown>): PushSubscriptionRow[] {
  if (subs.length <= MAX_PUSHES_PER_MESSAGE) return subs;
  log('webpush.capped', { ...fields, limit: MAX_PUSHES_PER_MESSAGE });
  return subs.slice(0, MAX_PUSHES_PER_MESSAGE);
}

export async function notifyMailboxMembers(env: Env, mailboxId: number, payload: PushContent): Promise<void> {
  const subscriptions = await all<PushSubscriptionRow>(
    env.DB,
    `SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth, s.created_at, s.last_used_at, u.preferences
     FROM push_subscriptions s
     JOIN mailbox_members m ON m.user_id = s.user_id
     JOIN users u ON u.id = s.user_id AND u.status = 'active'
     WHERE m.mailbox_id = ?
     ORDER BY s.last_used_at DESC, s.id DESC LIMIT ?`,
    mailboxId,
    MAX_PUSHES_PER_MESSAGE + 1,
  );
  await sendAll(env, capped(subscriptions, { mailboxId }), payload);
}

export async function notifyUser(env: Env, userId: number, payload: PushPayload): Promise<number> {
  const subscriptions = await all<PushSubscriptionRow>(
    env.DB,
    `SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id AND u.status = 'active'
     WHERE s.user_id = ? ORDER BY s.last_used_at DESC, s.id DESC LIMIT ?`,
    userId,
    MAX_PUSHES_PER_MESSAGE + 1,
  );
  return sendAll(env, capped(subscriptions, { userId }), payload);
}
