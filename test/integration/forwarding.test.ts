// Forwarding: the message stays in OpenInbox and Cloudflare forwards a copy to each verified
// address the mailbox (or a filter) picked.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, setupInstance } from '../helpers/client';
import type { FakeState } from '../mock/fake-apis';

describe('forwarding', () => {
  let fake: { state: FakeState };
  let admin: Client;
  let boxId: number;

  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    await setupInstance(admin);
    boxId = (await admin.get('/api/admin/mailboxes'))[0].id;
  });

  // What the owner does by clicking the link in Cloudflare's verification email.
  const clickVerificationLink = (address: string) => {
    fake.state.destinations.find((d) => d.email === address)!.verified = new Date().toISOString();
  };
  const inbox = async () => (await admin.get('/api/threads?mailbox=all&view=inbox')).threads.map((t: { subject: string }) => t.subject).sort();
  const send = (subject: string, auth?: string) => deliver(email({ subject, auth }), { from: 'ann@sender.test', to: 'admin@example.com' });

  it('keeps a copy and forwards to the verified addresses the mailbox picked', async () => {
    await admin.post('/api/admin/forwarding', { email: 'Me@Gmail.test' });
    expect(fake.state.destinations.map((d) => d.email)).toEqual(['me@gmail.test']);
    expect(await admin.get('/api/admin/forwarding')).toEqual([{ address: 'me@gmail.test', verified: false }]);
    expect((await admin.get(`/api/mailboxes/${boxId}/settings`)).destinations).toEqual([{ address: 'me@gmail.test', verified: false }]);

    // Picked before the link was clicked: Cloudflare would refuse, so nothing is forwarded.
    await admin.patch(`/api/mailboxes/${boxId}/settings`, { forwardTo: ['me@gmail.test'] });
    expect((await send('Before verifying')).forwarded).toEqual([]);

    // Mail settings sees the click without anyone opening the admin page.
    clickVerificationLink('me@gmail.test');
    expect((await admin.get(`/api/mailboxes/${boxId}/settings`)).destinations).toEqual([{ address: 'me@gmail.test', verified: true }]);
    expect((await send('After verifying')).forwarded).toEqual(['me@gmail.test']);
    expect(await inbox()).toEqual(['After verifying', 'Before verifying']);

    // Spam stays here.
    expect((await send('Spoofed', 'dkim=none; dmarc=fail header.from=bank.test; spf=fail smtp.mailfrom=x@bank.test')).forwarded).toEqual([]);

    // A removed address is no longer forwarded to, even though the mailbox still lists it.
    await admin.del(`/api/admin/forwarding/${encodeURIComponent('me@gmail.test')}`);
    expect(fake.state.destinations).toEqual([]);
    expect((await send('After removing')).forwarded).toEqual([]);
    expect(await inbox()).toEqual(['After removing', 'After verifying', 'Before verifying']);
  });

  it('forwards matching mail from a filter, once per address', async () => {
    await admin.post('/api/admin/forwarding', { email: 'me@gmail.test' });
    await admin.post('/api/admin/forwarding', { email: 'books@accounting.test' });
    clickVerificationLink('me@gmail.test');
    clickVerificationLink('books@accounting.test');
    expect(await admin.get('/api/admin/forwarding')).toEqual([
      { address: 'books@accounting.test', verified: true },
      { address: 'me@gmail.test', verified: true },
    ]);
    await admin.patch(`/api/mailboxes/${boxId}/settings`, { forwardTo: ['me@gmail.test'] });
    await admin.post(`/api/mailboxes/${boxId}/filters`, { name: 'Invoices', conditions: { subject: 'invoice' }, actions: { forwardTo: 'Books@Accounting.test' } });
    await admin.post(`/api/mailboxes/${boxId}/filters`, { name: 'Receipts', conditions: { subject: 'receipt' }, actions: { forwardTo: 'ME@gmail.test' } });

    expect((await send('Invoice 7')).forwarded.sort()).toEqual(['books@accounting.test', 'me@gmail.test']);
    expect((await send('Receipt 3')).forwarded).toEqual(['me@gmail.test']);
    expect((await send('Lunch?')).forwarded).toEqual(['me@gmail.test']);
  });

  it('lists the addresses already verified in Cloudflare', async () => {
    fake.state.destinations.push({ id: 'dest_old', email: 'Old@Gmail.test', verified: '2026-01-02T03:04:05Z' }, { id: 'dest_new', email: 'new@gmail.test', verified: null });
    expect(await admin.get('/api/admin/forwarding')).toEqual([
      { address: 'new@gmail.test', verified: false },
      { address: 'old@gmail.test', verified: true },
    ]);
    // A mailbox can forward to the verified one straight away.
    await admin.patch(`/api/mailboxes/${boxId}/settings`, { forwardTo: ['old@gmail.test'] });
    expect((await send('Hello')).forwarded).toEqual(['old@gmail.test']);
  });

  it('moves a Cloudflare forwarding rule into OpenInbox, keeping the forward', async () => {
    fake.state.destinations.push({ id: 'dest_alice', email: 'alice@gmail.test', verified: '2026-01-02T03:04:05Z' });
    fake.state.rules.zone_example = [
      { id: 'rule_alice', name: '', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'Alice@example.com' }], actions: [{ type: 'forward', value: ['alice@gmail.test'] }] },
      { id: 'rule_drop', name: '', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'noise@example.com' }], actions: [{ type: 'drop' }] },
    ];
    expect(await admin.get('/api/admin/forwarding/rules')).toEqual([
      { domainId: expect.any(Number), domain: 'example.com', ruleId: 'rule_alice', address: 'alice@example.com', to: ['alice@gmail.test'], enabled: true, inOpenInbox: false },
    ]);
    const { domainId } = (await admin.get('/api/admin/forwarding/rules'))[0];

    // Off and on again, in Cloudflare.
    await admin.post('/api/admin/forwarding/rules/toggle', { domainId, ruleId: 'rule_alice', enabled: false });
    expect(fake.state.rules.zone_example[0].enabled).toBe(false);
    await admin.post('/api/admin/forwarding/rules/toggle', { domainId, ruleId: 'rule_alice', enabled: true });
    expect(fake.state.rules.zone_example[0].enabled).toBe(true);

    const moved = await admin.post('/api/admin/forwarding/rules/move', { domainId, ruleId: 'rule_alice' });
    expect(moved).toMatchObject({ address: 'alice@example.com', to: ['alice@gmail.test'] });
    expect(fake.state.rules.zone_example[0].enabled).toBe(false);
    expect((await admin.get('/api/admin/forwarding/rules'))[0]).toMatchObject({ enabled: false, inOpenInbox: true });

    // Mail to alice@ now arrives in a mailbox for her, which forwards as Cloudflare did.
    const r = await deliver(email({ subject: 'For Alice', to: 'alice@example.com' }), { from: 'ann@sender.test', to: 'alice@example.com' });
    expect(r).toEqual({ rejected: null, forwarded: ['alice@gmail.test'] });
    const stored = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ?').bind(moved.mailboxId).first<{ n: number }>();
    expect(stored?.n).toBe(1);
  });

  it('rejects addresses an admin has not added', async () => {
    expect(await admin.status('PATCH', `/api/mailboxes/${boxId}/settings`, { forwardTo: ['someone@else.test'] })).toBe(400);
  });
});
