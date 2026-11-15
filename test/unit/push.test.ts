// Web Push encryption and VAPID, checked from the receiving side: the test decrypts what the
// Worker sends exactly as a browser would, after proving the decryptor on RFC 8291's example.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { decryptPush, importDevicePrivateKey, newDevice, verifyVapid } from '../helpers/push';
import { fromBase64Url } from '../../src/worker/lib/crypto';
import { sendWebPush } from '../../src/worker/services/webpush';

// RFC 8291 Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const row = (d: { endpoint: string; p256dh: string; auth: string }) => ({ id: 1, user_id: 1, ...d, created_at: 0, last_used_at: 0 });

describe('web push crypto', () => {
  it('decrypts the RFC 8291 example (so the decryptor below can be trusted)', async () => {
    const privateKey = await importDevicePrivateKey(RFC.uaPrivate, RFC.uaPublic);
    expect(await decryptPush(fromBase64Url(RFC.body), { p256dh: RFC.uaPublic, auth: RFC.auth, privateKey })).toBe(RFC.plaintext);
  });

  it('sends a body a browser can decrypt, with a fresh salt and server key per push', async () => {
    const fake = useFakeApis();
    const device = await newDevice();
    const payload = { title: 'New mail', body: 'From: Ann', url: '/mail/all/inbox/1', tag: 'thread-1' };
    expect(await sendWebPush(env, row(device), payload)).toBe(true);
    expect(await sendWebPush(env, row(device), payload)).toBe(true);
    const [a, b] = fake.state.push.received;
    expect(JSON.parse(await decryptPush(fromBase64Url(a.body), device))).toEqual(payload);
    expect(JSON.parse(await decryptPush(fromBase64Url(b.body), device))).toEqual(payload);
    const [ba, bb] = [fromBase64Url(a.body), fromBase64Url(b.body)];
    expect(ba.slice(0, 16)).not.toEqual(bb.slice(0, 16)); // salt
    expect(ba.slice(21, 86)).not.toEqual(bb.slice(21, 86)); // ephemeral server key
  });

  it('signs a VAPID JWT for the endpoint origin with a short expiry', async () => {
    const fake = useFakeApis();
    const device = await newDevice('updates.push.services.mozilla.com', '/wpush/v2/abc');
    await sendWebPush(env, row(device), { title: 'x', body: 'y' });
    const [push] = fake.state.push.received;
    const { claims, publicKey } = await verifyVapid(push.headers.authorization, device.endpoint);
    const now = Date.now() / 1000;
    expect(claims.exp).toBeGreaterThan(now);
    expect(claims.exp).toBeLessThanOrEqual(now + 24 * 3600); // RFC 8292 §2: at most 24 hours
    expect(claims.sub).toMatch(/^(mailto:|https:)/);
    expect(fromBase64Url(publicKey)).toHaveLength(65);
    expect(push.headers['content-encoding']).toBe('aes128gcm');
    expect(Number(push.headers.ttl)).toBeGreaterThan(0);
  });
});
