// Drafts and the send pipeline:
//   check the sender owns the From address -> check suppressions -> resolve provider (domain
//   override, else default, falling back down the priority list when a cap is hit) -> check quota
//   -> send with our own Message-ID, also appended to References -> archive the sent .eml and store
//   the provider message ID, or mark failed (retryable failures retry from cron with backoff).
import type { Env } from '../env';
import { loadSettings, type AppSettings } from '../db/settings';
import { all, first, placeholders, run } from '../db/db';
import { newId } from '../lib/ids';
import { badRequest, errorMessage, HttpError, notFound } from '../lib/errors';
import { parseJson } from '../lib/json';
import { log, logError } from '../lib/log';
import { MINUTE } from '../lib/time';
import { domainOf, isValidAddress, normalizeAddress, singleLine, type Address } from '../mail/address';
import { buildMime } from '../mail/mime';
import { scan } from '../mail/scan';
import { htmlToText, makeSnippet } from '../mail/html';
import { buildReferences, newMessageId, normalizeSubject } from '../mail/threading';
import { decodeAttachment } from '../mail/decode';
import { activeStore, storeFor } from '../storage';
import { adapterFor, type ProviderRow } from '../providers';
import { ProviderError, type OutgoingAttachment, type OutgoingMessage } from '../providers/types';
import { fitBody } from './bodies';
import { quotaStmt, quotaUse, remaining } from './quota';
import { counterStmt, dailyStatStmt } from './stats';
import { bumpState } from './mailboxes';
import { mergeParticipants } from './inbound';
import type { SessionUser } from '../types';

export interface ComposeInput {
  mailboxId: number;
  from: string; // one of the mailbox's addresses
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  text?: string;
  replyToMessageId?: number | null;
  attachmentIds?: number[]; // attachments already on the draft (or on a forwarded message)
  uploadIds?: string[];
}

interface MessageRow {
  id: number;
  thread_id: number;
  mailbox_id: number;
  status: string;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc_addrs: string;
  bcc_addrs: string;
  subject: string;
  attempts: number;
  send_at: number | null;
  sent_by: number | null;
}

function cleanList(list: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of list) {
    const address = normalizeAddress(a.address ?? '');
    if (!address || seen.has(address)) continue;
    if (!isValidAddress(address)) throw badRequest(`${a.address} is not a valid email address.`);
    seen.add(address);
    out.push({ name: singleLine(a.name ?? '').trim().slice(0, 200), address });
  }
  return out;
}

async function fromAddressFor(db: D1Database, mailboxId: number, from: string): Promise<{ address: string; displayName: string }> {
  const row = await first<{ address: string; display_name: string | null; mailbox_name: string }>(
    db,
    'SELECT a.address, a.display_name, m.display_name AS mailbox_name FROM addresses a JOIN mailboxes m ON m.id = a.mailbox_id WHERE a.address = ? AND a.mailbox_id = ?',
    normalizeAddress(from),
    mailboxId,
  );
  if (!row) throw badRequest(`${from} is not an address of this mailbox.`, 'bad_from');
  return { address: row.address, displayName: row.display_name || row.mailbox_name };
}

export interface DraftResult {
  id: number;
  threadId: number;
  attachments: { id: number; filename: string; size: number; uploadId: string | null }[];
}

