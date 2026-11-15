// The browser's side of Web Push, for tests: a device subscription (what PushManager.subscribe
// returns), decryption of a push the fake push service received (RFC 8291 / RFC 8188, as the
// user agent does it), and the checks a push service makes on the VAPID header (RFC 8292).
import { fromBase64Url, toBase64Url } from '../../src/worker/lib/crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Device {
  endpoint: string;
  p256dh: string;
  auth: string;
  privateKey: CryptoKey;
}

let n = 0;
export async function newDevice(host = 'fcm.googleapis.com', path?: string): Promise<Device> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return {
    endpoint: `https://${host}${path ?? `/fcm/send/device-${++n}-${Date.now()}`}`,
    p256dh: toBase64Url(pub),
    auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    privateKey: pair.privateKey,
  };
}

// The subscription JSON the web app posts.
export const subscription = (d: Device) => ({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// Decrypts an aes128gcm push body (one record) with the device's keys.
export async function decryptPush(body: Uint8Array, device: { p256dh: string; auth: string; privateKey: CryptoKey }): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  if (idlen !== 65 || asPublic[0] !== 4) throw new Error(`keyid is not an uncompressed P-256 key (idlen ${idlen})`);
  if (ciphertext.length > rs) throw new Error('push body spans more than one record');
  const uaPublic = fromBase64Url(device.p256dh);
  const peer = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // workers-types calls the peer key `$public`; the runtime reads `public`, as in Web Crypto.
  const ecdh = { name: 'ECDH', public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, device.privateKey, 256));
  const ikm = await hkdf(fromBase64Url(device.auth), shared, concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  // Strip the padding: trailing zeros, then the last-record delimiter 0x02.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('missing last-record delimiter');
  return decoder.decode(padded.slice(0, end));
}

// Imports a device private key given as raw RFC 8291 test-vector values.
export async function importDevicePrivateKey(privateB64: string, publicB64: string): Promise<CryptoKey> {
  const pub = fromBase64Url(publicB64);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateB64, x: toBase64Url(pub.slice(1, 33)), y: toBase64Url(pub.slice(33, 65)) };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

export interface VapidClaims {
  aud: string;
  exp: number;
  sub: string;
}

// Checks an "Authorization: vapid t=<jwt>, k=<key>" header the way a push service does, and
// returns the JWT claims.
export async function verifyVapid(header: string | undefined, endpoint: string): Promise<{ claims: VapidClaims; publicKey: string }> {
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+),\s*k=([\w-]+)$/.exec(header ?? '');
  if (!m) throw new Error(`not a VAPID header: ${header}`);
  const [, jwt, k] = m;
  const [h, c, s] = jwt.split('.');
  const head = JSON.parse(decoder.decode(fromBase64Url(h))) as { alg: string };
  if (head.alg !== 'ES256') throw new Error(`alg ${head.alg}`);
  const key = await crypto.subtle.importKey('raw', fromBase64Url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(s), encoder.encode(`${h}.${c}`));
  if (!valid) throw new Error('VAPID signature does not verify against k');
  const claims = JSON.parse(decoder.decode(fromBase64Url(c))) as VapidClaims;
  if (claims.aud !== new URL(endpoint).origin) throw new Error(`aud ${claims.aud} is not the endpoint's origin`);
  return { claims, publicKey: k };
}
