// Web Push: subscription routes, who gets a push for inbound mail, and what it contains.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, ENCRYPTION_KEY, setupInstance } from '../helpers/client';
import { decryptPush, newDevice, subscription, type Device } from '../helpers/push';
import { decrypt, encrypt, fromBase64Url } from '../../src/worker/lib/crypto';
import { MAX_PUSHES_PER_MESSAGE } from '../../src/worker/services/webpush';
import type { FakeState } from '../mock/fake-apis';

interface Payload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
}

async function pushesTo(state: FakeState, device: Device): Promise<Payload[]> {
  const mine = state.push.received.filter((p) => p.endpoint === device.endpoint);
  return Promise.all(mine.map(async (p) => JSON.parse(await decryptPush(fromBase64Url(p.body), device)) as Payload));
}

const subscriptionCount = async (userId?: number) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions${userId ? ' WHERE user_id = ?' : ''}`).bind(...(userId ? [userId] : [])).first<{ n: number }>())!.n;

const userId = async (address: string) => (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(address).first<{ id: number }>())!.id;

describe('web push', () => {
  let fake: { state: FakeState };
  let admin: Client;
  let domainId: number;

  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    ({ domainId } = await setupInstance(admin));
  });

  async function member(name: string): Promise<{ client: Client; id: number }> {
    const created = await admin.post('/api/admin/users', { name, role: 'member', newMailbox: { localPart: name.toLowerCase(), domainId } });
    const client = new Client();
    await client.init();
    await client.post('/api/auth/login', { email: created.email, password: created.password });
    await client.post('/api/account/password', { next: `${name} has a new password 1` });
    return { client, id: created.id };
  }

  async function subscribe(c: Client, device?: Device): Promise<Device> {
    const d = device ?? (await newDevice());
    await c.post('/api/account/push/subscribe', subscription(d));
    return d;
  }

  // First in the file: the Worker caches the key pair per isolate once it has loaded it.
  it('generates the VAPID key pair once and stores the private key encrypted', async () => {
    const { publicKey } = await admin.get('/api/account/push/vapid-public-key');
    expect(fromBase64Url(publicKey)).toHaveLength(65);
    expect(fromBase64Url(publicKey)[0]).toBe(4);
    expect((await admin.get('/api/account/push/vapid-public-key')).publicKey).toBe(publicKey);
    const stored = await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid.private_key'").first<{ value: string }>();
    expect(stored?.value).toMatch(/^v1\./);
    expect(JSON.parse(await decrypt(env, stored!.value))).toMatchObject({ kty: 'EC', crv: 'P-256' });
  });

  it('keeps the VAPID key readable through an ENCRYPTION_KEY rotation', async () => {
    // Stored directly: the isolate's cached key pair would skip writing it again after the reset.
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
    const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('vapid.private_key', ?, 0)").bind(await encrypt(env, jwk)).run();
    const next = 'rotated-encryption-key-0123456789abcdef0123456789';
    admin.envOverride = { ENCRYPTION_KEY: next, ENCRYPTION_KEY_PREVIOUS: ENCRYPTION_KEY };
    await admin.post('/api/admin/reencrypt');
    const stored = await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid.private_key'").first<{ value: string }>();
    // Step 3 of a rotation removes ENCRYPTION_KEY_PREVIOUS: the key must decrypt without it.
    await expect(decrypt({ ...env, ENCRYPTION_KEY: next, ENCRYPTION_KEY_PREVIOUS: undefined }, stored!.value)).resolves.toContain('"d"');
  });

  describe('subscriptions', () => {
    it('require a signed-in user', async () => {
      const anon = new Client();
      await anon.init();
      const d = await newDevice();
      expect(await anon.status('GET', '/api/account/push/vapid-public-key')).toBe(401);
      expect(await anon.status('POST', '/api/account/push/subscribe', subscription(d))).toBe(401);
      expect(await anon.status('POST', '/api/account/push/unsubscribe', { endpoint: d.endpoint })).toBe(401);
      expect(await anon.status('POST', '/api/account/push/test', {})).toBe(401);
    });

    it('save one row per endpoint and update it on re-subscribe', async () => {
      const d = await subscribe(admin);
      const fresh = await newDevice();
      await admin.post('/api/account/push/subscribe', { ...subscription(fresh), endpoint: d.endpoint });
      expect(await subscriptionCount()).toBe(1);
      const row = await env.DB.prepare('SELECT p256dh, auth FROM push_subscriptions').first<{ p256dh: string; auth: string }>();
      expect(row).toEqual({ p256dh: fresh.p256dh, auth: fresh.auth });
    });

    it('reject keys that are not a P-256 public key and a 16-byte secret', async () => {
      const d = await newDevice();
      const bad = [
        { ...subscription(d), p256dh: d.p256dh.slice(0, 40) },
        { ...subscription(d), p256dh: 'A' + d.p256dh.slice(1) }, // not 0x04-prefixed
        { ...subscription(d), auth: d.auth + d.auth },
        { ...subscription(d), auth: 'not*base64url!' },
      ];
      for (const b of bad) expect(await admin.status('POST', '/api/account/push/subscribe', b), JSON.stringify(b)).toBe(400);
      expect(await subscriptionCount()).toBe(0);
    });

    it('reject endpoints the Worker should never call', async () => {
      const d = await newDevice();
      const endpoints = [
        'http://fcm.googleapis.com/fcm/send/x',
        'https://127.0.0.1/push',
        'https://[::1]/push',
        'https://10.0.0.1/push',
        'https://169.254.169.254/latest',
        'https://localhost/push',
        'https://fcm.googleapis.com:8443/fcm/send/x',
        'https://user:pass@fcm.googleapis.com/fcm/send/x',
      ];
      for (const endpoint of endpoints) expect(await admin.status('POST', '/api/account/push/subscribe', { ...subscription(d), endpoint }), endpoint).toBe(400);
      expect(await subscriptionCount()).toBe(0);
    });

    it('accept only known push services', async () => {
      const d = await newDevice();
      expect(await admin.status('POST', '/api/account/push/subscribe', { ...subscription(d), endpoint: 'https://example.org/collect' })).toBe(400);
      for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-par02p.notify.windows.com']) {
        expect(await admin.status('POST', '/api/account/push/subscribe', subscription(await newDevice(host))), host).toBe(200);
      }
    });

    it('can only be removed by their owner', async () => {
      const bob = await member('Bob');
      const d = await subscribe(admin);
      await bob.client.post('/api/account/push/unsubscribe', { endpoint: d.endpoint });
      expect(await subscriptionCount()).toBe(1);
      await admin.post('/api/account/push/unsubscribe', { endpoint: d.endpoint });
      expect(await subscriptionCount()).toBe(0);
    });

    it('are deleted when the user is disabled', async () => {
      const bob = await member('Bob');
      await subscribe(bob.client);
      await admin.patch(`/api/admin/users/${bob.id}`, { status: 'disabled' });
      expect(await subscriptionCount(bob.id)).toBe(0);
    });

    it("send a test notification to the caller's devices only", async () => {
      const bob = await member('Bob');
      const mine = await subscribe(admin);
      const theirs = await subscribe(bob.client);
      await admin.post('/api/account/push/test', {});
      expect(await pushesTo(fake.state, mine)).toHaveLength(1);
      expect(await pushesTo(fake.state, theirs)).toHaveLength(0);
    });
  });

  it('audits turning push on and off, not the app re-sending its subscription', async () => {
    const d = await subscribe(admin);
    await subscribe(admin, d);
    await admin.post('/api/account/push/unsubscribe', { endpoint: d.endpoint });
    const actions = (await env.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'account.push_%' ORDER BY created_at").all<{ action: string }>()).results.map((r) => r.action);
    expect(actions).toEqual(['account.push_enabled', 'account.push_disabled']);
  });

  describe('inbound mail', () => {
    it('notifies every subscribed device of every member of the mailbox, and no one else', async () => {
      const bob = await member('Bob');
      const carol = await member('Carol');
      const team = await admin.post('/api/admin/mailboxes', {
        localPart: 'team',
        domainId,
        kind: 'shared',
        members: [{ userId: await userId('admin@example.com') }, { userId: bob.id }],
      });
      const adminPhone = await subscribe(admin);
      const adminLaptop = await subscribe(admin, await newDevice('updates.push.services.mozilla.com', '/wpush/v2/laptop'));
      const bobPhone = await subscribe(bob.client, await newDevice('web.push.apple.com', '/QGx-bob'));
      const carolPhone = await subscribe(carol.client);

      await deliver(email({ to: 'team@example.com', subject: 'Team update' }), { from: 'ann@sender.test', to: 'team@example.com' });
      expect(team.id).toBeTruthy();
      for (const d of [adminPhone, adminLaptop, bobPhone]) expect(await pushesTo(fake.state, d), d.endpoint).toHaveLength(1);
      expect(await pushesTo(fake.state, carolPhone)).toHaveLength(0);
    });

    it('links the push to the thread and tags it per thread', async () => {
      const d = await subscribe(admin);
      await deliver(email({ subject: 'Hello' }), { from: 'ann@sender.test', to: 'admin@example.com' });
      const { threads } = await admin.get('/api/threads?mailbox=all&view=inbox');
      const [p] = await pushesTo(fake.state, d);
      expect(p.url).toBe(`/mail/all/inbox/${threads[0].id}`);
      expect(p.tag).toBe(`thread-${threads[0].id}`);
    });

    it('carries no subject or body text by default', async () => {
      const d = await subscribe(admin);
      await deliver(email({ subject: 'Quarterly numbers', body: 'The secret figure is 4242.' }), { from: 'ann@sender.test', to: 'admin@example.com' });
      const [p] = await pushesTo(fake.state, d);
      const text = JSON.stringify(p);
      expect(text).not.toContain('Quarterly');
      expect(text).not.toContain('4242');
    });

    it('shows the sender and the subject to people who turned it on, and only to them', async () => {
      const bob = await member('Bob');
      await admin.post('/api/admin/mailboxes', {
        localPart: 'team',
        domainId,
        kind: 'shared',
        members: [{ userId: await userId('admin@example.com') }, { userId: bob.id }],
      });
      const adminPhone = await subscribe(admin);
      const bobPhone = await subscribe(bob.client);
      await bob.client.patch('/api/account', { preferences: { pushPreview: 'subject' } });
      await deliver(email({ to: 'team@example.com', subject: 'Quarterly numbers' }), { from: 'ann@sender.test', to: 'team@example.com' });
      expect(await pushesTo(fake.state, bobPhone)).toMatchObject([{ title: 'Ann Sender', body: 'Quarterly numbers' }]);
      const [plain] = await pushesTo(fake.state, adminPhone);
      expect(plain).toMatchObject({ title: 'New mail', body: 'From Ann Sender' });
      expect(JSON.stringify(plain)).not.toContain('Quarterly');
    });

    it('sends at normal urgency with one topic per conversation', async () => {
      const d = await subscribe(admin);
      await deliver(email({ subject: 'Hello' }), { from: 'ann@sender.test', to: 'admin@example.com' });
      const { threads } = await admin.get('/api/threads?mailbox=all&view=inbox');
      const [sent] = fake.state.push.received.filter((p) => p.endpoint === d.endpoint);
      const header = (name: string) => Object.entries(sent.headers).find(([k]) => k.toLowerCase() === name)?.[1];
      expect(header('urgency')).toBe('normal');
      expect(header('topic')).toBe(`thread-${threads[0].id}`);
    });

    it('does not notify disabled members', async () => {
      const bob = await member('Bob');
      const d = await subscribe(bob.client);
      // Skip the subscription cleanup on disable, if any, to test the send path on its own.
      await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(bob.id).run();
      await deliver(email({ to: 'bob@example.com' }), { from: 'ann@sender.test', to: 'bob@example.com' });
      expect(await pushesTo(fake.state, d)).toHaveLength(0);
    });

    it('stays quiet for spam, duplicates, rejected and imported mail, and mail filters archive or mark read', async () => {
      const d = await subscribe(admin);
      const [box] = await admin.get('/api/admin/mailboxes');
      await admin.post(`/api/mailboxes/${box.id}/filters`, { name: 'Archive receipts', conditions: { subject: 'receipt' }, actions: { folder: 'archive' } });
      await admin.post(`/api/mailboxes/${box.id}/filters`, { name: 'Read newsletters', conditions: { subject: 'newsletter' }, actions: { markRead: true } });

      await deliver(email({ subject: 'Spoofed', auth: 'dkim=none; dmarc=fail header.from=bank.test; spf=fail smtp.mailfrom=x@bank.test' }), { from: 'x@bank.test', to: 'admin@example.com' });
      expect((await deliver(email({}), { from: 'ann@sender.test', to: 'nobody@example.com' })).rejected).toBeTruthy();
      await deliver(email({ subject: 'Your receipt' }), { from: 'shop@store.test', to: 'admin@example.com' });
      await deliver(email({ subject: 'Weekly newsletter' }), { from: 'news@store.test', to: 'admin@example.com' });
      const imported = new TextEncoder().encode(email({ subject: 'Imported' }).replace(/\r?\n/g, '\r\n'));
      expect((await admin.request('POST', `/api/mailboxes/${box.id}/import?folder=inbox`, imported)).status).toBe(200);
      expect(await pushesTo(fake.state, d)).toHaveLength(0);

      const once = email({ subject: 'Only once', messageId: 'once@sender.test' });
      await deliver(once, { from: 'ann@sender.test', to: 'admin@example.com' });
      await deliver(once, { from: 'ann@sender.test', to: 'admin@example.com' });
      expect(await pushesTo(fake.state, d)).toHaveLength(1);
    });

    it('sends at most 20 pushes per message, to the most recently active devices', async () => {
      const devices: Device[] = [];
      for (let i = 0; i < 25; i++) devices.push(await subscribe(admin));
      const stale = devices.slice(0, 5);
      for (const d of stale) await env.DB.prepare('UPDATE push_subscriptions SET last_used_at = 1 WHERE endpoint = ?').bind(d.endpoint).run();

      await deliver(email({ subject: 'Busy inbox' }), { from: 'ann@sender.test', to: 'admin@example.com' });
      expect(fake.state.push.received).toHaveLength(MAX_PUSHES_PER_MESSAGE);
      for (const d of stale) expect(await pushesTo(fake.state, d), d.endpoint).toHaveLength(0);
    });

    it('drops subscriptions the push service reports gone, and never fails delivery', async () => {
      const gone = await subscribe(admin, await newDevice('fcm.googleapis.com', '/fcm/send/gone'));
      const missing = await subscribe(admin, await newDevice('fcm.googleapis.com', '/fcm/send/missing'));
      const broken = await subscribe(admin, await newDevice('fcm.googleapis.com', '/fcm/send/broken'));
      fake.state.push.status = { '/fcm/send/gone': 410, '/fcm/send/missing': 404, '/fcm/send/broken': 503 };

      expect((await deliver(email({ subject: 'Still delivered' }), { from: 'ann@sender.test', to: 'admin@example.com' })).rejected).toBeNull();
      expect((await admin.get('/api/threads?mailbox=all&view=inbox')).threads).toHaveLength(1);
      const left = await env.DB.prepare('SELECT endpoint FROM push_subscriptions').all<{ endpoint: string }>();
      expect(left.results.map((r) => r.endpoint)).toEqual([broken.endpoint]);
      expect([gone, missing].every((d) => fake.state.push.received.some((p) => p.endpoint === d.endpoint))).toBe(true);
    });
  });
});
