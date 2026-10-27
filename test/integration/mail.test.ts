import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, setupInstance } from '../helpers/client';
import { hmacSha256, toBase64Url } from '../../src/worker/lib/crypto';

async function connectResend(c: Client) {
  return c.post('/api/admin/providers', { type: 'resend', config: { apiKey: 're_test_key_123' } });
}

describe('inbound mail', () => {
  let admin: Client;
  beforeEach(async () => {
    useFakeApis();
    admin = new Client();
    await setupInstance(admin);
  });

  it('delivers, threads, dedupes and rejects unknown recipients', async () => {
    const first = await deliver(email({ subject: 'Invoice October', messageId: 'inv1@sender.test', body: 'Your invoice total is 120 EUR.' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    expect(first.rejected).toBeNull();
    const reply = email({ subject: 'Re: Invoice October', messageId: 'inv2@sender.test', inReplyTo: 'inv1@sender.test', references: '<inv1@sender.test>' });
    await deliver(reply, { from: 'ann@sender.test', to: 'admin@example.com' });
    // The same message again (e.g. delivered to an alias too) is stored once.
    await deliver(reply, { from: 'ann@sender.test', to: 'admin@example.com' });
    const unknown = await deliver(email({}), { from: 'ann@sender.test', to: 'nobody@example.com' });
    expect(unknown.rejected).toMatch(/Unknown recipient/);

    const { threads } = await admin.get('/api/threads?mailbox=all&view=inbox');
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ subject: 'Invoice October', messageCount: 2, unreadCount: 2 });

    const detail = await admin.get(`/api/threads/${threads[0].id}`);
    expect(detail.messages.map((m: { text: string }) => m.text)[0]).toContain('120 EUR');
    expect(detail.messages[0].auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });

    const found = await admin.get('/api/search?q=invoice');
    expect(found.threads).toHaveLength(1);
    expect((await admin.get('/api/search?q=from:ann')).threads).toHaveLength(1);
    expect((await admin.get('/api/search?q=nonexistentword')).threads).toHaveLength(0);

    await admin.post('/api/threads/actions', { threadIds: [threads[0].id], action: 'read' });
    await admin.post('/api/threads/actions', { threadIds: [threads[0].id], action: 'archive' });
    expect((await admin.get('/api/threads?mailbox=all&view=inbox')).threads).toHaveLength(0);
    expect((await admin.get('/api/threads?mailbox=all&view=archive')).threads[0].unreadCount).toBe(0);

    const log = await admin.get('/api/admin/mailflow');
    expect(log.map((l: { status: string }) => l.status).sort()).toEqual(['delivered', 'delivered', 'duplicate', 'rejected']);
  });

  it('lists inbox and archived mail under All mail, but not Spam or Trash', async () => {
    for (const [i, subject] of ['Kept in inbox', 'Archived', 'Spammy', 'Trashed'].entries()) {
      await deliver(email({ subject, messageId: `all${i}@sender.test` }), { from: `s${i}@sender.test`, to: 'admin@example.com' });
    }
    const { threads } = await admin.get('/api/threads?mailbox=all&view=inbox');
    const id = (subject: string) => threads.find((t: { subject: string }) => t.subject === subject).id;
    await admin.post('/api/threads/actions', { threadIds: [id('Archived')], action: 'archive' });
    await admin.post('/api/threads/actions', { threadIds: [id('Spammy')], action: 'spam' });
    await admin.post('/api/threads/actions', { threadIds: [id('Trashed')], action: 'trash' });

    const all = await admin.get('/api/threads?mailbox=all&view=allmail');
    expect(all.threads.map((t: { subject: string }) => t.subject).sort()).toEqual(['Archived', 'Kept in inbox']);
  });

  it('routes aliases, plus addresses and the catch-all, and applies spam rules and filters', async () => {
    const boxes = await admin.get('/api/admin/mailboxes');
    const adminBox = boxes[0];
    await admin.post(`/api/admin/mailboxes/${adminBox.id}/aliases`, { localPart: 'billing', domainId: adminBox.domainId });
    await deliver(email({ to: 'billing@example.com', subject: 'Via alias' }), { from: 'ann@sender.test', to: 'billing@example.com' });
    await deliver(email({ subject: 'Via plus' }), { from: 'ann@sender.test', to: 'admin+news@example.com' });
    expect((await deliver(email({}), { from: 'ann@sender.test', to: 'random@example.com' })).rejected).toBeTruthy();
    await admin.patch(`/api/admin/domains/${adminBox.domainId}`, { catchAllMailboxId: adminBox.id });
    expect((await deliver(email({ subject: 'Via catch-all' }), { from: 'ann@sender.test', to: 'random@example.com' })).rejected).toBeNull();

    await deliver(email({ subject: 'Spoofed', auth: 'dkim=none; dmarc=fail header.from=bank.test; spf=fail smtp.mailfrom=x@bank.test' }), { from: 'x@bank.test', to: 'admin@example.com' });
    const spam = await admin.get('/api/threads?mailbox=all&view=spam');
    expect(spam.threads.map((t: { subject: string }) => t.subject)).toEqual(['Spoofed']);

    const label = await admin.post(`/api/mailboxes/${adminBox.id}/labels`, { name: 'Receipts', color: 'green' });
    await admin.post(`/api/mailboxes/${adminBox.id}/filters`, {
      name: 'Receipts',
      conditions: { subject: 'receipt' },
      actions: { labelIds: [label.id], folder: 'archive', markRead: true },
    });
    await deliver(email({ subject: 'Your receipt #42' }), { from: 'shop@store.test', to: 'admin@example.com' });
    const archived = await admin.get('/api/threads?mailbox=all&view=archive');
    expect(archived.threads[0]).toMatchObject({ subject: 'Your receipt #42', unreadCount: 0, labels: [label.id] });
    expect((await admin.get(`/api/threads?mailbox=all&view=label&label=${label.id}`)).threads).toHaveLength(1);

    const inbox = await admin.get('/api/threads?mailbox=all&view=inbox');
    expect(inbox.threads.map((t: { subject: string }) => t.subject).sort()).toEqual(['Via alias', 'Via catch-all', 'Via plus']);
  });

  it('keeps members out of mailboxes and admin pages they lack access to', async () => {
    const boxes = await admin.get('/api/admin/mailboxes');
    const created = await admin.post('/api/admin/users', { name: 'Bob', role: 'member', newMailbox: { localPart: 'bob', domainId: boxes[0].domainId } });
    expect(created.email).toBe('bob@example.com');
    await deliver(email({ subject: 'For admin only' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    await deliver(email({ subject: 'For Bob' }), { from: 'ann@sender.test', to: 'bob@example.com' });
    const adminThread = (await admin.get('/api/threads?mailbox=all&view=inbox')).threads.find((t: { subject: string }) => t.subject === 'For admin only');

    const bob = new Client();
    await bob.init();
    await bob.post('/api/auth/login', { email: 'bob@example.com', password: created.password });
    // A generated password must be changed first.
    expect(await bob.status('GET', '/api/threads')).toBe(403);
    await bob.post('/api/account/password', { next: 'bobs new password 1' });
    const bobInbox = await bob.get('/api/threads?mailbox=all&view=inbox');
    expect(bobInbox.threads.map((t: { subject: string }) => t.subject)).toEqual(['For Bob']);
    expect(await bob.status('GET', `/api/threads/${adminThread.id}`)).toBe(404);
    expect(await bob.status('POST', '/api/threads/actions', { threadIds: [adminThread.id], action: 'trash' })).toBe(200);
    expect((await admin.get(`/api/threads/${adminThread.id}`)).thread.folder).toBe('inbox');
    expect(await bob.status('GET', '/api/admin/overview')).toBe(403);
    expect(await bob.status('GET', `/api/threads?mailbox=${boxes[0].id}`)).toBe(404);
  });
});

describe('sending', () => {
  let fake: ReturnType<typeof useFakeApis>;
  let admin: Client;
  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    await setupInstance(admin);
  });

  it('connects Resend, writes DNS, verifies and replies with threading headers', async () => {
    const r = await connectResend(admin);
    expect(r.domains[0].status).toBe('verified');
    const recs = fake.state.dns.zone_example;
    expect(recs.some((x) => x.type === 'MX' && x.name === 'send.example.com')).toBe(true);
    expect(recs.filter((x) => x.type === 'TXT' && x.name === 'send.example.com')).toHaveLength(1);
    expect(recs.some((x) => x.name === 'resend._domainkey.example.com')).toBe(true);

    await deliver(email({ subject: 'Question', messageId: 'q1@sender.test' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    const thread = (await admin.get('/api/threads?mailbox=all&view=inbox')).threads[0];
    const detail = await admin.get(`/api/threads/${thread.id}`);
    const boxes = await admin.get('/api/mailboxes');
    const draft = await admin.post('/api/drafts', {
      mailboxId: boxes[0].id,
      from: 'admin@example.com',
      to: [{ name: 'Ann', address: 'ann@sender.test' }],
      subject: 'Re: Question',
      html: '<p>Here is the answer.</p>',
      replyToMessageId: detail.messages[0].id,
    });
    expect(draft.threadId).toBe(thread.id);
    expect((await admin.get('/api/threads?mailbox=all&view=drafts')).threads).toHaveLength(1);
    const sent = await admin.post(`/api/drafts/${draft.id}/send`, {});
    expect(sent.status).toBe('sent');

    const out = fake.state.resend.emails[0] as { headers: Record<string, string>; from: string; text: string };
    expect(out.from).toBe('Admin Person <admin@example.com>');
    expect(out.headers['In-Reply-To']).toBe('<q1@sender.test>');
    const refs = out.headers.References.split(' ');
    expect(refs[0]).toBe('<q1@sender.test>');
    expect(refs[refs.length - 1]).toBe(out.headers['Message-ID']);
    expect(out.text).toBe('Here is the answer.');

    // Resend/SES replaces our Message-ID; the reply still threads through References.
    await deliver(
      email({ subject: 'Re: Question', messageId: 'q2@sender.test', inReplyTo: '0102-ses-id@amazonses.com', references: `<q1@sender.test> ${out.headers['Message-ID']} <0102-ses-id@amazonses.com>` }),
      { from: 'ann@sender.test', to: 'admin@example.com' },
    );
    const after = await admin.get(`/api/threads/${thread.id}`);
    expect(after.messages.map((m: { direction: string }) => m.direction)).toEqual(['in', 'out', 'in']);
    expect((await admin.get('/api/threads?mailbox=all&view=sent')).threads).toHaveLength(1);
    expect((await admin.get('/api/threads?mailbox=all&view=drafts')).threads).toHaveLength(0);

    const overview = await admin.get('/api/admin/overview');
    expect(overview.providers[0]).toMatchObject({ type: 'resend', usedToday: 1, dailyLimit: 100 });
    expect(overview.stats.today).toMatchObject({ received: 2, sent: 1 });

    const contacts = await admin.get('/api/contacts?q=ann');
    expect(contacts[0].address).toBe('ann@sender.test');
  });

  it('keeps hostile sender names and unsubscribe addresses out of outgoing headers', async () => {
    await connectResend(admin);
    const name = btoa('Ann\r\nReply-To: attacker@evil.test');
    await deliver(
      email({
        from: `=?UTF-8?B?${name}?= <ann@sender.test>`,
        subject: 'Newsletter',
        extra: 'List-Unsubscribe: <mailto:list@sender.test%0D%0ARCPT%20TO:%3Cx@evil.test%3E?subject=bye%0D%0ABcc:%20x@evil.test>',
      }),
      { from: 'ann@sender.test', to: 'admin@example.com' },
    );
    const thread = (await admin.get('/api/threads?mailbox=all&view=inbox')).threads[0];
    const detail = await admin.get(`/api/threads/${thread.id}`);
    const msg = detail.messages[0];
    expect(msg.from).toEqual({ name: 'Ann Reply-To: attacker@evil.test', address: 'ann@sender.test' });
    expect(msg.listUnsubscribe.mailto).toBeTruthy();

    expect(await admin.status('POST', `/api/messages/${msg.id}/unsubscribe`, {})).toBe(400);
    expect(fake.state.resend.emails).toHaveLength(0);

    // A reply to that sender carries the name on one line.
    const boxes = await admin.get('/api/mailboxes');
    const draft = await admin.post('/api/drafts', { mailboxId: boxes[0].id, from: 'admin@example.com', to: [msg.from], subject: 'Re: Newsletter', html: '<p>Hi</p>', replyToMessageId: msg.id });
    expect((await admin.post(`/api/drafts/${draft.id}/send`, {})).status).toBe('sent');
    const out = fake.state.resend.emails[0] as { to: string[] };
    expect(out.to).toEqual(['"Ann Reply-To: attacker@evil.test" <ann@sender.test>']);
  });

  it('marks failures for retry, falls back between providers and enforces quota', async () => {
    await connectResend(admin);
    const boxes = await admin.get('/api/mailboxes');
    const compose = (subject: string) =>
      admin.post('/api/drafts', { mailboxId: boxes[0].id, from: 'admin@example.com', to: [{ name: '', address: 'x@dest.test' }], subject, html: '<p>Hi</p>' });

    fake.state.resend.failNext = 1;
    const d1 = await compose('Will fail once');
    const r1 = await admin.post(`/api/drafts/${d1.id}/send`, {});
    expect(r1.status).toBe('failed');
    const failures = await admin.get('/api/admin/failures');
    expect(failures[0]).toMatchObject({ kind: 'failed', subject: 'Will fail once' });
    expect(failures[0].retryAt).toBeGreaterThan(Date.now());
    const retried = await admin.post(`/api/messages/${d1.id}/retry`, {});
    expect(retried.status).toBe('sent');

    // Quota: with the daily cap reached, sending falls back to the next provider.
    const providers = await admin.get('/api/admin/providers');
    await admin.patch(`/api/admin/providers/${providers[0].id}`, { dailyLimit: 1 });
    await admin.post('/api/admin/providers', { type: 'brevo', config: { apiKey: 'xkeysib-test' } });
    const d2 = await compose('Falls back');
    expect((await admin.post(`/api/drafts/${d2.id}/send`, {})).status).toBe('sent');
    expect(fake.state.brevo.emails).toHaveLength(1);

    // Scheduled send waits for cron.
    const d3 = await compose('Later');
    expect((await admin.post(`/api/drafts/${d3.id}/send`, { sendAt: Date.now() + 3_600_000 })).status).toBe('scheduled');
    expect((await admin.get('/api/threads?mailbox=all&view=scheduled')).threads).toHaveLength(1);
    await admin.post(`/api/messages/${d3.id}/cancel-schedule`, {});
    expect((await admin.get('/api/threads?mailbox=all&view=drafts')).threads.map((t: { subject: string }) => t.subject)).toContain('Later');
  });

  it('keeps an upload attached when a queued save still lists it as an upload', async () => {
    const boxes = await admin.get('/api/mailboxes');
    const me = await admin.get('/api/auth/session');
    await env.DB.prepare("INSERT INTO uploads (id, user_id, storage_key, filename, content_type, size, created_at) VALUES ('u1', ?, 'uploads/u1', 'a.pdf', 'application/pdf', 3, 0)")
      .bind(me.user.id)
      .run();
    const input = { mailboxId: boxes[0].id, from: 'admin@example.com', to: [], subject: 'Files', html: '<p>Hi</p>', uploadIds: ['u1'] };
    const first = await admin.post('/api/drafts', input);
    expect(first.attachments).toMatchObject([{ filename: 'a.pdf', uploadId: 'u1' }]);
    // The composer sent this before the first response told it the attachment id.
    const second = await admin.put(`/api/drafts/${first.id}`, { ...input, html: '<p>Hi there</p>' });
    expect(second.attachments).toMatchObject([{ id: first.attachments[0].id, filename: 'a.pdf' }]);
    // Removing it in the composer drops it.
    expect((await admin.put(`/api/drafts/${first.id}`, { ...input, uploadIds: [] })).attachments).toEqual([]);
  });

  it('updates delivery status from signed Resend webhooks and suppresses bounces', async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('app.url', 'https://openinbox.tester.workers.dev', 0)").run();
    const { id: providerId } = await connectResend(admin);
    const boxes = await admin.get('/api/mailboxes');
    const d = await admin.post('/api/drafts', { mailboxId: boxes[0].id, from: 'admin@example.com', to: [{ name: '', address: 'gone@dest.test' }], subject: 'Hello', html: '<p>Hi</p>' });
    await admin.post(`/api/drafts/${d.id}/send`, {});
    const emailId = (fake.state.resend.emails[0] as { id: string }).id;

    const secret = 'whsec_dGVzdC1zZWNyZXQtZm9yLXdlYmhvb2tz';
    const sign = async (payload: string) => {
      const id = 'msg_1';
      const ts = String(Math.floor(Date.now() / 1000));
      const key = Uint8Array.from(atob(secret.slice(6)), (ch) => ch.charCodeAt(0));
      const sig = toBase64Url(await hmacSha256(key, `${id}.${ts}.${payload}`)).replace(/-/g, '+').replace(/_/g, '/');
      return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
    };
    const payload = JSON.stringify({ type: 'email.bounced', data: { email_id: emailId, to: ['gone@dest.test'], bounce: { type: 'Permanent', message: 'No such user' } } });
    const bad = await admin.request('POST', `/api/webhooks/resend/${providerId}`, JSON.parse(payload), { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'v1,bad' });
    expect(bad.status).toBe(401);
    const good = await admin.request('POST', `/api/webhooks/resend/${providerId}`, JSON.parse(payload), await sign(payload));
    expect(good.status).toBe(200);
    const thread = (await admin.get('/api/threads?mailbox=all&view=sent')).threads[0];
    const detail = await admin.get(`/api/threads/${thread.id}`);
    expect(detail.messages[0].status).toBe('bounced');
    expect((await admin.get('/api/admin/suppressions'))[0].address).toBe('gone@dest.test');

    const again = await admin.post('/api/drafts', { mailboxId: boxes[0].id, from: 'admin@example.com', to: [{ name: '', address: 'gone@dest.test' }], subject: 'Again', html: '<p>Hi</p>' });
    const r = await admin.post(`/api/drafts/${again.id}/send`, {});
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/bounced before/);
  });

  it('replaces the webhook on re-register and deletes it with the provider', async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('app.url', 'https://openinbox.tester.workers.dev', 0)").run();
    const { id: providerId } = await connectResend(admin);
    expect(fake.state.resend.webhooks).toHaveLength(1);
    await admin.post(`/api/admin/providers/${providerId}/webhook`, {});
    expect(fake.state.resend.webhooks).toHaveLength(1);
    await admin.request('DELETE', `/api/admin/providers/${providerId}`);
    expect(fake.state.resend.webhooks).toHaveLength(0);
    expect(await admin.get('/api/admin/providers')).toHaveLength(0);
  });
});
