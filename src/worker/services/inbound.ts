// The email() pipeline. Order matters:
//   1. size check and recipient resolution (reject early, before reading the message)
//   2. keep the raw .eml before parsing, so nothing is lost if parsing fails
//   3. scan with the light MIME scanner (attachments are only located, not decoded)
//   4. dedupe, thread, spam and filters, then one D1 batch writes everything (FTS via triggers)
//   5. side effects: forwarding copies, auto-reply
import type { Env } from '../env';
import { loadSettings, type AppSettings } from '../db/settings';
import { all, first, isUniqueViolation, placeholders, run } from '../db/db';
import { activeStore, storeFor, type BlobStore } from '../storage';
import { D1BlobStore } from '../storage/d1';
import { scan, type ScanResult } from '../mail/scan';
import { decodeWords } from '../mail/headers';
import { domainOf, normalizeAddress, parseAddressList, stripPlusTag, type Address } from '../mail/address';
import { htmlToText, makeSnippet } from '../mail/html';
import { normalizeSubject, parseIdList, parseMessageId } from '../mail/threading';
import { authSpamReason, parseAuthResults } from '../mail/auth-results';
import { newId } from '../lib/ids';
import { log, logError } from '../lib/log';
import { DAY } from '../lib/time';
import { parseJson } from '../lib/json';
import { fitBody } from './bodies';
import { applyFilters, loadFilters, type FilterActions } from './filters';
import { counterStmt, dailyStatStmt, inboundLogStmt, logInbound } from './stats';
import { bumpState, type AutoReply } from './mailboxes';
import { maybeAutoReply } from './autoreply';

export interface Recipient {
  mailboxId: number;
  address: string;
  via: 'exact' | 'plus' | 'catchall';
}

export async function resolveRecipient(db: D1Database, rcpt: string): Promise<Recipient | null> {
  const address = normalizeAddress(rcpt);
  const exact = await first<{ mailbox_id: number }>(db, 'SELECT mailbox_id FROM addresses WHERE address = ?', address);
  if (exact) return { mailboxId: exact.mailbox_id, address, via: 'exact' };
  const base = stripPlusTag(address);
  if (base) {
    const plus = await first<{ mailbox_id: number }>(db, 'SELECT mailbox_id FROM addresses WHERE address = ?', base);
    if (plus) return { mailboxId: plus.mailbox_id, address: base, via: 'plus' };
  }
  const domain = await first<{ catch_all_mailbox_id: number | null; status: string }>(
    db,
    'SELECT catch_all_mailbox_id, status FROM domains WHERE name = ?',
    domainOf(address),
  );
  if (domain?.catch_all_mailbox_id && domain.status !== 'disabled') return { mailboxId: domain.catch_all_mailbox_id, address, via: 'catchall' };
  return null;
}

async function isBlocked(db: D1Database, mailboxId: number, from: string): Promise<boolean> {
  const row = await first(
    db,
    'SELECT id FROM blocked_senders WHERE (mailbox_id IS NULL OR mailbox_id = ?) AND pattern IN (?, ?) LIMIT 1',
    mailboxId,
    from,
    `@${domainOf(from)}`,
  );
  return !!row;
}

export interface ParsedMessage {
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: Address | null;
  date: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  listUnsubscribe: { url?: string; mailto?: string; oneClick: boolean } | null;
  isBulk: boolean;
  isAutoSubmitted: boolean;
  text: string;
  html: string | null;
}