export async function saveDraft(env: Env, user: SessionUser, input: ComposeInput, draftId?: number): Promise<DraftResult> {
  const db = env.DB;
  const from = await fromAddressFor(db, input.mailboxId, input.from);
  const to = cleanList(input.to);
  const cc = cleanList(input.cc);
  const bcc = cleanList(input.bcc);
  const subject = input.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 900);
  const html = input.html ?? '';
  const text = input.text ?? htmlToText(html);
  const now = Date.now();
  const body = fitBody({ subject, fromText: `${from.displayName} ${from.address}`, toText: [...to, ...cc].map((a) => `${a.name} ${a.address}`).join(', '), text, html, headers: [] });
  if (body.truncated) throw badRequest('This message is too long to save.');
  const stmts: D1PreparedStatement[] = [];
  let id = draftId;
  let threadId: number;

  if (id) {
    const existing = await first<{ thread_id: number; status: string; mailbox_id: number }>(db, 'SELECT thread_id, status, mailbox_id FROM messages WHERE id = ?', id);
    if (!existing || existing.mailbox_id !== input.mailboxId) throw notFound('Draft not found.');
    if (existing.status !== 'draft') throw badRequest('This message has already been sent.');
    threadId = existing.thread_id;
    stmts.push(
      db
        .prepare('UPDATE messages SET from_addr = ?, from_name = ?, to_addrs = ?, cc_addrs = ?, bcc_addrs = ?, subject = ?, snippet = ?, sent_at = ? WHERE id = ?')
        .bind(from.address, from.displayName, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, makeSnippet(text), now, id),
      db.prepare('UPDATE message_bodies SET subject = ?, from_text = ?, to_text = ?, text = ?, html = ? WHERE message_id = ?').bind(body.subject, body.fromText, body.toText, body.text, body.html, id),
      db
        .prepare("UPDATE threads SET subject = CASE WHEN message_count = 0 THEN ? ELSE subject END, subject_norm = CASE WHEN message_count = 0 THEN ? ELSE subject_norm END, updated_at = ? WHERE id = ?")
        .bind(subject, normalizeSubject(subject), now, threadId),
    );
  } else {
    id = newId();
    let inReplyTo: string | null = null;
    let refs: string[];
    const ownId = newMessageId(domainOf(from.address));
    if (input.replyToMessageId) {
      const parent = await first<{ thread_id: number; mailbox_id: number; message_id: string | null; refs: string | null }>(
        db,
        'SELECT thread_id, mailbox_id, message_id, refs FROM messages WHERE id = ?',
        input.replyToMessageId,
      );
      if (!parent || parent.mailbox_id !== input.mailboxId) throw notFound('The message you are replying to was not found.');
      threadId = parent.thread_id;
      inReplyTo = parent.message_id;
      refs = buildReferences((parent.refs ?? '').split(' ').filter(Boolean), parent.message_id, ownId);
      stmts.push(db.prepare('UPDATE threads SET draft_count = draft_count + 1, updated_at = ? WHERE id = ?').bind(now, threadId));
    } else {
      threadId = newId();
      refs = [ownId];
      // A new conversation lives in Archive until someone replies; Sent and Drafts are views.
      stmts.push(
        db
          .prepare(
            "INSERT INTO threads (id, mailbox_id, folder, subject, subject_norm, snippet, participants, message_count, draft_count, last_message_at, updated_at) VALUES (?, ?, 'archive', ?, ?, ?, ?, 0, 1, ?, ?)",
          )
          .bind(threadId, input.mailboxId, subject, normalizeSubject(subject), makeSnippet(text), JSON.stringify([{ name: from.displayName, address: from.address }]), now, now),
      );
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO messages (id, thread_id, mailbox_id, direction, status, message_id, in_reply_to, refs, from_addr, from_name, to_addrs, cc_addrs, bcc_addrs,
             subject, snippet, sent_at, is_read, sent_by, created_at) VALUES (?, ?, ?, 'out', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(id, threadId, input.mailboxId, ownId, inReplyTo, refs.join(' '), from.address, from.displayName, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, makeSnippet(text), now, user.id, now),
      db.prepare('INSERT INTO message_bodies (message_id, subject, from_text, to_text, text, html) VALUES (?, ?, ?, ?, ?, ?)').bind(id, body.subject, body.fromText, body.toText, body.text, body.html),
    );
  }

  // Attachments: keep the listed ones, add new uploads, copy forwarded ones.
  const keep = input.attachmentIds ?? [];
  const current = await all<{ id: number; message_id: number }>(
    db,
    keep.length ? `SELECT id, message_id FROM attachments WHERE id IN (${placeholders(keep.length)})` : 'SELECT id, message_id FROM attachments WHERE 0',
    ...keep,
  );
  // A save queued behind another one still lists an upload the earlier save already attached
  // (the composer learns the attachment id from that save's response), so keep those too.
  const uploadKeys = (input.uploadIds ?? []).map((u) => `uploads/${u}`);
  stmts.push(
    db
      .prepare(
        `DELETE FROM attachments WHERE message_id = ?${keep.length ? ` AND id NOT IN (${placeholders(keep.length)})` : ''}${
          uploadKeys.length ? ` AND (upload_key IS NULL OR upload_key NOT IN (${placeholders(uploadKeys.length)}))` : ''
        }`,
      )
      .bind(id, ...keep, ...uploadKeys),
  );
  for (const a of current.filter((x) => x.message_id !== id)) {
    // An attachment of another message (forwarding): reference it, decoded at send time.
    const src = await first<{ filename: string; content_type: string; size: number; mailbox_id: number }>(
      db,
      'SELECT a.filename, a.content_type, a.size, g.mailbox_id FROM attachments a JOIN messages g ON g.id = a.message_id WHERE a.id = ?',
      a.id,
    );
    if (!src || src.mailbox_id !== input.mailboxId) continue;
    stmts.push(
      db
        .prepare('INSERT INTO attachments (id, message_id, filename, content_type, size, stored, upload_key) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .bind(newId(), id, src.filename, src.content_type, src.size, `att:${a.id}`),
    );
  }
  for (const uploadId of input.uploadIds ?? []) {
    const u = await first<{ storage_key: string; filename: string; content_type: string; size: number }>(
      db,
      'SELECT storage_key, filename, content_type, size FROM uploads WHERE id = ? AND user_id = ?',
      uploadId,
      user.id,
    );
    if (!u) continue;
    stmts.push(
      db
        .prepare('INSERT INTO attachments (id, message_id, filename, content_type, size, stored, upload_key) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .bind(newId(), id, u.filename, u.content_type, u.size, u.storage_key),
      db.prepare('DELETE FROM uploads WHERE id = ?').bind(uploadId),
    );
  }
  stmts.push(db.prepare('UPDATE messages SET has_attachments = (SELECT COUNT(*) > 0 FROM attachments WHERE message_id = ?) WHERE id = ?').bind(id, id));
  stmts.push(bumpState(db, input.mailboxId));
  await db.batch(stmts);
  // The composer maps its uploads to attachment ids, so later saves keep them.
  const attachments = await all<{ id: number; filename: string; size: number; upload_key: string | null }>(
    db,
    'SELECT id, filename, size, upload_key FROM attachments WHERE message_id = ? ORDER BY id',
    id,
  );
  return {
    id,
    threadId,
    attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size, uploadId: a.upload_key?.startsWith('uploads/') ? a.upload_key.slice(8) : null })),
  };
}

