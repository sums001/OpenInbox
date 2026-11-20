// Mailjet's Send API v3.1 refuses headers it sets itself, Message-ID among them (issue #18).
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, setupInstance } from '../helpers/client';
import { MailjetAdapter, mailjetError } from '../../src/worker/providers/mailjet';

describe('Mailjet provider', () => {
  let admin: Client;
  let fake: ReturnType<typeof useFakeApis>;
  let domainId: number;

  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    ({ domainId } = await setupInstance(admin));
  });

  it('sends without the headers Mailjet refuses, and replies still thread', async () => {
    const { id } = await admin.post('/api/admin/providers', { type: 'mailjet', config: { apiKey: 'mj-key', apiSecret: 'mj-secret' } });
    // The domain as Mailjet would report it once its DNS records check out.
    await env.DB.prepare("UPDATE provider_domains SET status = 'verified' WHERE provider_id = ? AND domain_id = ?").bind(id, domainId).run();
    const boxes = await admin.get('/api/mailboxes');
    const draft = await admin.post('/api/drafts', {
      mailboxId: boxes[0].id,
      from: 'admin@example.com',
      to: [{ name: 'Ann', address: 'ann@dest.test' }],
      subject: 'Sent through Mailjet',
      html: '<p>Hello</p>',
    });
    expect(await admin.post(`/api/drafts/${draft.id}/send`, {})).toMatchObject({ status: 'sent' });

    const out = (fake.state.mailjet.emails[0] as { Messages: { Headers: Record<string, string> }[] }).Messages[0];
    // Mailjet uses its own Message-ID; ours rides on References.
    expect(out.Headers['Message-ID']).toBeUndefined();
    const threads = (await admin.get('/api/threads?mailbox=all&view=sent')).threads;
    const ownId = (await admin.get(`/api/threads/${threads[0].id}`)).messages[0].messageId as string;
    expect(out.Headers.References).toBe(`<${ownId}>`);

    await deliver(email({ subject: 'Re: Sent through Mailjet', messageId: 'r1@dest.test', inReplyTo: 'mailjet-own-id@mailjet.test', references: `<${ownId}> <mailjet-own-id@mailjet.test>` }), {
      from: 'ann@dest.test',
      to: 'admin@example.com',
    });
    const after = await admin.get(`/api/threads/${threads[0].id}`);
    expect(after.messages.map((m: { direction: string }) => m.direction)).toEqual(['out', 'in']);
  });

  it('drops reserved headers in any case and keeps the others', async () => {
    const adapter = new MailjetAdapter({ apiKey: 'k', apiSecret: 's' }, 'https://mailjet.test');
    await adapter.send({
      from: { name: '', address: 'admin@example.com' },
      to: [{ name: '', address: 'ann@dest.test' }],
      cc: [],
      bcc: [],
      subject: 'Out of office',
      text: 'Away until Monday.',
      messageId: 'own@example.com',
      inReplyTo: 'q1@dest.test',
      references: ['q1@dest.test', 'own@example.com'],
      headers: { 'Auto-Submitted': 'auto-replied', date: 'Mon, 9 Nov 2026 10:00:00 +0000', 'X-Mailer': 'x' },
      attachments: [],
      raw: '',
    });
    expect((fake.state.mailjet.emails[0] as { Messages: { Headers: Record<string, string> }[] }).Messages[0].Headers).toEqual({
      'Auto-Submitted': 'auto-replied',
      'In-Reply-To': '<q1@dest.test>',
      References: '<q1@dest.test> <own@example.com>',
    });
  });

  it('names the field Mailjet refused', async () => {
    const refused = await mailjetError(
      new Response(
        JSON.stringify({
          Messages: [
            {
              Status: 'error',
              Errors: [
                {
                  ErrorCode: 'send-0011',
                  StatusCode: 400,
                  ErrorMessage: 'Header cannot be customized using the "Headers" collection. Please use the dedicated property to set this header.',
                  ErrorRelatedTo: ['Headers["Message-ID"]'],
                },
              ],
            },
          ],
        }),
        { status: 400 },
      ),
    );
    expect(refused.message).toBe('Mailjet: Header cannot be customized using the "Headers" collection. Please use the dedicated property to set this header. (Headers["Message-ID"])');
    expect(refused.retryable).toBe(false);
    // The other APIs' errors.
    expect((await mailjetError(new Response(JSON.stringify({ ErrorMessage: 'Unauthorized' }), { status: 401 }))).message).toBe('Mailjet: Unauthorized');
    expect((await mailjetError(new Response('Bad gateway', { status: 502 }))).retryable).toBe(true);
  });
});
