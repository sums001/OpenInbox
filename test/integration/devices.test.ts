// Connecting a phone by QR code: the web app shows a code, the phone claims it, the person allows
// it in the web app, and the phone collects a key of its own, once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { useFakeApis } from '../helpers/fake';
import { Client, ORIGIN, setupInstance } from '../helpers/client';

// The phone: no cookie, no Origin, no CSRF token.
async function phone(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('connecting a phone', () => {
  let admin: Client;
  beforeEach(async () => {
    useFakeApis();
    admin = new Client();
    await setupInstance(admin);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const start = async () => {
    const p = await admin.post('/api/account/devices/pairing');
    const url = new URL(p.url);
    return { ...p, code: url.searchParams.get('code')!, server: url.searchParams.get('server')! };
  };

  it('pairs by QR code once the person allows it, and hands over the key once', async () => {
    const p = await start();
    expect(p.url).toMatch(/^openinbox:\/\/pair\?v=1&/);
    expect(p.server).toBe(ORIGIN);
    expect(p.shortCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const claim = await phone('POST', '/api/devices/pair', { code: p.code, name: 'Pixel 8', platform: 'android' });
    expect(claim.status).toBe(200);
    expect(claim.body).toEqual({ id: p.id, secret: expect.any(String), expiresAt: expect.any(Number) });
    // The phone learns nothing about the account before it is allowed; the code works once.
    expect(JSON.stringify(claim.body)).not.toContain('admin@example.com');
    expect((await phone('POST', '/api/devices/pair', { code: p.code, name: 'Other', platform: 'ios' })).status).toBe(404);

    expect(await admin.get(`/api/account/devices/pairing/${p.id}`)).toMatchObject({ status: 'claimed', deviceName: 'Pixel 8', platform: 'android' });
    expect((await phone('POST', `/api/devices/pair/${p.id}`, { secret: claim.body.secret })).body).toMatchObject({ status: 'waiting' });
    expect((await phone('POST', `/api/devices/pair/${p.id}`, { secret: 'x'.repeat(43) })).status).toBe(404);

    const decided = await admin.post(`/api/account/devices/pairing/${p.id}`, { allow: true });
    expect(decided).toMatchObject({ deviceId: expect.any(Number), name: 'Pixel 8' });
    const got = await phone('POST', `/api/devices/pair/${p.id}`, { secret: claim.body.secret });
    expect(got.body).toMatchObject({ status: 'approved', token: expect.stringMatching(/^oik_/), user: { email: 'admin@example.com' } });
    expect((await phone('POST', `/api/devices/pair/${p.id}`, { secret: claim.body.secret })).status).toBe(404);

    // The key works on the Inbox API, shows under Devices (not API keys), and removing it revokes it.
    const auth = { Authorization: `Bearer ${got.body.token}` };
    expect((await phone('GET', '/api/v1/me', undefined, auth)).body.user.email).toBe('admin@example.com');
    const devices = await admin.get('/api/account/devices');
    expect(devices).toEqual([{ id: decided.deviceId, name: 'Pixel 8', platform: 'android', createdAt: expect.any(Number), lastUsedAt: expect.any(Number), lastUsedIp: expect.anything() }]);
    expect(await admin.get('/api/account/api-keys')).toEqual([]);
    expect(await admin.status('DELETE', `/api/account/api-keys/${decided.deviceId}`)).toBe(404);
    await admin.del(`/api/account/devices/${decided.deviceId}`);
    expect((await phone('GET', '/api/v1/me', undefined, auth)).status).toBe(401);
  });

  it('lets the phone disconnect itself, but not an API key made by hand', async () => {
    const p = await start();
    const claim = await phone('POST', '/api/devices/pair', { code: p.code, name: 'Pixel 8', platform: 'android' });
    await admin.post(`/api/account/devices/pairing/${p.id}`, { allow: true });
    const { token } = (await phone('POST', `/api/devices/pair/${p.id}`, { secret: claim.body.secret })).body;
    const auth = { Authorization: `Bearer ${token}` };
    expect((await phone('GET', '/api/v1/me', undefined, auth)).body.key.kind).toBe('device');
    expect((await phone('POST', '/api/v1/device/disconnect', undefined, auth)).body).toEqual({ ok: true });
    expect((await phone('GET', '/api/v1/me', undefined, auth)).status).toBe(401);
    expect(await admin.get('/api/account/devices')).toEqual([]);

    const { key } = await admin.post('/api/account/api-keys', { password: 'correct horse battery', name: 'Script', scopes: ['read'] });
    const scriptAuth = { Authorization: `Bearer ${key}` };
    expect((await phone('GET', '/api/v1/me', undefined, scriptAuth)).body.key.kind).toBe('key');
    expect((await phone('POST', '/api/v1/device/disconnect', undefined, scriptAuth)).status).toBe(409);
    expect((await phone('GET', '/api/v1/me', undefined, scriptAuth)).status).toBe(200);
  });

  it('takes the short code typed by hand, and tells the phone when it is denied', async () => {
    const p = await start();
    const typed = p.shortCode.toLowerCase().replace('-', ' ');
    const claim = await phone('POST', '/api/devices/pair', { shortCode: typed, name: 'iPhone', platform: 'ios' });
    expect(claim.status).toBe(200);
    await admin.post(`/api/account/devices/pairing/${p.id}`, { allow: false });
    expect((await phone('POST', `/api/devices/pair/${p.id}`, { secret: claim.body.secret })).body).toEqual({ status: 'denied' });
    expect(await admin.get('/api/account/devices')).toEqual([]);
  });

  it('expires after 5 minutes, and a new code replaces the one before', async () => {
    const first = await start();
    const second = await start();
    expect((await phone('POST', '/api/devices/pair', { code: first.code, name: 'Old', platform: 'android' })).status).toBe(404);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await phone('POST', '/api/devices/pair', { code: second.code, name: 'Late', platform: 'android' })).status).toBe(404);
    expect((await admin.get(`/api/account/devices/pairing/${second.id}`)).status).toBe('expired');
  });

  it('limits wrong codes per address, and only a signed-in user can start one', async () => {
    for (let i = 0; i < 10; i++) expect((await phone('POST', '/api/devices/pair', { shortCode: 'AAAA-AAAA', name: 'x', platform: 'android' })).status).toBe(404);
    expect((await phone('POST', '/api/devices/pair', { shortCode: 'AAAA-AAAA', name: 'x', platform: 'android' })).status).toBe(429);
    // Starting one needs the signed-in web app (cookie and CSRF token); a phone can't start its own.
    expect((await phone('POST', '/api/account/devices/pairing')).status).toBe(403);
    expect(await new Client().status('GET', '/api/account/devices')).toBe(401);
  });

  it('lets the app built for the web call the pairing endpoints, and only those', async () => {
    const preflight = await worker.fetch(
      new Request(ORIGIN + '/api/devices/pair', { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }),
      env,
      createExecutionContext(),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const poll = await worker.fetch(new Request(ORIGIN + '/api/devices/pair/1', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } }), env, createExecutionContext());
    expect(poll.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const account = await worker.fetch(new Request(ORIGIN + '/api/account/devices', { headers: { Origin: 'https://app.example' } }), env, createExecutionContext());
    expect(account.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
