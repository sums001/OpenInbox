// Delivery events from providers: delivered, bounced, complained. Hard bounces and complaints
// add the recipient to the suppression list, which the send pipeline checks.
import type { Env } from '../env';
import { all, first, run } from '../db/db';
import { decrypt, fromBase64Url, hmacSha256, safeEqual, toBase64Url } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { log } from '../lib/log';
import type { ProviderRow } from '../providers';
import { bumpState } from './mailboxes';

type Outcome = 'delivered' | 'bounced' | 'complained';

async function applyOutcome(env: Env, providerId: number, providerMessageId: string, outcome: Outcome, recipients: string[], hard: boolean, detail?: string): Promise<void> {
  const db = env.DB;
  const msg = await first<{ id: number; mailbox_id: number; status: string }>(
    db,
    'SELECT id, mailbox_id, status FROM messages WHERE provider_message_id = ? AND provider_id = ?',
    providerMessageId,
    providerId,
  );
  const stmts: D1PreparedStatement[] = [];
  if (msg) {
    // Never downgrade a bounce or complaint back to delivered.
    const rank: Record<string, number> = { sent: 0, delivered: 1, bounced: 2, complained: 3 };
    if ((rank[outcome] ?? 0) >= (rank[msg.status] ?? 0)) {
      stmts.push(
        db.prepare('UPDATE messages SET status = ?, error = ? WHERE id = ?').bind(outcome, outcome === 'delivered' ? null : (detail ?? null), msg.id),
        bumpState(db, msg.mailbox_id),
      );
    }
  }
  if ((outcome === 'bounced' && hard) || outcome === 'complained') {
    for (const r of recipients) {
      stmts.push(
        db
          .prepare('INSERT INTO suppressions (address, reason, detail, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (address) DO UPDATE SET reason = excluded.reason, detail = excluded.detail')
          .bind(r.toLowerCase(), outcome === 'complained' ? 'complaint' : 'bounce', detail?.slice(0, 300) ?? null, Date.now()),
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  log('webhook.event', { providerId, outcome, found: !!msg });
}

async function providerById(db: D1Database, id: number, type: string): Promise<ProviderRow> {
  const p = await first<ProviderRow>(db, 'SELECT * FROM providers WHERE id = ? AND type = ?', id, type);
  if (!p) throw new HttpError(404, 'not_found', 'Unknown webhook.');
  return p;
}

// Resend signs webhooks with Svix: HMAC-SHA256 over "id.timestamp.body", key from "whsec_...".
export async function verifySvix(secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigs = headers.get('svix-signature');
  if (!id || !ts || !sigs) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const key = fromBase64Url(secret.replace(/^whsec_/, '').replace(/\+/g, '-').replace(/\//g, '_'));
  const expected = toBase64Url(await hmacSha256(key, `${id}.${ts}.${body}`));
  for (const part of sigs.split(' ')) {
    const [version, sig] = part.split(',');
    if (version === 'v1' && sig && (await safeEqual(sig.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), expected))) return true;
  }
  return false;
}

export async function handleResendWebhook(env: Env, providerId: number, req: Request): Promise<void> {
  const p = await providerById(env.DB, providerId, 'resend');
  const body = await req.text();
  if (!p.webhook_secret) throw new HttpError(403, 'forbidden', 'Webhook signing secret not configured.');
  if (!(await verifySvix(await decrypt(env, p.webhook_secret), req.headers, body))) throw new HttpError(401, 'bad_signature', 'Invalid signature.');
  const event = JSON.parse(body) as { type: string; data: { email_id: string; to?: string[]; bounce?: { type?: string; message?: string } } };
  const map: Record<string, Outcome> = { 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained' };
  const outcome = map[event.type];
  if (!outcome || !event.data?.email_id) return;
  const hard = outcome === 'bounced' ? !/transient|temporary/i.test(event.data.bounce?.type ?? '') : false;
  await applyOutcome(env, p.id, event.data.email_id, outcome, event.data.to ?? [], hard, event.data.bounce?.message);
}

async function checkToken(env: Env, p: ProviderRow, token: string): Promise<void> {
  if (!p.webhook_secret || !(await safeEqual(await decrypt(env, p.webhook_secret), token))) throw new HttpError(401, 'bad_token', 'Invalid webhook token.');
}

export async function handleBrevoWebhook(env: Env, providerId: number, token: string, req: Request): Promise<void> {
  const p = await providerById(env.DB, providerId, 'brevo');
  await checkToken(env, p, token);
  const e = (await req.json()) as { event?: string; email?: string; 'message-id'?: string; reason?: string };
  const id = e['message-id']?.replace(/^<|>$/g, '');
  if (!id || !e.event) return;
  const ev = e.event.toLowerCase();
  const outcome: Outcome | null =
    ev === 'delivered' ? 'delivered' : ev.includes('bounce') || ev === 'invalid_email' || ev === 'invalid' || ev === 'blocked' ? 'bounced' : ev === 'spam' || ev === 'complaint' ? 'complained' : null;
  if (!outcome) return;
  await applyOutcome(env, p.id, id, outcome, e.email ? [e.email] : [], ev.includes('hard') || ev.startsWith('invalid'), e.reason);
}

export async function handleMailjetWebhook(env: Env, providerId: number, token: string, req: Request): Promise<void> {
  const p = await providerById(env.DB, providerId, 'mailjet');
  await checkToken(env, p, token);
  const payload = (await req.json()) as unknown;
  const events = (Array.isArray(payload) ? payload : [payload]) as { event?: string; email?: string; MessageID?: number; hard_bounce?: boolean; error?: string }[];
  for (const e of events) {
    if (!e.MessageID || !e.event) continue;
    const outcome: Outcome | null = e.event === 'sent' ? 'delivered' : e.event === 'bounce' || e.event === 'blocked' ? 'bounced' : e.event === 'spam' ? 'complained' : null;
    if (outcome) await applyOutcome(env, p.id, String(e.MessageID), outcome, e.email ? [e.email] : [], !!e.hard_bounce || e.event === 'blocked', e.error);
  }
}

export async function listSuppressions(db: D1Database) {
  return all<{ address: string; reason: string; detail: string | null; created_at: number }>(db, 'SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 500');
}

export async function removeSuppression(db: D1Database, address: string): Promise<void> {
  await run(db, 'DELETE FROM suppressions WHERE address = ?', address);
}
