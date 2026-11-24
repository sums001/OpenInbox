// Automatic domains: after setup, every zone the token reaches, in any account, is added and set up
// without anyone picking it, keeping the mail a zone already received and leaving alone the zones
// whose mail goes elsewhere.
import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { useFakeApis } from '../helpers/fake';
import { Client, setupInstance } from '../helpers/client';
import type { FakeState } from '../mock/fake-apis';

// The minute cron, as Cloudflare runs it at that minute of the hour.
async function cron(minute: number) {
  const at = new Date();
  at.setUTCMinutes(minute, 0, 0);
  const ctx = createExecutionContext();
  await worker.scheduled!({ cron: '* * * * *', scheduledTime: at.getTime(), noRetry() {} } as ScheduledController, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe('automatic domains', () => {
  let fake: { state: FakeState };
  let admin: Client;

  beforeEach(async () => {
    fake = useFakeApis();
    fake.state.accounts.push({ id: 'acc_shop', name: 'Shop Account' }, { id: 'acc_empty', name: 'Empty Account' });
    fake.state.zones.push(
      { id: 'zone_shopping', name: 'shop.test', status: 'active', account: 'acc_shop' },
      { id: 'zone_forwarded', name: 'forwarded.test', status: 'active' },
      { id: 'zone_waiting', name: 'waiting.test', status: 'pending' },
    );
    // forwarded.test sends all its mail to Gmail today.
    fake.state.catchAll.zone_forwarded = { id: 'catch_all', name: '', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['me@gmail.test'] }] };
    admin = new Client();
    await setupInstance(admin);
  });

  const domains = async () => (await admin.get('/api/admin/domains')) as { id: number; name: string; status: string; relayed: boolean; catchAllMailboxId: number | null; setup: { done: boolean } }[];

  it('adds every zone the token reaches and sets them up, keeping mail that went somewhere before', async () => {
    const r = await admin.post('/api/admin/domains/auto');
    expect(r.added.map((a: { name: string; relayed: boolean }) => [a.name, a.relayed]).sort()).toEqual([
      ['forwarded.test', false],
      ['shop.test', true],
    ]);
    // workspace.dev's mail goes to Google: taking it over would cut that off. waiting.test isn't active.
    expect(r.skipped.map((s: { name: string; reason: string }) => [s.name, s.reason])).toEqual([['workspace.dev', 'mx_elsewhere']]);
    expect(r.remaining).toBe(0);
    // Asking again adds nothing more, and keeps the list of what was left out.
    expect((await admin.post('/api/admin/domains/auto')).added).toEqual([]);
    expect((await admin.get('/api/admin/domains/auto')).skipped.map((s: { name: string }) => s.name)).toEqual(['workspace.dev']);

    // The cron finishes their setup a few steps a minute, skipping its busy minutes.
    for (let m = 1; m < 12 && (await domains()).some((d) => !d.setup.done); m++) await cron(m);
    const all = await domains();
    expect(all.every((d) => d.status === 'active' && d.setup.done)).toBe(true);
    expect(fake.state.catchAll.zone_shopping.actions).toEqual([{ type: 'worker', value: ['openinbox-relay'] }]);
    expect(fake.state.uploads['acc_shop/openinbox-relay']).toBeDefined();
    expect(fake.state.catchAll.zone_forwarded.actions).toEqual([{ type: 'worker', value: ['openinbox'] }]);

    // forwarded.test's mail to any address keeps arriving, now in the owner's mailbox; shop.test
    // and example.com had no catch-all, so they still have none.
    const owner = (await admin.get('/api/admin/mailboxes'))[0].id;
    expect(Object.fromEntries(all.map((d) => [d.name, d.catchAllMailboxId]))).toEqual({ 'example.com': null, 'forwarded.test': owner, 'shop.test': null });
  });

  it('checks for new zones every hour, when turned on, and never brings back a removed domain', async () => {
    await cron(33);
    expect((await domains()).map((d) => d.name).sort()).toEqual(['example.com', 'forwarded.test', 'shop.test']);
    const forwarded = (await domains()).find((d) => d.name === 'forwarded.test')!;
    await admin.del(`/api/admin/domains/${forwarded.id}`);
    fake.state.zones.push({ id: 'zone_later', name: 'later.test', status: 'active' });

    await admin.patch('/api/admin/settings', { autoDomains: 'off' });
    await cron(33);
    expect((await domains()).map((d) => d.name).sort()).toEqual(['example.com', 'shop.test']);

    await admin.patch('/api/admin/settings', { autoDomains: 'on' });
    await cron(33);
    expect((await domains()).map((d) => d.name).sort()).toEqual(['example.com', 'later.test', 'shop.test']);
    expect((await admin.get('/api/admin/domains/auto')).skipped.map((s: { name: string; reason: string }) => [s.name, s.reason])).toEqual([
      ['workspace.dev', 'mx_elsewhere'],
      ['forwarded.test', 'removed'],
    ]);
  });

  it('shows every account the token reaches', async () => {
    fake.state.denied.push(/^\/accounts\/acc_shop\/workers\/scripts$/);
    const cf = await admin.get('/api/admin/cloudflare');
    expect(cf.accounts).toEqual([
      { id: 'acc_test', name: 'Test Account', worker: true, zones: 4, connected: 1, relay: null },
      { id: 'acc_shop', name: 'Shop Account', worker: false, zones: 1, connected: 0, relay: 'no_access' },
      { id: 'acc_empty', name: 'Empty Account', worker: false, zones: 0, connected: 0, relay: null },
    ]);
  });
});