export async function deleteDraft(env: Env, user: SessionUser, id: number): Promise<void> {
  const db = env.DB;
  const m = await first<{ thread_id: number; mailbox_id: number; status: string }>(db, 'SELECT thread_id, mailbox_id, status FROM messages WHERE id = ?', id);
  if (!m || m.status !== 'draft') throw notFound('Draft not found.');
  const access = await first(db, 'SELECT 1 FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?', m.mailbox_id, user.id);
  if (!access) throw notFound('Draft not found.');
  const uploads = await all<{ upload_key: string }>(db, "SELECT upload_key FROM attachments WHERE message_id = ? AND upload_key LIKE 'uploads/%'", id);
  await db.batch([
    db.prepare('DELETE FROM messages WHERE id = ?').bind(id),
    db.prepare('UPDATE threads SET draft_count = MAX(draft_count - 1, 0), updated_at = ? WHERE id = ?').bind(Date.now(), m.thread_id),
    db.prepare('DELETE FROM threads WHERE id = ? AND message_count = 0 AND draft_count = 0').bind(m.thread_id),
    bumpState(db, m.mailbox_id),
  ]);
  if (uploads.length) {
    const settings = await loadSettings(db);
    const r2 = await storeFor(env, settings, 'r2');
    await r2?.delete(uploads.map((u) => u.upload_key)).catch(() => undefined);
  }
}