export function readParsed(s: ScanResult, envelopeFrom: string): ParsedMessage {
  const h = s.headers;
  const from = parseAddressList(h.from)[0] ?? { name: '', address: normalizeAddress(envelopeFrom) };
  const dateHeader = h.date ? Date.parse(h.date.replace(/\s*\([^)]*\)\s*$/, '')) : NaN;
  const now = Date.now();
  const date = Number.isFinite(dateHeader) && dateHeader < now + DAY && dateHeader > 0 ? dateHeader : now;
  let listUnsubscribe: ParsedMessage['listUnsubscribe'] = null;
  if (h['list-unsubscribe']) {
    const targets = [...h['list-unsubscribe'].matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
    const url = targets.find((t) => /^https:\/\//i.test(t));
    const mailto = targets.find((t) => /^mailto:/i.test(t));
    if (url || mailto) listUnsubscribe = { url, mailto, oneClick: !!url && /one-click/i.test(h['list-unsubscribe-post'] ?? '') };
  }
  const text = s.text ?? (s.html ? htmlToText(s.html) : '');
  return {
    subject: decodeWords(h.subject ?? '').replace(/[\r\n]+/g, ' ').trim(),
    from,
    to: parseAddressList(h.to),
    cc: parseAddressList(h.cc),
    replyTo: parseAddressList(h['reply-to'])[0] ?? null,
    date,
    messageId: parseMessageId(h['message-id']),
    inReplyTo: parseMessageId(h['in-reply-to']),
    references: parseIdList(h.references),
    listUnsubscribe,
    isBulk: !!h['list-id'] || !!h['list-unsubscribe'] || /^(bulk|list|junk)$/i.test((h.precedence ?? '').trim()),
    isAutoSubmitted: !!h['auto-submitted'] && !/^no$/i.test(h['auto-submitted'].trim()),
    text,
    html: s.html,
  };
}

interface ThreadMatch {
  id: number;
  participants: string;
}

export async function findThread(db: D1Database, mailboxId: number, p: ParsedMessage): Promise<ThreadMatch | null> {
  const ids = [...new Set([p.inReplyTo, ...p.references].filter((x): x is string => !!x))].slice(-50);
  if (ids.length) {
    const hit = await first<{ thread_id: number }>(
      db,
      `SELECT thread_id FROM messages WHERE mailbox_id = ? AND message_id IN (${placeholders(ids.length)}) ORDER BY sent_at DESC LIMIT 1`,
      mailboxId,
      ...ids,
    );
    if (hit) return first<ThreadMatch>(db, 'SELECT id, participants FROM threads WHERE id = ?', hit.thread_id);
  }
  // Fallback: same normalized subject and a shared participant within 30 days.
  const norm = normalizeSubject(p.subject);
  if (norm.length < 3) return null;
  const candidates = await all<ThreadMatch>(
    db,
    'SELECT id, participants FROM threads WHERE mailbox_id = ? AND subject_norm = ? AND last_message_at > ? ORDER BY last_message_at DESC LIMIT 5',
    mailboxId,
    norm,
    Date.now() - 30 * DAY,
  );
  const people = new Set([p.from, ...p.to, ...p.cc].map((a) => a.address));
  return candidates.find((t) => parseJson<Address[]>(t.participants, []).some((a) => people.has(a.address))) ?? null;
}

// Senders in order of appearance, most recent last, at most 8.
export function mergeParticipants(existing: Address[], add: Address): Address[] {
  const list = existing.filter((a) => a.address !== add.address);
  list.push(add);
  return list.slice(-8);
}

interface Context {
  env: Env;
  settings: AppSettings;
}

async function storeRaw(store: BlobStore, key: string, bytes: Uint8Array): Promise<'d1' | 'r2' | null> {
  if (bytes.byteLength > store.maxBytes) return null;
  await store.put(key, bytes, 'message/rfc822');
  return store.kind;
}

function rawKeyFor(now = new Date()): string {
  return `raw/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.eml`;
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const settings = await loadSettings(env.DB);
  const rcpt = normalizeAddress(message.to);
  const envelopeFrom = normalizeAddress(message.from || '');
  const size = message.rawSize;
  const reject = async (reason: string, status: 'rejected' = 'rejected') => {
    message.setReject(reason);
    await logInbound(env.DB, { from: envelopeFrom, to: rcpt, size, status, reason }, true);
    log('inbound.rejected', { to: rcpt, size, reason });
  };

  if (!settings.setupCompletedAt) return reject('This mail server is not set up yet.');
  const limit = settings.maxInboundMb * 1024 * 1024;
  if (size > limit) return reject(`Message too large (limit ${settings.maxInboundMb} MB).`);
  const recipient = await resolveRecipient(env.DB, rcpt);
  if (!recipient) return reject('550 5.1.1 Unknown recipient.');
  if (envelopeFrom && (await isBlocked(env.DB, recipient.mailboxId, envelopeFrom))) return reject('Message rejected by the recipient.');

  const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  await ingest({ env, settings }, bytes, { rcpt, envelopeFrom, recipient, message, ctx });
}

export interface IngestOptions {
  rcpt: string;
  envelopeFrom: string;
  recipient: Recipient;
  message?: ForwardableEmailMessage; // absent for imports
  ctx?: ExecutionContext;
  folderOverride?: 'inbox' | 'archive';
  markRead?: boolean;
  existingRaw?: { key: string; store: 'd1' | 'r2' }; // retry of a message whose raw is already kept
}

export type IngestResult = { status: 'delivered' | 'spam' | 'duplicate' | 'unparsed' | 'rejected'; messageId?: number; threadId?: number };

// Shared by email() and .eml import.
export async function ingest(c: Context, bytes: Uint8Array, o: IngestOptions): Promise<IngestResult> {
  const { env, settings } = c;
  const now = Date.now();
  let rawKey = rawKeyFor(new Date(now));
  let rawStore: 'd1' | 'r2' | null = null;
  if (o.existingRaw) {
    rawKey = o.existingRaw.key;
    rawStore = o.existingRaw.store;
  } else {
    try {
      rawStore = await storeRaw(await activeStore(env, settings), rawKey, bytes);
    } catch (e) {
      logError('inbound.raw_store_failed', e, { to: o.rcpt });
    }
  }

  let s: ScanResult;
  try {
    s = scan(bytes);
  } catch (e) {
    logError('inbound.scan_failed', e, { to: o.rcpt, size: bytes.byteLength });
    return storeUnparsed(c, o, bytes.byteLength, rawKey, rawStore, e instanceof Error ? e.message : String(e));
  }
  const p = readParsed(s, o.envelopeFrom);
  const mailboxId = o.recipient.mailboxId;

  if (p.messageId) {
    const dup = await first(env.DB, "SELECT id FROM messages WHERE mailbox_id = ? AND message_id = ? AND direction = 'in'", mailboxId, p.messageId);
    if (dup) return duplicate(c, o, bytes.byteLength, p.subject, rawKey, rawStore);
  }

  const auth = parseAuthResults(s.headerList);
  let spamReason = settings.spamPolicy === 'off' || o.folderOverride ? null : authSpamReason(auth);
  const attachments = s.attachments.map((a) => ({
    id: newId(),
    filename: a.filename ? decodeWords(a.filename) : '',
    contentType: a.contentType,
    size: a.approxSize,
    contentId: a.contentId,
    inline: a.inline,
    encoding: a.encoding,
    offset: a.offset,
    length: a.length,
  }));
  const hasAttachments = attachments.some((a) => !a.inline || !a.contentId);
  const filters = await loadFilters(env.DB, mailboxId);
  const actions: FilterActions = applyFilters(filters, {
    fromAddr: p.from.address,
    fromName: p.from.name,
    recipients: [o.rcpt, ...p.to.map((a) => a.address), ...p.cc.map((a) => a.address)],
    subject: p.subject,
    text: p.text,
    hasAttachment: hasAttachments,
    isList: p.isBulk,
  });
  if (actions.neverSpam) spamReason = null;
  if (spamReason && settings.spamPolicy === 'reject' && o.message) {
    o.message.setReject(`Message rejected: ${spamReason}.`);
    await deleteRaw(c, rawKey, rawStore);
    await logInbound(env.DB, { from: o.envelopeFrom, to: o.rcpt, subject: p.subject, size: bytes.byteLength, status: 'rejected', reason: spamReason }, true);
    return { status: 'rejected' };
  }

  const folder = spamReason ? 'spam' : (actions.folder ?? o.folderOverride ?? 'inbox');
  const isRead = actions.markRead || o.markRead ? 1 : 0;
  const thread = await findThread(env.DB, mailboxId, p);
  const threadId = thread?.id ?? newId();
  const messageId = newId();
  const snippet = makeSnippet(p.text);
  const body = fitBody({
    subject: p.subject,
    fromText: `${p.from.name} ${p.from.address}`.trim(),
    toText: [...p.to, ...p.cc].map((a) => `${a.name} ${a.address}`.trim()).join(', '),
    text: p.text,
    html: p.html,
    headers: s.headerList,
  });
  const participants = mergeParticipants(parseJson<Address[]>(thread?.participants, []), p.from);
  // Lists sort by arrival time (a sender controls the Date header); imports keep their dates.
  const sortTime = o.message ? now : p.date;
  const db = env.DB;

  const stmts: D1PreparedStatement[] = [];
  if (thread) {
    stmts.push(
      db
        .prepare(
          `UPDATE threads SET folder = ?, snippet = ?, participants = ?, message_count = message_count + 1,
             unread_count = unread_count + ?, has_attachments = MAX(has_attachments, ?), starred = MAX(starred, ?),
             last_message_at = MAX(last_message_at, ?), last_inbound_at = ?, snoozed_until = NULL, updated_at = ? WHERE id = ?`,
        )
        .bind(folder, snippet, JSON.stringify(participants), isRead ? 0 : 1, hasAttachments ? 1 : 0, actions.star ? 1 : 0, sortTime, now, now, threadId),
    );
  } else {
    stmts.push(
      db
        .prepare(
          `INSERT INTO threads (id, mailbox_id, folder, subject, subject_norm, snippet, participants, message_count, unread_count,
             has_attachments, starred, last_message_at, last_inbound_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          threadId,
          mailboxId,
          folder,
          p.subject,
          normalizeSubject(p.subject),
          snippet,
          JSON.stringify(participants),
          isRead ? 0 : 1,
          hasAttachments ? 1 : 0,
          actions.star ? 1 : 0,
          sortTime,
          now,
          now,
        ),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO messages (id, thread_id, mailbox_id, direction, status, message_id, in_reply_to, refs, from_addr, from_name,
           to_addrs, cc_addrs, reply_to, delivered_to, subject, snippet, sent_at, is_read, has_attachments, size, raw_key, raw_store,
           truncated, spf, dkim, dmarc, spam_reason, list_unsubscribe, created_at)
         VALUES (?, ?, ?, 'in', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        messageId,
        threadId,
        mailboxId,
        p.messageId,
        p.inReplyTo,
        p.references.join(' ') || null,
        p.from.address,
        p.from.name,
        JSON.stringify(p.to),
        JSON.stringify(p.cc),
        p.replyTo ? JSON.stringify(p.replyTo) : null,
        o.rcpt,
        p.subject,
        snippet,
        p.date,
        isRead,
        hasAttachments ? 1 : 0,
        bytes.byteLength,
        rawStore ? rawKey : null,
        rawStore,
        body.truncated ? 1 : 0,
        auth.spf,
        auth.dkim,
        auth.dmarc,
        spamReason,
        p.listUnsubscribe ? JSON.stringify(p.listUnsubscribe) : null,
        now,
      ),
    db
      .prepare('INSERT INTO message_bodies (message_id, subject, from_text, to_text, text, html, headers) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(messageId, body.subject, body.fromText, body.toText, body.text, body.html, body.headers),
  );
  for (const a of attachments) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, inline, encoding, byte_offset, byte_length, stored)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(a.id, messageId, a.filename, a.contentType, a.size, a.contentId, a.inline ? 1 : 0, a.encoding, a.offset, a.length, rawStore ? 1 : 0),
    );
  }
  for (const labelId of actions.labelIds ?? []) {
    stmts.push(
      db
        .prepare('INSERT OR IGNORE INTO thread_labels (thread_id, label_id) SELECT ?, id FROM labels WHERE id = ? AND mailbox_id = ?')
        .bind(threadId, labelId, mailboxId),
    );
  }
  if (!spamReason && !p.isBulk && !p.isAutoSubmitted && p.from.address) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO contacts (mailbox_id, address, name, use_count, last_used_at) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (mailbox_id, address) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END, last_used_at = excluded.last_used_at`,
        )
        .bind(mailboxId, p.from.address, p.from.name, now),
    );
  }
  stmts.push(
    dailyStatStmt(db, mailboxId, spamReason ? 'spam' : 'received'),
    counterStmt(db, 'messages', 1),
    ...(rawStore === 'd1' ? [counterStmt(db, 'raw_d1_bytes', bytes.byteLength)] : []),
    inboundLogStmt(db, {
      from: o.envelopeFrom || p.from.address,
      to: o.rcpt,
      subject: p.subject,
      size: bytes.byteLength,
      status: spamReason ? 'spam' : 'delivered',
      reason: spamReason ?? (o.recipient.via !== 'exact' ? `via ${o.recipient.via}` : null),
      messageId,
    }),
    bumpState(db, mailboxId),
  );

  try {
    await db.batch(stmts);
  } catch (e) {
    if (isUniqueViolation(e)) return duplicate(c, o, bytes.byteLength, p.subject, rawKey, rawStore);
    throw e;
  }
  log('inbound.delivered', {
    to: o.rcpt,
    size: bytes.byteLength,
    rawStore,
    attachments: attachments.length,
    authres: auth,
    spam: !!spamReason,
    threaded: !!thread,
  });

  if (!spamReason && o.message) await sideEffects(c, o, mailboxId, threadId, p, actions);
  return { status: spamReason ? 'spam' : 'delivered', messageId, threadId };
}

async function sideEffects(c: Context, o: IngestOptions, mailboxId: number, threadId: number, p: ParsedMessage, actions: FilterActions): Promise<void> {
  const { env } = c;
  const mailbox = await first<{ forward_to: string; auto_reply: string | null; address: string; display_name: string }>(
    env.DB,
    'SELECT forward_to, auto_reply, address, display_name FROM mailboxes WHERE id = ?',
    mailboxId,
  );
  if (!mailbox) return;
  const targets = new Set(parseJson<string[]>(mailbox.forward_to, []));
  if (actions.forwardTo) targets.add(actions.forwardTo);
  if (targets.size && o.message) {
    const verified = await all<{ address: string }>(
      env.DB,
      `SELECT address FROM forward_destinations WHERE verified_at IS NOT NULL AND address IN (${placeholders(targets.size)})`,
      ...targets,
    );
    for (const { address } of verified) {
      try {
        await o.message.forward(address);
      } catch (e) {
        logError('inbound.forward_failed', e, { to: address });
      }
    }
  }
  const autoReply = parseJson<AutoReply | null>(mailbox.auto_reply, null);
  if (autoReply?.enabled && o.ctx) {
    o.ctx.waitUntil(
      maybeAutoReply(env, c.settings, { id: mailboxId, address: mailbox.address, displayName: mailbox.display_name }, autoReply, p, threadId).catch((e) =>
        logError('autoreply.failed', e),
      ),
    );
  }
}

async function deleteRaw(c: Context, key: string, kind: 'd1' | 'r2' | null): Promise<void> {
  if (!kind) return;
  const store = await storeFor(c.env, c.settings, kind);
  await store?.delete([key]).catch(() => undefined);
}

async function duplicate(c: Context, o: IngestOptions, size: number, subject: string, rawKey: string, rawStore: 'd1' | 'r2' | null): Promise<IngestResult> {
  await deleteRaw(c, rawKey, rawStore);
  await logInbound(c.env.DB, { from: o.envelopeFrom, to: o.rcpt, subject, size, status: 'duplicate' });
  return { status: 'duplicate' };
}

async function storeUnparsed(c: Context, o: IngestOptions, size: number, rawKey: string, rawStore: 'd1' | 'r2' | null, error: string): Promise<IngestResult> {
  const db = c.env.DB;
  const now = Date.now();
  const threadId = newId();
  const messageId = newId();
  const subject = '(Message could not be read yet)';
  const snippet = rawStore ? 'OpenInbox will retry reading this message automatically.' : 'This message could not be read and was too large to keep.';
  await db.batch([
    db
      .prepare(
        `INSERT INTO threads (id, mailbox_id, folder, subject, subject_norm, snippet, participants, message_count, unread_count, last_message_at, last_inbound_at, updated_at)
         VALUES (?, ?, 'inbox', ?, '', ?, ?, 1, 1, ?, ?, ?)`,
      )
      .bind(threadId, o.recipient.mailboxId, subject, snippet, JSON.stringify([{ name: '', address: o.envelopeFrom }]), now, now, now),
    db
      .prepare(
        `INSERT INTO messages (id, thread_id, mailbox_id, direction, status, from_addr, delivered_to, subject, snippet, sent_at, size, raw_key, raw_store, error, created_at)
         VALUES (?, ?, ?, 'in', 'unparsed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(messageId, threadId, o.recipient.mailboxId, o.envelopeFrom, o.rcpt, subject, snippet, now, size, rawStore ? rawKey : null, rawStore, error.slice(0, 500), now),
    db.prepare('INSERT INTO message_bodies (message_id, subject, text) VALUES (?, ?, ?)').bind(messageId, subject, snippet),
    inboundLogStmt(db, { from: o.envelopeFrom, to: o.rcpt, size, status: 'unparsed', reason: error.slice(0, 300), messageId }),
    bumpState(db, o.recipient.mailboxId),
  ]);
  return { status: 'unparsed', messageId, threadId };
}

// Cron: re-reads messages that failed to parse, a few at a time.
export async function retryUnparsed(env: Env, limit = 3): Promise<number> {
  const settings = await loadSettings(env.DB);
  const rows = await all<{ id: number; thread_id: number; mailbox_id: number; delivered_to: string; from_addr: string; raw_key: string; raw_store: 'd1' | 'r2'; attempts: number }>(
    env.DB,
    "SELECT id, thread_id, mailbox_id, delivered_to, from_addr, raw_key, raw_store, attempts FROM messages WHERE status = 'unparsed' AND raw_key IS NOT NULL AND attempts < 5 LIMIT ?",
    limit,
  );
  let fixed = 0;
  for (const r of rows) {
    const store = r.raw_store === 'd1' ? new D1BlobStore(env.DB) : await storeFor(env, settings, r.raw_store);
    const bytes = store ? await store.get(r.raw_key) : null;
    if (!bytes) {
      await run(env.DB, 'UPDATE messages SET attempts = 5 WHERE id = ?', r.id);
      continue;
    }
    try {
      scan(bytes); // throws again if still unreadable
    } catch (e) {
      await run(env.DB, 'UPDATE messages SET attempts = attempts + 1, error = ? WHERE id = ?', e instanceof Error ? e.message : String(e), r.id);
      continue;
    }
    // Readable now: remove the placeholder and ingest again from the kept raw.
    await run(env.DB, 'DELETE FROM threads WHERE id = ?', r.thread_id);
    await ingest({ env, settings }, bytes, {
      rcpt: r.delivered_to,
      envelopeFrom: r.from_addr,
      recipient: { mailboxId: r.mailbox_id, address: r.delivered_to, via: 'exact' },
      existingRaw: { key: r.raw_key, store: r.raw_store },
    });
    fixed++;
  }
  return fixed;
}

