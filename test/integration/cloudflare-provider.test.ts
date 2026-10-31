import { beforeEach, describe, expect, it } from 'vitest';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, setupInstance } from '../helpers/client';

describe('Cloudflare Email Sending provider', () => {
  let admin: Client;
  let fake: ReturnType<typeof useFakeApis>;
  let domainId: number;

  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    ({ domainId } = await setupInstance(admin));
  });

  it('connects with the stored Cloudflare token and sends through the API', async () => {
    const connected = await admin.post('/api/admin/providers', { type: 'cloudflare', config: {} });
    expect(connected.id).toBeGreaterThan(0);
    // No domain API, so connecting does not try to register domains.
    expect(connected.domains).toEqual([]);

    const boxes = await admin.get('/api/mailboxes');
    const draft = await admin.post('/api/drafts', {
      mailboxId: boxes[0].id,
      from: 'admin@example.com',
      to: [{ name: 'Ann', address: 'ann@dest.test' }],
      subject: 'Sent through Cloudflare',
      html: '<p>Hello</p>',
    });
    expect((await admin.post(`/api/drafts/${draft.id}/send`, {})).status).toBe('sent');

    const out = fake.state.cfSending.emails[0] as {
      from: { address: string; name?: string };
      to: { address: string; name?: string }[];
      subject: string;
      headers?: Record<string, string>;
    };
    expect(out.from.address).toBe('admin@example.com');
    expect(out.to).toEqual([{ address: 'ann@dest.test', name: 'Ann' }]);
    expect(out.subject).toBe('Sent through Cloudflare');
    // Cloudflare generates Message-ID and rejects it in headers; threading rides on References.
    expect(out.headers?.['Message-ID']).toBeUndefined();

    // The reply to a message sent this way still threads, through the References we appended.
    const threads = (await admin.get('/api/threads?mailbox=all&view=sent')).threads;
    expect(threads).toHaveLength(1);
    const sent = await admin.get(`/api/threads/${threads[0].id}`);
    const ownId = sent.messages[0].messageId as string;
    await deliver(email({ subject: 'Re: Sent through Cloudflare', messageId: 'r1@dest.test', inReplyTo: ownId, references: `<${ownId}>` }), {
      from: 'ann@dest.test',
      to: 'admin@example.com',
    });
    const after = await admin.get(`/api/threads/${threads[0].id}`);
    expect(after.messages.map((m: { direction: string }) => m.direction)).toEqual(['out', 'in']);
  });

  it('counts as sending for the domain without a per-domain verified row', async () => {
    await admin.post('/api/admin/providers', { type: 'cloudflare', config: {} });
    const health = await admin.post(`/api/admin/domains/${domainId}/check`, {});
    const sending = health.items.find((i: { key: string }) => i.key === 'provider');
    expect(sending).toMatchObject({ status: 'ok' });
    expect(sending.detail).toMatch(/Cloudflare/);
  });

  it('says the account needs Workers Paid instead of a bare Cloudflare error', async () => {
    fake.state.cfSending.entitled = false;
    const res = await admin.request('POST', '/api/admin/providers', { type: 'cloudflare', config: {} });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toMatch(/Workers Paid/);
    expect(await admin.get('/api/admin/providers')).toHaveLength(0);
  });

  it('marks a Cloudflare failure for retry, then sends it', async () => {
    await admin.post('/api/admin/providers', { type: 'cloudflare', config: {} });
    const boxes = await admin.get('/api/mailboxes');
    const draft = await admin.post('/api/drafts', { mailboxId: boxes[0].id, from: 'admin@example.com', to: [{ name: '', address: 'x@dest.test' }], subject: 'Retry me', html: '<p>Hi</p>' });

    fake.state.cfSending.failNext = 1;
    expect((await admin.post(`/api/drafts/${draft.id}/send`, {})).status).toBe('failed');
    expect(fake.state.cfSending.emails).toHaveLength(0);

    expect((await admin.post(`/api/messages/${draft.id}/retry`, {})).status).toBe('sent');
    expect(fake.state.cfSending.emails).toHaveLength(1);
  });
});