// Queues a draft: sends now, or schedules it.
export async function sendDraft(env: Env, user: SessionUser, id: number, sendAt?: number | null): Promise<{ status: string; error?: string }> {
  const db = env.DB;
  const m = await first<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id);
  if (!m || m.status !== 'draft') throw notFound('Draft not found.');
  const access = await first<{ can_send: number }>(db, 'SELECT can_send FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?', m.mailbox_id, user.id);
  if (!access) throw notFound('Draft not found.');
  if (!access.can_send) throw new HttpError(403, 'forbidden', 'You can read this mailbox but not send from it.');
  const recipients = [...parseJson<Address[]>(m.to_addrs, []), ...parseJson<Address[]>(m.cc_addrs, []), ...parseJson<Address[]>(m.bcc_addrs, [])];
  if (!recipients.length) throw badRequest('Add at least one recipient.');
  if (sendAt && sendAt > Date.now() + MINUTE) {
    await db.batch([
      db.prepare("UPDATE messages SET status = 'scheduled', send_at = ?, sent_by = ? WHERE id = ?").bind(sendAt, user.id, id),
      db.prepare('UPDATE threads SET draft_count = MAX(draft_count - 1, 0), message_count = message_count + 1, updated_at = ? WHERE id = ?').bind(Date.now(), m.thread_id),
      bumpState(db, m.mailbox_id),
    ]);
    return { status: 'scheduled' };
  }
  await run(db, 'UPDATE messages SET sent_by = ? WHERE id = ?', user.id, id);
  return deliver(env, await loadSettings(db), id);
}

export async function cancelScheduled(env: Env, user: SessionUser, id: number): Promise<void> {
  const db = env.DB;
  const m = await first<{ thread_id: number; mailbox_id: number }>(db, "SELECT thread_id, mailbox_id FROM messages WHERE id = ? AND status = 'scheduled'", id);
  if (!m) throw notFound('Scheduled message not found.');
  const access = await first(db, 'SELECT 1 FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?', m.mailbox_id, user.id);
  if (!access) throw notFound('Scheduled message not found.');
  const r = await run(db, "UPDATE messages SET status = 'draft', send_at = NULL WHERE id = ? AND status = 'scheduled'", id);
  if (!r.meta.changes) throw notFound('Scheduled message not found.');
  await db.batch([
    db.prepare('UPDATE threads SET draft_count = draft_count + 1, message_count = MAX(message_count - 1, 0), updated_at = ? WHERE id = ?').bind(Date.now(), m.thread_id),
    bumpState(db, m.mailbox_id),
  ]);
}

export async function retryMessage(env: Env, user: SessionUser | null, id: number): Promise<{ status: string; error?: string }> {
  const db = env.DB;
  const m = await first<{ mailbox_id: number; status: string }>(db, 'SELECT mailbox_id, status FROM messages WHERE id = ?', id);
  if (!m || m.status !== 'failed') throw notFound('Failed message not found.');
  if (user) {
    const access = await first<{ can_send: number }>(db, 'SELECT can_send FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?', m.mailbox_id, user.id);
    if (!access?.can_send && user.role === 'member') throw notFound('Failed message not found.');
  }
  return deliver(env, await loadSettings(db), id);
}

