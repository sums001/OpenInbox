// WebCrypto helpers: AES-GCM for stored credentials (keyed by ENCRYPTION_KEY), hashing, tokens.
import type { Env } from '../env';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(input: string): Uint8Array {
  const text = input.replace(/=+$/, '');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

// Constant-time comparison. Hashing first makes the lengths equal, so length leaks nothing.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

// HKDF turns any ENCRYPTION_KEY string into a 256-bit AES-GCM key.
function aesKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('openinbox'), info: encoder.encode('openinbox credentials v1') },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    keyCache.set(secret, key);
  }
  return key;
}

export class EncryptionKeyError extends Error {}

function currentSecret(env: Env): string {
  if (!env.ENCRYPTION_KEY) throw new EncryptionKeyError('ENCRYPTION_KEY is not set.');
  return env.ENCRYPTION_KEY;
}

// Output format: "v1.<iv>.<ciphertext>", both base64url.
export async function encrypt(env: Env, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(currentSecret(env)), encoder.encode(plaintext));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

// Tries ENCRYPTION_KEY, then ENCRYPTION_KEY_PREVIOUS (set during a key rotation).
export async function decrypt(env: Env, payload: string): Promise<string> {
  const [version, ivText, ctText] = payload.split('.');
  if (version !== 'v1' || !ivText || !ctText) throw new EncryptionKeyError('Unknown encrypted value format.');
  const secrets = [currentSecret(env), env.ENCRYPTION_KEY_PREVIOUS].filter((s): s is string => !!s);
  for (const secret of secrets) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(ivText) },
        await aesKey(secret),
        fromBase64Url(ctText),
      );
      return decoder.decode(pt);
    } catch {
      // try the next key
    }
  }
  throw new EncryptionKeyError('Stored credentials cannot be decrypted. Was ENCRYPTION_KEY changed?');
}

export async function encryptJson(env: Env, value: unknown): Promise<string> {
  return encrypt(env, JSON.stringify(value));
}

export async function decryptJson<T>(env: Env, payload: string): Promise<T> {
  return JSON.parse(await decrypt(env, payload)) as T;
}

export async function hmacSha256(key: Uint8Array | string, data: string | Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? encoder.encode(data) : data));
}
