// Mail other apps send through the same Resend account (issue #17): reported by the email.sent
// webhook, counted toward the provider's limits, and shown in Sent when a mailbox owns the From.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, setupInstance } from '../helpers/client';
import { hmacSha256, toBase64Url } from '../../src/worker/lib/crypto';
import { importProviderSent } from '../../src/worker/services/provider-sent';
import { upgradeWebhooks, WEBHOOK_VERSION } from '../../src/worker/services/providers';
import { loadSettings } from '../../src/worker/db/settings';

const SECRET = 'whsec_dGVzdC1zZWNyZXQtZm9yLXdlYmhvb2tz';
const LATER = () => Date.now() + 2 * 60_000;

async function sign(payload: string) {
  const id = `msg_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Uint8Array.from(atob(SECRET.slice(6)), (ch) => ch.charCodeAt(0));
  const sig = toBase64Url(await hmacSha256(key, `${id}.${ts}.${payload}`)).replace(/-/g, '+').replace(/_/g, '/');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}

describe('mail sent through Resend outside OpenInbox', () => {
  let fake: ReturnType<typeof useFakeApis>;
  let admin: Client;
  let providerId: number;

  const sent = async (data: Record<string, unknown>) => {
    const payload = JSON.stringify({ type: 'email.sent', created_at: new Date().toISOString(), data: { created_at: new Date().toISOString(), ...data } });
    const res = await admin.request('POST', `/api/webhooks/resend/${providerId}`, JSON.parse(payload), await sign(payload));
    expect(res.status).toBe(200);
  };
  const pending = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM provider_sent').first<{ n: number }>())!.n;
  const usedToday = async () => (await admin.get('/api/admin/providers'))[0].usedToday;
  const sentThreads = async () => (await admin.get('/api/threads?mailbox=all&view=sent')).threads as { id: number; subject: string }[];
  const send = async (subject: string) => {
    const boxes = await admin.get('/api/mailboxes');
    const d = await admin.post('/api/drafts', { mailboxId: boxes[0].id, from: 'admin@example.com', to: [{ name: '', address: 'friend@dest.test' }], subject, html: '<p>Hi</p>' });
    expect((await admin.post(`/api/drafts/${d.id}/send`, {})).status).toBe('sent');
    return (fake.state.resend.emails.at(-1) as { id: string }).id;
  };

  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    await setupInstance(admin);
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('app.url', 'https://openinbox.tester.workers.dev', 0)").run();
    ({ id: providerId } = await admin.post('/api/admin/providers', { type: 'resend', config: { apiKey: 're_test_key_123' } }));
  });

  it('registers the webhook for email.sent', () => {
    expect(Object.values(fake.state.resend.webhookEvents)[0]).toContain('email.sent');
  });

  it('counts it, shows it in Sent with its content, and leaves OpenInbox’s own mail alone', async () => {
    // OpenInbox's own message, reported after its ID was stored: not noted at all.
    const own = await send('From OpenInbox');
    await sent({ email_id: own, from: 'admin@example.com', to: ['friend@dest.test'], subject: 'From OpenInbox' });
    // Another own message, reported before its ID was stored.
    await sent({ email_id: 'race-1', from: 'admin@example.com', to: ['friend@dest.test'], subject: 'Raced' });
    const second = await send('Raced');
    await env.DB.prepare('UPDATE messages SET provider_message_id = ? WHERE provider_message_id = ?').bind('race-1', second).run();

    // An app sending as an address with a mailbox, one without, and a broadcast.
    fake.state.resend.emails.push({
      id: 'ext-1',
      from: 'Signup App <admin@example.com>',
      to: ['user@dest.test'],
      cc: ['boss@dest.test'],
      subject: 'Confirm your signup',
      html: '<p>Click <a href="https://app.test/confirm">here</a> to confirm.</p>',
      last_event: 'delivered',
    });
    await sent({ email_id: 'ext-1', message_id: '<ext-1@resend.test>', from: 'Signup App <admin@example.com>', to: ['user@dest.test'], subject: 'Confirm your signup' });
    await sent({ email_id: 'ext-2', from: 'noreply@example.com', to: ['a@dest.test', 'b@dest.test'], subject: 'Reset your password' });
    await sent({ email_id: 'ext-3', broadcast_id: 'b1', from: 'admin@example.com', to: ['list@dest.test'], subject: 'Newsletter' });
    expect(await pending()).toBe(3);

    // Not before OpenInbox's own sends had a minute to store their IDs.
    expect(await importProviderSent(env)).toBe(0);
    expect(await importProviderSent(env, LATER())).toBe(2);
    expect(await pending()).toBe(0);

    // Two own messages, then 1 To + 1 Cc and 2 To from the apps.
    expect(await usedToday()).toBe(6);
    const threads = await sentThreads();
    expect(threads.map((t) => t.subject).sort()).toEqual(['Confirm your signup', 'From OpenInbox', 'Raced']);
    const detail = await admin.get(`/api/threads/${threads.find((t) => t.subject === 'Confirm your signup')!.id}`);
    expect(detail.messages[0]).toMatchObject({
      direction: 'out',
      status: 'delivered',
      from: { name: 'Signup App', address: 'admin@example.com' },
      to: [{ address: 'user@dest.test' }],
      cc: [{ address: 'boss@dest.test' }],
      messageId: 'ext-1@resend.test',
    });
    expect(detail.messages[0].html).toContain('https://app.test/confirm');
    expect(detail.messages[0].text).toContain('to confirm');

    // A repeated delivery of the webhook doesn't import it twice.
    await sent({ email_id: 'ext-1', from: 'admin@example.com', to: ['user@dest.test'], subject: 'Confirm your signup' });
    expect(await pending()).toBe(0);
  });

  it('waits out a provider outage, then shows the content', async () => {
    fake.state.resend.emails.push({ id: 'ext-4', from: 'admin@example.com', to: ['user@dest.test'], subject: 'Receipt', text: 'Thanks for your order.' });
    await sent({ email_id: 'ext-4', from: 'admin@example.com', to: ['user@dest.test'], subject: 'Receipt' });
    fake.state.resend.failGet = 1;
    expect(await importProviderSent(env, LATER())).toBe(0);
    expect(await pending()).toBe(1);
    expect(await importProviderSent(env, LATER() + 60_000)).toBe(1);
    const thread = (await sentThreads())[0];
    expect((await admin.get(`/api/threads/${thread.id}`)).messages[0].text).toBe('Thanks for your order.');
  });

  it('shows the message without its content for a sending-only key', async () => {
    await admin.request('DELETE', `/api/admin/providers/${providerId}`);
    ({ id: providerId } = await admin.post('/api/admin/providers', { type: 'resend', config: { apiKey: 're_send_only_key' } }));
    // A sending-only key can't register webhooks: the admin adds one in Resend and pastes its secret.
    expect(fake.state.resend.webhooks).toHaveLength(0);
    await admin.post(`/api/admin/providers/${providerId}/webhook-secret`, { secret: SECRET });
    await sent({ email_id: 'ext-5', from: 'admin@example.com', to: ['user@dest.test'], subject: 'Your login code' });
    expect(await importProviderSent(env, LATER())).toBe(1);
    const thread = (await sentThreads())[0];
    expect(thread.subject).toBe('Your login code');
    const m = (await admin.get(`/api/threads/${thread.id}`)).messages[0];
    expect(m.to).toEqual([{ name: '', address: 'user@dest.test' }]);
    expect(m.text).toMatch(/only to an API key with full access/);
    expect(await usedToday()).toBe(1);
  });

  it('registers webhooks made before email.sent again, once', async () => {
    const [old] = fake.state.resend.webhooks;
    await env.DB.prepare('UPDATE providers SET webhook_version = 0').run();
    fake.state.resend.webhookEvents[old] = ['email.delivered'];
    await upgradeWebhooks(env, await loadSettings(env.DB));
    expect(fake.state.resend.webhooks).toHaveLength(1);
    expect(fake.state.resend.webhooks[0]).not.toBe(old);
    expect(fake.state.resend.webhookEvents[fake.state.resend.webhooks[0]]).toContain('email.sent');
    expect((await env.DB.prepare('SELECT webhook_version FROM providers').first<{ webhook_version: number }>())!.webhook_version).toBe(WEBHOOK_VERSION);
    // Nothing left to upgrade; a webhook added by hand is never touched.
    await env.DB.prepare("UPDATE providers SET webhook_version = 0, webhook_id = 'manual'").run();
    const requests = fake.state.requests.length;
    await upgradeWebhooks(env, await loadSettings(env.DB));
    expect(fake.state.requests.length).toBe(requests);
  });
});