async function providerCandidates(db: D1Database, fromDomain: string): Promise<ProviderRow[]> {
  const domain = await first<{ id: number; provider_id: number | null }>(db, 'SELECT id, provider_id FROM domains WHERE name = ?', fromDomain);
  if (!domain) throw new HttpError(409, 'unknown_domain', `${fromDomain} is not a connected domain.`);
  const rows = await all<ProviderRow & { pd_status: string | null }>(
    db,
    `SELECT p.*, pd.status AS pd_status FROM providers p LEFT JOIN provider_domains pd ON pd.provider_id = p.id AND pd.domain_id = ?
      ORDER BY (p.id = ?) DESC, p.is_default DESC, p.priority, p.created_at`,
    domain.id,
    domain.provider_id ?? -1,
  );
  if (!rows.length) throw new HttpError(409, 'no_provider', 'Connect a sending provider first (Admin > Integrations).');
  // SMTP has no domain verification; the others need the domain verified with them.
  const usable = rows.filter((p) => p.type === 'smtp' || p.pd_status === 'verified');
  if (!usable.length) throw new HttpError(409, 'domain_not_verified', `${fromDomain} is not verified with a sending provider yet (Admin > Domains).`);
  return domain.provider_id ? usable.filter((p) => p.id === domain.provider_id).concat(usable.filter((p) => p.id !== domain.provider_id)) : usable;
}

async function loadAttachments(env: Env, settings: AppSettings, messageId: number): Promise<{ id: number; att: OutgoingAttachment }[]> {
  const rows = await all<{ id: number; filename: string; content_type: string; content_id: string | null; inline: number; upload_key: string | null; encoding: string | null; byte_offset: number | null; byte_length: number | null; raw_key: string | null; raw_store: 'd1' | 'r2' | null }>(
    env.DB,
    `SELECT a.id, a.filename, a.content_type, a.content_id, a.inline, a.upload_key, a.encoding, a.byte_offset, a.byte_length, g.raw_key, g.raw_store
       FROM attachments a JOIN messages g ON g.id = a.message_id WHERE a.message_id = ? ORDER BY a.id`,
    messageId,
  );
  const out: { id: number; att: OutgoingAttachment }[] = [];
  for (const r of rows) {
    let content: Uint8Array | null = null;
    if (r.upload_key?.startsWith('uploads/')) {
      content = (await (await storeFor(env, settings, 'r2'))?.get(r.upload_key)) ?? null;
    } else if (r.upload_key?.startsWith('att:')) {
      content = await attachmentBytes(env, settings, Number(r.upload_key.slice(4)));
    } else if (r.raw_key && r.raw_store && r.byte_offset !== null && r.byte_length !== null) {
      const range = await (await storeFor(env, settings, r.raw_store))?.getRange(r.raw_key, r.byte_offset, r.byte_length);
      content = range ? decodeAttachment(range, r.encoding) : null;
    }
    if (!content) throw new HttpError(409, 'attachment_missing', `The attachment ${r.filename} is no longer available.`);
    out.push({ id: r.id, att: { filename: r.filename || 'attachment', contentType: r.content_type, content, contentId: r.content_id ?? undefined, inline: !!r.inline } });
  }
  return out;
}

export async function attachmentBytes(env: Env, settings: AppSettings, attachmentId: number): Promise<Uint8Array | null> {
  const a = await first<{ upload_key: string | null; encoding: string | null; byte_offset: number | null; byte_length: number | null; raw_key: string | null; raw_store: 'd1' | 'r2' | null; stored: number }>(
    env.DB,
    'SELECT a.upload_key, a.encoding, a.byte_offset, a.byte_length, a.stored, g.raw_key, g.raw_store FROM attachments a JOIN messages g ON g.id = a.message_id WHERE a.id = ?',
    attachmentId,
  );
  if (!a || !a.stored) return null;
  if (a.upload_key?.startsWith('uploads/')) return (await (await storeFor(env, settings, 'r2'))?.get(a.upload_key)) ?? null;
  if (a.upload_key?.startsWith('att:')) return attachmentBytes(env, settings, Number(a.upload_key.slice(4)));
  if (!a.raw_key || !a.raw_store || a.byte_offset === null || a.byte_length === null) return null;
  const range = await (await storeFor(env, settings, a.raw_store))?.getRange(a.raw_key, a.byte_offset, a.byte_length);
  return range ? decodeAttachment(range, a.encoding) : null;
}

