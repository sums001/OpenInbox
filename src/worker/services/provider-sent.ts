// Mail sent through a provider by something other than OpenInbox: another app using the same
// Resend account, for example over SMTP (issue #17). Resend's email.sent webhook reports every
// message; the cron picks out the ones OpenInbox didn't send a minute later, once OpenInbox's own
// sends have stored their provider IDs. Each counts toward the provider's limits, so fallback
// starts before the provider refuses mail, and when a mailbox owns the From address the message
// shows in that mailbox's Sent.
import type { Env } from '../env';
import { all, first, run } from '../db/db';
import { nextSeqStmts } from '../db/sequence';
import { newId } from '../lib/ids';
import { parseJson } from '../lib/json';
import { logError } from '../lib/log';
import { dayKey, MINUTE } from '../lib/time';
import { parseAddress, type Address } from '../mail/address';
import { htmlToText, makeSnippet } from '../mail/html';
import { normalizeSubject } from '../mail/threading';
import { adapterFor, type ProviderRow } from '../providers';
import { ProviderError, type SentEmail } from '../providers/types';
import { fitBody } from './bodies';
import { bumpState } from './mailboxes';
import { quotaStmt } from './quota';
import { counterStmt, dailyStatStmt } from './stats';

// OpenInbox stores a message's provider ID as soon as the provider accepts it; a minute covers that.
export const PROVIDER_SENT_DELAY = MINUTE;
// Messages from an address with a mailbox are fetched from the provider, one subrequest each.
const FETCH_PER_RUN = 5;
const ROWS_PER_RUN = 50;
const MAX_ATTEMPTS = 3;

export interface ProviderSentEvent {
  providerMessageId: string;
  messageId?: string | null;
  from: string;
  to: string[];
  subject?: string;
  sentAt?: string;
}

const addresses = (list: string[]) => list.map(parseAddress).filter((a): a is Address => !!a);

// Notes a message the provider sent, unless OpenInbox already recorded it as its own.
export function noteProviderSentStmt(db: D1Database, providerId: number, e: ProviderSentEvent, now = Date.now()): D1PreparedStatement | null {
  const from = parseAddress(e.from);
  if (!from) return null;
  const sentAt = Date.parse(e.sentAt ?? '');
  return db
    .prepare(
      `INSERT OR IGNORE INTO provider_sent (provider_id, provider_message_id, message_id, from_addr, from_name, to_addrs, subject, sent_at, noted_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM messages WHERE provider_message_id = ? AND provider_id = ?)`,
    )
    .bind(
      providerId,
      e.providerMessageId,
      e.messageId?.trim().replace(/^<|>$/g, '') || null,
      from.address,
      from.name,
      JSON.stringify(addresses(e.to)),
      (e.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 900),
      Number.isFinite(sentAt) ? sentAt : now,
      now,
      e.providerMessageId,
      providerId,
    );
}

interface Row {
  provider_id: number;
  provider_message_id: string;
  message_id: string | null;
  from_addr: string;
  from_name: string;
  to_addrs: string;
  subject: string;
  sent_at: number;
  attempts: number;
  mailbox_id: number | null;
}

const deleteStmt = (db: D1Database, r: Row) =>
  db.prepare('DELETE FROM provider_sent WHERE provider_id = ? AND provider_message_id = ?').bind(r.provider_id, r.provider_message_id);

// Cron: imports the noted messages that are due. Returns how many were handled.
export async function importProviderSent(env: Env, now = Date.now()): Promise<number> {
  const db = env.DB;
  const due = now - PROVIDER_SENT_DELAY;
  // OpenInbox's own sends, noted before their provider ID was stored: already counted and shown.
  await run(
    db,
    `DELETE FROM provider_sent WHERE noted_at <= ?
       AND EXISTS (SELECT 1 FROM messages m WHERE m.provider_message_id = provider_sent.provider_message_id AND m.provider_id = provider_sent.provider_id)`,
    due,
  );
  const rows = await all<Row>(
    db,
    `SELECT p.provider_id, p.provider_message_id, p.message_id, p.from_addr, p.from_name, p.to_addrs, p.subject, p.sent_at, p.attempts, a.mailbox_id
       FROM provider_sent p LEFT JOIN addresses a ON a.address = p.from_addr WHERE p.noted_at <= ? ORDER BY p.noted_at LIMIT ?`,
    due,
    ROWS_PER_RUN,
  );
  // Without a mailbox for the From address there is nothing to show: OpenInbox only counts it.
  // (OpenInbox itself only sends from addresses it has mailboxes for.)
  const counted = rows
    .filter((r) => r.mailbox_id === null)
    .flatMap((r) => [quotaStmt(db, r.provider_id, Math.max(1, parseJson<Address[]>(r.to_addrs, []).length), dayKey(r.sent_at)), deleteStmt(db, r)]);
  if (counted.length) await db.batch(counted);
  let handled = counted.length / 2;
  for (const r of rows.filter((x): x is Row & { mailbox_id: number } => x.mailbox_id !== null).slice(0, FETCH_PER_RUN)) {
    try {
      if (await importOne(env, r, now)) handled++;
    } catch (e) {
      logError('provider_sent.import_failed', e, { provider: r.provider_id, attempts: r.attempts + 1 });
      await tryLater(db, r, now);
    }
  }
  return handled;
}

