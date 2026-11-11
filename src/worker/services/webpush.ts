// Web Push (RFC 8291 message encryption & RFC 8292 VAPID authentication)
// Runs directly on Cloudflare Workers using standard Web Crypto API.
import type { Env } from '../env';
import { all, first, run } from '../db/db';
import { loadSettings } from '../db/settings';
import { decrypt, encrypt, fromBase64Url, toBase64Url } from '../lib/crypto';
import { log, logError } from '../lib/log';

export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string | null;
  created_at: number;
  last_used_at: number;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  threadId?: number;
  tag?: string;
  icon?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: CryptoKey;
}

let cachedKeys: VapidKeys | null = null;

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

export async function getOrGenerateVapidKeys(env: Env): Promise<VapidKeys> {
  if (cachedKeys) return cachedKeys;

  const rows = await all<{ key: string; value: string }>(
    env.DB,
    "SELECT key, value FROM settings WHERE key IN ('vapid.public_key', 'vapid.private_key')",
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const pub = map.get('vapid.public_key');
  const privEnc = map.get('vapid.private_key');

  if (pub && privEnc) {
    try {
      const privJson = await decrypt(env, privEnc);
      const jwk = JSON.parse(privJson) as JsonWebKey;
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
      );
      cachedKeys = { publicKey: pub, privateKey };
      return cachedKeys;
    } catch (e) {
      logError('vapid.load_failed', e);
    }
  }

  // Generate a new ECDSA P-256 key pair
  log('vapid.generating_keys');
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const rawPub = new Uint8Array((await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer);
  const publicKey = toBase64Url(rawPub);
  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const privEncrypted = await encrypt(env, JSON.stringify(privJwk));

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).bind('vapid.public_key', publicKey, now),
    env.DB.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).bind('vapid.private_key', privEncrypted, now),
  ]);

  cachedKeys = { publicKey, privateKey: keyPair.privateKey };
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

  return 'https://openinbox.app';
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

export async function sendWebPush(env: Env, sub: PushSubscriptionRow, payload: PushPayload): Promise<boolean> {
  try {
    const { publicKey, privateKey } = await getOrGenerateVapidKeys(env);
    const subject = await getVapidSubject(env);
    const authHeader = await createVapidAuthHeader(sub.endpoint, privateKey, publicKey, subject);
    const bodyBytes = await encryptPayload(sub.p256dh, sub.auth, payload);

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
        'Urgency': 'high',
        'Authorization': authHeader,
      },
      body: bodyBytes,
    });

    if (res.status === 404 || res.status === 410) {
      // Endpoint is expired or unregistered; clean it up from database
      log('webpush.prune_expired', { endpoint: sub.endpoint, status: res.status });
      await run(env.DB, 'DELETE FROM push_subscriptions WHERE id = ?', sub.id);
      return false;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logError('webpush.send_failed', new Error(`Push server returned ${res.status}: ${text}`), {
        endpoint: sub.endpoint,
        status: res.status,
      });
      return false;
    }

    await run(env.DB, 'UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?', Date.now(), sub.id);
    return true;
  } catch (e) {
    logError('webpush.error', e, { endpoint: sub.endpoint });
    return false;
  }
}

export async function notifyMailboxMembers(env: Env, mailboxId: number, payload: PushPayload): Promise<void> {
  const subscriptions = await all<PushSubscriptionRow>(
    env.DB,
    `SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth, s.created_at, s.last_used_at
     FROM push_subscriptions s
     JOIN mailbox_members m ON m.user_id = s.user_id
     WHERE m.mailbox_id = ?`,
    mailboxId,
  );

  if (!subscriptions.length) return;

  await Promise.allSettled(subscriptions.map((sub) => sendWebPush(env, sub, payload)));
}

export async function notifyUser(env: Env, userId: number, payload: PushPayload): Promise<number> {
  const subscriptions = await all<PushSubscriptionRow>(
    env.DB,
    'SELECT * FROM push_subscriptions WHERE user_id = ?',
    userId,
  );
  if (!subscriptions.length) return 0;
  const results = await Promise.allSettled(subscriptions.map((sub) => sendWebPush(env, sub, payload)));
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}