export async function deliver(env: Env, settings: AppSettings, id: number): Promise<{ status: string; error?: string }> {
  const db = env.DB;
  const before = await first<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id);
  if (!before) throw notFound('Message not found.');
  // Claim the message so a user click and the cron can't both send it.
  const claim = await run(db, "UPDATE messages SET status = 'sending' WHERE id = ? AND status IN ('draft', 'scheduled', 'failed')", id);
  if (!claim.meta.changes) return { status: before.status };
  const wasDraft = before.status === 'draft';
  const now = Date.now();
  const to = parseJson<Address[]>(before.to_addrs, []);
  const cc = parseJson<Address[]>(before.cc_addrs, []);
  const bcc = parseJson<Address[]>(before.bcc_addrs, []);
  const recipients = [...to, ...cc, ...bcc];

  const fail = async (error: string, retryable: boolean) => {
    const attempts = before.attempts + 1;
    const retryAt = retryable && attempts < 4 ? now + 2 ** attempts * MINUTE : null;
    await db.batch([
      db.prepare("UPDATE messages SET status = 'failed', error = ?, attempts = ?, send_at = ? WHERE id = ?").bind(error.slice(0, 1000), attempts, retryAt, id),
      ...(wasDraft
        ? [db.prepare('UPDATE threads SET draft_count = MAX(draft_count - 1, 0), message_count = message_count + 1, updated_at = ? WHERE id = ?').bind(now, before.thread_id)]
        : []),
      bumpState(db, before.mailbox_id),
    ]);
    log('send.failed', { id, error: error.slice(0, 200), retryable });
    return { status: 'failed', error };
  };

  try {
    const owns = await first(db, 'SELECT 1 FROM addresses WHERE address = ? AND mailbox_id = ?', before.from_addr, before.mailbox_id);
    if (!owns) return await fail(`${before.from_addr} is no longer an address of this mailbox.`, false);
    // Drafts are checked when saved; system replies (auto-reply, unsubscribe) take addresses from
    // received mail, so every recipient is checked again before it reaches a provider.
    const invalid = recipients.find((r) => !isValidAddress(r.address));
    if (invalid) return await fail(`${singleLine(invalid.address).slice(0, 254)} is not a valid email address.`, false);
    if (recipients.length) {
      const suppressed = await all<{ address: string; reason: string }>(
        db,
        `SELECT address, reason FROM suppressions WHERE address IN (${placeholders(recipients.length)})`,
        ...recipients.map((r) => r.address),
      );
      if (suppressed.length) {
        return await fail(
          `Not sent: ${suppressed.map((s) => `${s.address} (${s.reason === 'complaint' ? 'marked earlier mail as spam' : s.reason === 'bounce' ? 'bounced before' : 'blocked'})`).join(', ')}. Remove them from Admin > Suppressions to send anyway.`,
          false,
        );
      }
    }
    const body = await first<{ text: string; html: string | null; headers: string }>(db, 'SELECT text, html, headers FROM message_bodies WHERE message_id = ?', id);
    // Outbound messages keep extra headers (e.g. Auto-Submitted) in message_bodies.headers.
    const extraHeaders = Object.fromEntries(parseJson<[string, string][]>(body?.headers, []));
    const attachments = await loadAttachments(env, settings, id);
    const refs = (before.refs ?? '').split(' ').filter(Boolean);
    const from = { name: before.from_name, address: before.from_addr };
    const messageId = before.message_id ?? newMessageId(domainOf(from.address));
    const references = refs.length ? refs : [messageId];
    const raw = buildMime({
      from,
      to,
      cc,
      subject: before.subject,
      text: body?.text ?? '',
      html: body?.html || null,
      messageId,
      inReplyTo: before.in_reply_to,
      references,
      date: new Date(now),
      headers: extraHeaders,
      attachments: attachments.map((a) => a.att),
    });
    const outgoing: OutgoingMessage = {
      from,
      to,
      cc,
      bcc,
      subject: before.subject,
      text: body?.text ?? '',
      html: body?.html || null,
      messageId,
      inReplyTo: before.in_reply_to,
      references,
      headers: extraHeaders,
      attachments: attachments.map((a) => a.att),
      raw,
    };

    let candidates: ProviderRow[];
    try {
      candidates = await providerCandidates(db, domainOf(from.address));
    } catch (e) {
      return await fail(errorMessage(e), false);
    }
    let lastError = '';
    let lastRetryable = false;
    for (const p of candidates) {
      const room = remaining(await quotaUse(db, p));
      if (room !== null && room < recipients.length) {
        lastError = `${p.name} has reached its sending limit for today or this month.`;
        lastRetryable = true;
        continue;
      }
      try {
        const adapter = await adapterFor(env, p);
        const result = await adapter.send(outgoing);
        await recordSent(env, settings, before, p, result.providerMessageId, raw, attachments, wasDraft, recipients, now);
        log('send.sent', { id, provider: p.type, recipients: recipients.length });
        return { status: 'sent' };
      } catch (e) {
        lastError = errorMessage(e);
        lastRetryable = e instanceof ProviderError ? e.retryable : true;
        logError('send.provider_failed', e, { id, provider: p.type });
        if (!(e instanceof ProviderError) || !e.retryable) break; // a permanent error won't improve with another provider
      }
    }
    return await fail(lastError || 'No provider could send this message.', lastRetryable);
  } catch (e) {
    return await fail(errorMessage(e), !(e instanceof HttpError));
  }
}