// Tried again on a later run, up to MAX_ATTEMPTS in all.
function tryLater(db: D1Database, r: Row, now: number) {
  return r.attempts + 1 < MAX_ATTEMPTS
    ? run(db, 'UPDATE provider_sent SET attempts = attempts + 1, noted_at = ? WHERE provider_id = ? AND provider_message_id = ?', now, r.provider_id, r.provider_message_id)
    : deleteStmt(db, r).run();
}

// Puts the message in Sent, with its content when the provider returns it. False when the fetch
// failed and is tried again on a later run.
async function importOne(env: Env, r: Row & { mailbox_id: number }, now: number): Promise<boolean> {
  const db = env.DB;
  const provider = await first<ProviderRow>(db, 'SELECT * FROM providers WHERE id = ?', r.provider_id);
  let email: SentEmail | null = null;
  let missing = `${provider?.name ?? 'The provider'} didn't return its content.`;
  try {
    const adapter = provider ? await adapterFor(env, provider) : null;
    if (adapter?.getSentEmail) email = await adapter.getSentEmail(r.provider_message_id);
  } catch (e) {
    // A provider outage is waited out; without the content after that, the message is still shown.
    if ((!(e instanceof ProviderError) || e.retryable) && r.attempts + 1 < MAX_ATTEMPTS) {
      await tryLater(db, r, now);
      return false;
    }
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
      missing = `${provider?.name ?? 'The provider'} returns the content of a message only to an API key with full access.`;
    }
    logError('provider_sent.fetch_failed', e, { provider: r.provider_id });
  }

  const from: Address = { name: r.from_name, address: r.from_addr };
  const to = email ? addresses(email.to) : parseJson<Address[]>(r.to_addrs, []);
  const cc = email ? addresses(email.cc) : [];
  const bcc = email ? addresses(email.bcc) : [];
  const replyTo = email ? (addresses(email.replyTo)[0] ?? null) : null;
  const subject = (email?.subject || r.subject).replace(/[\r\n]+/g, ' ').trim().slice(0, 900);
  const html = email?.html || null;
  const text = email ? email.text || (html ? htmlToText(html) : '') : `Sent outside OpenInbox through ${provider?.name ?? 'a provider'}. ${missing}`;
  const snippet = email ? makeSnippet(text) : '';
  const outcome: Record<string, string> = { delivered: 'delivered', bounced: 'bounced', complained: 'complained' };
  const status = outcome[email?.lastEvent ?? ''] ?? 'sent';
  const body = fitBody({ subject, fromText: `${from.name} ${from.address}`, toText: [...to, ...cc].map((a) => `${a.name} ${a.address}`).join(', '), text, html, headers: [] });
  const threadId = newId();
  const id = newId();
  const day = dayKey(r.sent_at);
  await db.batch([
    // A conversation of its own, in Archive like a new message written in OpenInbox; Sent is a view.
    db
      .prepare(
        `INSERT INTO threads (id, mailbox_id, folder, subject, subject_norm, snippet, participants, message_count, last_message_at, last_sent_at, updated_at)
         VALUES (?, ?, 'archive', ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(threadId, r.mailbox_id, subject, normalizeSubject(subject), snippet, JSON.stringify([from]), r.sent_at, r.sent_at, now),
    db
      .prepare(
        `INSERT INTO messages (id, thread_id, mailbox_id, direction, status, message_id, refs, from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, reply_to,
           subject, snippet, sent_at, is_read, truncated, provider_id, provider_message_id, created_at)
         VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        threadId,
        r.mailbox_id,
        status,
        r.message_id,
        r.message_id,
        from.address,
        from.name,
        JSON.stringify(to),
        JSON.stringify(cc),
        JSON.stringify(bcc),
        replyTo ? JSON.stringify(replyTo) : null,
        subject,
        snippet,
        r.sent_at,
        body.truncated ? 1 : 0,
        r.provider_id,
        r.provider_message_id,
        now,
      ),
    db
      .prepare('INSERT INTO message_bodies (message_id, subject, from_text, to_text, text, html) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, body.subject, body.fromText, body.toText, body.text, body.html),
    ...nextSeqStmts(db, id),
    quotaStmt(db, r.provider_id, Math.max(1, to.length + cc.length + bcc.length), day),
    dailyStatStmt(db, r.mailbox_id, 'sent', 1, day),
    counterStmt(db, 'sent', 1),
    bumpState(db, r.mailbox_id),
    deleteStmt(db, r),
  ]);
  return true;
}
