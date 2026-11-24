// Forwarding: the message stays in OpenInbox and Cloudflare forwards a copy to each verified
// address the mailbox (or a filter) picked.
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('rejects addresses an admin has not added', async () => {
    expect(await admin.status('PATCH', `/api/mailboxes/${boxId}/settings`, { forwardTo: ['someone@else.test'] })).toBe(400);
  });
});