async function recordSent(
  env: Env,
  settings: AppSettings,
  m: MessageRow,
  provider: ProviderRow,
  providerMessageId: string | null,
  raw: string,
  attachments: { id: number; att: OutgoingAttachment }[],
  wasDraft: boolean,
  recipients: Address[],
  now: number,
): Promise<void> {
  const db = env.DB;
  // Archive the sent .eml: R2 in attachments mode, D1 if it fits.
  const bytes = new TextEncoder().encode(raw);
  const store = await activeStore(env, settings);
  const rawKey = `sent/${new Date(now).toISOString().slice(0, 7)}/${crypto.randomUUID()}.eml`;
  let rawStore: 'd1' | 'r2' | null = null;
  if (bytes.byteLength <= store.maxBytes) {
    try {
      await store.put(rawKey, bytes, 'message/rfc822');
      rawStore = store.kind;
    } catch (e) {
      logError('send.archive_failed', e, { id: m.id });
    }
  }
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE messages SET status = 'sent', provider_id = ?, provider_message_id = ?, sent_at = ?, attempts = attempts + 1, error = NULL, send_at = NULL, raw_key = ?, raw_store = ?, size = ? WHERE id = ?",
      )
      .bind(provider.id, providerMessageId, now, rawStore ? rawKey : null, rawStore, bytes.byteLength, m.id),
  ];
  const thread = await first<{ participants: string }>(db, 'SELECT participants FROM threads WHERE id = ?', m.thread_id);
  const participants = mergeParticipants(parseJson<Address[]>(thread?.participants, []), { name: m.from_name, address: m.from_addr });
  stmts.push(
    db
      .prepare(
        `UPDATE threads SET draft_count = MAX(draft_count - ?, 0), message_count = message_count + ?, last_sent_at = ?, last_message_at = MAX(last_message_at, ?),
           participants = ?, has_attachments = MAX(has_attachments, ?), updated_at = ? WHERE id = ?`,
      )
      .bind(wasDraft ? 1 : 0, wasDraft ? 1 : 0, now, now, JSON.stringify(participants), attachments.length ? 1 : 0, now, m.thread_id),
    quotaStmt(db, provider.id, Math.max(1, recipients.length)),
    dailyStatStmt(db, m.mailbox_id, 'sent'),
    counterStmt(db, 'sent', 1),
    bumpState(db, m.mailbox_id),
  );
  for (const r of recipients) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO contacts (mailbox_id, address, name, use_count, last_used_at) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (mailbox_id, address) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at,
             name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END`,
        )
        .bind(m.mailbox_id, r.address, r.name, now),
    );
  }
  // Point attachments at the archived .eml, so downloads work like inbound mail and the uploads
  // can be deleted.
  const uploadKeys: string[] = [];
  if (rawStore && attachments.length) {
    // buildMime puts inline images (with a Content-ID) first, then files; the scanner reads the
    // parts back in the same order.
    const ordered = [...attachments.filter((a) => a.att.inline && a.att.contentId), ...attachments.filter((a) => !(a.att.inline && a.att.contentId))];
    const scanned = scan(bytes).attachments;
    const keys = await all<{ id: number; upload_key: string | null }>(
      db,
      `SELECT id, upload_key FROM attachments WHERE id IN (${placeholders(attachments.length)})`,
      ...attachments.map((a) => a.id),
    );
    ordered.forEach((a, i) => {
      const s = scanned[i];
      if (!s) return;
      const key = keys.find((k) => k.id === a.id)?.upload_key;
      if (key?.startsWith('uploads/')) uploadKeys.push(key);
      stmts.push(
        db
          .prepare('UPDATE attachments SET encoding = ?, byte_offset = ?, byte_length = ?, upload_key = NULL, stored = 1 WHERE id = ?')
          .bind(s.encoding, s.offset, s.length, a.id),
      );
    });
  }
  await db.batch(stmts);
  if (uploadKeys.length) await (await storeFor(env, settings, 'r2'))?.delete(uploadKeys).catch(() => undefined);
}

// Cron: sends scheduled messages that are due, retries retryable failures, and recovers
// messages stuck in "sending" after a crash.
export async function processQueue(env: Env, limit = 5): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  await run(db, "UPDATE messages SET status = 'failed', error = 'Sending was interrupted.', send_at = ? WHERE status = 'sending' AND sent_at < ?", now, now - 15 * MINUTE);
  const due = await all<{ id: number }>(
    db,
    "SELECT id FROM messages WHERE status IN ('scheduled', 'failed') AND send_at IS NOT NULL AND send_at <= ? AND attempts < 4 ORDER BY send_at LIMIT ?",
    now,
    limit,
  );
  if (!due.length) return;
  const settings = await loadSettings(db);
  for (const m of due) await deliver(env, settings, m.id).catch((e) => logError('queue.deliver_failed', e, { id: m.id }));
}

// Sends a message on behalf of the system (auto-replies) and records it in the thread.
export async function sendSystemReply(
  env: Env,
  settings: AppSettings,
  input: { mailboxId: number; threadId: number; from: Address; to: Address; subject: string; text: string; inReplyTo: string | null; references: string[] },
): Promise<void> {
  const db = env.DB;
  const id = newId();
  const now = Date.now();
  const ownId = newMessageId(domainOf(input.from.address));
  const refs = buildReferences(input.references, input.inReplyTo, ownId);
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (id, thread_id, mailbox_id, direction, status, message_id, in_reply_to, refs, from_addr, from_name, to_addrs, subject, snippet, sent_at, is_read, created_at)
         VALUES (?, ?, ?, 'out', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(id, input.threadId, input.mailboxId, ownId, input.inReplyTo, refs.join(' '), input.from.address, input.from.name, JSON.stringify([input.to]), input.subject, makeSnippet(input.text), now, now),
    db
      .prepare('INSERT INTO message_bodies (message_id, subject, from_text, to_text, text, headers) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, input.subject, input.from.address, input.to.address, input.text, JSON.stringify([['Auto-Submitted', 'auto-replied'], ['X-Auto-Response-Suppress', 'All']])),
    db.prepare('UPDATE threads SET draft_count = draft_count + 1 WHERE id = ?').bind(input.threadId),
  ]);
  await deliver(env, settings, id);
}
