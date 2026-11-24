// Domains in another Cloudflare account than OpenInbox's Worker: Email Routing hands their mail only
// to a Worker in that account, so OpenInbox installs a relay Worker there and mail reaches it
// through the relay.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import relayWorker, { type RelayEnv } from '../../src/worker/cloudflare/relay-worker.js';
import relaySource from '../../src/worker/cloudflare/relay-worker.js?raw';
import { useFakeApis } from '../helpers/fake';
import { Client, ENCRYPTION_KEY, email, ORIGIN, setupInstance } from '../helpers/client';
import type { FakeState } from '../mock/fake-apis';

const SHOP_ZONE = 'zone_shopping';

describe('domains in another Cloudflare account', () => {
  let fake: { state: FakeState };
  let admin: Client;

  beforeEach(async () => {
    fake = useFakeApis();
    // The relay reaches OpenInbox over HTTPS: send its requests to the Worker.
    const fakes = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (!req.url.startsWith(ORIGIN)) return fakes(input, init);
      const ctx = createExecutionContext();
      const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    });
    fake.state.accounts.push({ id: 'acc_shop', name: 'Shop Account' });
    fake.state.zones.push({ id: SHOP_ZONE, name: 'shop.test', status: 'active', account: 'acc_shop' });
    admin = new Client();
    await setupInstance(admin);
  });

  const addShop = async () => {
    const { id } = await admin.post('/api/admin/domains', { zoneId: SHOP_ZONE });
    let r;
    for (let i = 0; i < 6; i++) {
      r = await admin.post(`/api/admin/domains/${id}/setup`);
      if (r.done) break;
    }
    return { id: id as number, setup: r };
  };

  // sales@shop.test, shared with the admin so it shows in their mail.
  const addSales = async (domainId: number): Promise<number> => {
    const me = (await admin.get('/api/auth/session')).user;
    return (await admin.post('/api/admin/mailboxes', { localPart: 'sales', domainId, members: [{ userId: me.id }] })).id;
  };

  // What OpenInbox gave the relay it installed, including the secret.
  const relayBindings = (account = 'acc_shop'): RelayEnv =>
    Object.fromEntries(fake.state.uploads[`${account}/openinbox-relay`].metadata.bindings.map((b) => [b.name, b.text])) as unknown as RelayEnv;

  // What Email Routing does with mail for a domain in that account: hand it to the relay.
  async function viaRelay(raw: string, envelope: { from: string; to: string }, bindings = relayBindings()) {
    const bytes = new TextEncoder().encode(raw.replace(/\r?\n/g, '\r\n'));
    const result = { rejected: null as string | null, forwarded: [] as string[] };
    const message = {
      ...envelope,
      raw: new Response(bytes).body,
      rawSize: bytes.byteLength,
      headers: new Headers(),
      setReject(reason: string) {
        result.rejected = reason;
      },
      async forward(to: string) {
        result.forwarded.push(to);
      },
      async reply() {},
    } as unknown as ForwardableEmailMessage;
    await relayWorker.email(message, bindings);
    return result;
  }

  const inbox = async () => (await admin.get('/api/threads?mailbox=all&view=inbox')).threads.map((t: { subject: string }) => t.subject);

  it('lists the zone with its account, installs a relay there and receives mail through it', async () => {
    const zones = await admin.get('/api/admin/zones');
    expect(zones.find((z: { name: string }) => z.name === 'shop.test')).toMatchObject({ account: 'Shop Account', connected: false, usable: true });
    expect(zones.find((z: { name: string }) => z.name === 'example.com').account).toBeNull();
    expect(await admin.get(`/api/admin/zones/${SHOP_ZONE}`)).toMatchObject({ relayed: true, account: { id: 'acc_shop', name: 'Shop Account' }, mxState: 'none' });

    const { id, setup } = await addShop();
    expect(setup.done).toBe(true);
    expect(setup.steps.map((s: { id: string }) => s.id)).toEqual(['routing', 'relay', 'catchall', 'dmarc', 'verify']);
    // The relay is uploaded as it is, with OpenInbox's address and its own secret.
    const upload = fake.state.uploads['acc_shop/openinbox-relay'];
    expect(upload.source).toBe(relaySource);
    expect(relayBindings()).toMatchObject({ OPENINBOX_URL: ORIGIN, ACCOUNT_ID: 'acc_shop', RELAY_SECRET: expect.stringMatching(/^[\w-]{40,}$/) });
    expect(upload.metadata.bindings.find((b) => b.name === 'RELAY_SECRET')!.type).toBe('secret_text');
    expect(fake.state.catchAll[SHOP_ZONE].actions).toEqual([{ type: 'worker', value: ['openinbox-relay'] }]);
    expect(fake.state.catchAll.zone_example.actions).toEqual([{ type: 'worker', value: ['openinbox'] }]);
    // Domains in OpenInbox's own account have no relay step.
    const domains = await admin.get('/api/admin/domains');
    expect(domains.map((d: { name: string; relayed: boolean }) => [d.name, d.relayed])).toEqual([
      ['example.com', false],
      ['shop.test', true],
    ]);
    expect(domains[0].setup.steps.map((s: { id: string }) => s.id)).toEqual(['routing', 'catchall', 'dmarc', 'verify']);

    await addSales(id);
    expect(await viaRelay(email({ to: 'sales@shop.test', subject: 'Order 42' }), { from: 'ann@sender.test', to: 'sales@shop.test' })).toEqual({ rejected: null, forwarded: [] });
    expect(await inbox()).toContain('Order 42');
    expect((await viaRelay(email({ to: 'nobody@shop.test' }), { from: 'ann@sender.test', to: 'nobody@shop.test' })).rejected).toBe('550 5.1.1 Unknown recipient.');

    const health = await admin.post(`/api/admin/domains/${id}/check`);
    const item = (key: string) => health.items.find((i: { key: string }) => i.key === key);
    expect(item('catchall')).toMatchObject({ status: 'ok', detail: 'Routes to the openinbox-relay Worker.' });
    expect(item('relay')).toMatchObject({ status: 'ok', detail: `Passes mail to ${ORIGIN}.` });
  });

  it('passes forwarding back to the relay, which forwards from its own account', async () => {
    const { id } = await addShop();
    const boxId = await addSales(id);
    await env.DB.prepare('INSERT INTO forward_destinations (address, verified_at, created_at) VALUES (?, ?, ?)').bind('me@gmail.test', Date.now(), Date.now()).run();
    await env.DB.prepare('UPDATE mailboxes SET forward_to = ? WHERE id = ?').bind(JSON.stringify(['me@gmail.test']), boxId).run();
    expect(await viaRelay(email({ to: 'sales@shop.test', subject: 'Forward me' }), { from: 'ann@sender.test', to: 'sales@shop.test' })).toEqual({
      rejected: null,
      forwarded: ['me@gmail.test'],
    });
    expect(await inbox()).toContain('Forward me');
  });

  it('accepts mail only from its own relays, and only for their own account', async () => {
    await addShop();
    // A wrong secret: the relay gets no answer and throws, so the sender retries later.
    await expect(viaRelay(email({ to: 'sales@shop.test' }), { from: 'ann@sender.test', to: 'sales@shop.test' }, { ...relayBindings(), RELAY_SECRET: 'not-the-secret' })).rejects.toThrow(/401/);
    // The shop relay can't deliver to a domain in OpenInbox's own account.
    const r = await viaRelay(email({ to: 'admin@example.com', subject: 'Sneaky' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    expect(r.rejected).toBe('550 5.1.1 Unknown recipient.');
    expect(await inbox()).not.toContain('Sneaky');
    // No secret at all.
    expect(await new Client().status('POST', '/api/relay/acc_shop', new TextEncoder().encode('Subject: x\r\n\r\nx'))).toBe(401);
  });

  it('moves the relay with the app address, repairs it, and removes it with the last domain of its account', async () => {
    const { id } = await addShop();
    // Changing the app's address updates the relay at once.
    await admin.patch('/api/admin/settings', { appUrl: 'https://mail.example.com/' });
    expect(relayBindings().OPENINBOX_URL).toBe('https://mail.example.com');
    const check = async () => (await admin.post(`/api/admin/domains/${id}/check`)).items.find((i: { key: string }) => i.key === 'relay');
    expect(await check()).toMatchObject({ status: 'ok', detail: 'Passes mail to https://mail.example.com.' });

    // A relay changed or removed by hand shows in the checks, and Repair puts it back.
    fake.state.uploads['acc_shop/openinbox-relay'].metadata.bindings.find((b) => b.name === 'OPENINBOX_URL')!.text = 'https://old.example.com';
    expect(await check()).toMatchObject({ status: 'warn' });
    delete fake.state.uploads['acc_shop/openinbox-relay'];
    expect(await check()).toMatchObject({ status: 'error' });
    const repaired = await admin.post(`/api/admin/domains/${id}/repair`);
    expect(repaired.done).toBe(true);
    expect(relayBindings().OPENINBOX_URL).toBe('https://mail.example.com');
    expect(repaired.health.items.find((i: { key: string }) => i.key === 'relay')).toMatchObject({ status: 'ok' });

    // mail.<domain> can only open the app for a domain in the Worker's own account.
    expect(await admin.status('POST', `/api/admin/domains/${id}/app-domain`, { subdomain: 'mail' })).toBe(400);

    await admin.del(`/api/admin/domains/${id}`);
    expect(fake.state.uploads['acc_shop/openinbox-relay']).toBeUndefined();
    expect(fake.state.catchAll[SHOP_ZONE].enabled).toBe(false);
  });
});

describe('first-run setup', () => {
  it("starts with a domain in the Worker's own account", async () => {
    const fake = useFakeApis();
    fake.state.accounts.push({ id: 'acc_shop', name: 'Shop Account' });
    fake.state.zones.push({ id: SHOP_ZONE, name: 'shop.test', status: 'active', account: 'acc_shop' });
    const c = new Client();
    await c.init();
    const status = await c.get('/api/setup/status');
    expect(status.zones.map((z: { name: string }) => z.name)).toEqual(['example.com', 'workspace.dev']);
    const claim = { zoneId: SHOP_ZONE, localPart: 'admin', displayName: 'Admin', password: 'correct horse battery', setupKey: ENCRYPTION_KEY };
    const res = await c.request('POST', '/api/setup/claim', claim);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { message: string } }>()).error.message).toMatch(/another Cloudflare account/);
  });
});
