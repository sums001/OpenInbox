// Inbox API (/api/v1): read, search and send mail with an API key. Authenticated by apiKeyAuth;
// every route acts as the key's user, within the key's scopes and mailboxes. Documented in
// API.md.
import { Hono } from 'hono';
import { Buffer } from 'node:buffer';
import type { AppBindings, SessionUser } from '../types';
import type { Env } from '../env';
import { body, intParam } from '../lib/validate';
import { apiSendSchema, apiThreadActionSchema } from '../../shared/schemas';
import { FOLDERS, type Folder } from '../../shared/constants';
import { all, first, placeholders, run } from '../db/db';
import { loadSettings } from '../db/settings';
import { assertMessage, assertThread } from '../auth/access';
import { currentUser } from '../auth/middleware';
import { assertKeyMailbox, currentKey, keyMailboxes, requireScope } from '../auth/api-key';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { parseJson } from '../lib/json';
import { contentDisposition } from '../mail/decode';
import { normalizeAddress, type Address } from '../mail/address';
import { applyThreadAction, getThread, listThreads, messageBody, searchThreads } from '../services/threads';
import { attachmentBytes, cancelScheduled, deleteDraft, saveDraft, sendDraft } from '../services/send';
import { r2Store } from '../storage';
import { trackingEvents } from '../services/tracking';

export const api = new Hono<AppBindings>();

const MAX_ATTACHMENT = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL = 25 * 1024 * 1024;
// type/subtype only: anything else is stored and served as application/octet-stream.
const MIME_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

api.get('/me', (c) => {
  const user = currentUser(c);
  const key = currentKey(c);
  return c.json({ user: { id: user.id, email: user.email, name: user.name }, key: { id: key.id, scopes: key.scopes, mailboxIds: key.mailboxIds } });
});

api.get('/mailboxes', requireScope('read'), async (c) => {
  const access = await keyMailboxes(c);
  if (!access.length) return c.json({ mailboxes: [] });
  const ids = access.map((a) => a.mailboxId);
  const [boxes, addresses] = await Promise.all([
    all<{ id: number; address: string; display_name: string; kind: string }>(
      c.env.DB,
      `SELECT id, address, display_name, kind FROM mailboxes WHERE id IN (${placeholders(ids.length)}) ORDER BY address`,
      ...ids,
    ),
    all<{ address: string; mailbox_id: number; is_primary: number }>(
      c.env.DB,
      `SELECT address, mailbox_id, is_primary FROM addresses WHERE mailbox_id IN (${placeholders(ids.length)}) ORDER BY is_primary DESC, address`,
      ...ids,
    ),
  ]);
  return c.json({
    mailboxes: boxes.map((b) => ({
      id: b.id,
      address: b.address,
      displayName: b.display_name,
      kind: b.kind,
      canSend: access.find((a) => a.mailboxId === b.id)?.canSend ?? false,
      addresses: addresses.filter((a) => a.mailbox_id === b.id).map((a) => a.address),
    })),
  });
});

async function mailboxScope(c: Parameters<typeof keyMailboxes>[0], param: string | undefined): Promise<number[]> {
  const access = await keyMailboxes(c);
  if (!param || param === 'all') return access.map((a) => a.mailboxId);
  const id = Number(param);
  if (!access.some((a) => a.mailboxId === id)) throw notFound('Mailbox not found.');
  return [id];
}

function limitParam(raw: string | undefined, max = 100): number {
  const n = raw === undefined ? 50 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`limit must be 1 to ${max}.`);
  return n;
}

api.get('/threads', requireScope('read'), async (c) => {
  const mailboxIds = await mailboxScope(c, c.req.query('mailbox'));
  const view = (c.req.query('view') ?? 'inbox') as Folder;
  if (!FOLDERS.includes(view)) throw badRequest(`view must be one of ${FOLDERS.join(', ')}.`);
  return c.json(await listThreads(c.env.DB, { mailboxIds, view, userId: currentUser(c).id, cursor: c.req.query('cursor'), limit: limitParam(c.req.query('limit')) }));
});

api.get('/threads/:id', requireScope('read'), async (c) => {
  const t = await assertThread(c.env.DB, currentUser(c), intParam(c, 'id'));
  assertKeyMailbox(c, t.mailboxId);
  const { thread, messages } = await getThread(c.env.DB, t.threadId);
  return c.json({ thread, messages });
});

api.post('/threads/actions', requireScope('modify'), async (c) => {
  const input = await body(c, apiThreadActionSchema);
  const allowed = (await keyMailboxes(c)).map((a) => a.mailboxId);
  const rows = allowed.length
    ? await all<{ id: number; mailbox_id: number }>(
        c.env.DB,
        `SELECT id, mailbox_id FROM threads WHERE id IN (${placeholders(input.threadIds.length)}) AND mailbox_id IN (${placeholders(allowed.length)})`,
        ...input.threadIds,
        ...allowed,
      )
    : [];
  await applyThreadAction(c.env, await loadSettings(c.env.DB), rows.map((r) => ({ id: r.id, mailboxId: r.mailbox_id })), input.action, {
    labelId: input.labelId,
    until: input.until,
  });
  return c.json({ ok: true, count: rows.length });
});

api.get('/search', requireScope('read'), async (c) => {
  const q = (c.req.query('q') ?? '').slice(0, 500);
  if (!q.trim()) throw badRequest('Add a search query as ?q=.');
  const mailboxIds = await mailboxScope(c, c.req.query('mailbox'));
  return c.json({ threads: await searchThreads(c.env.DB, mailboxIds, q, limitParam(c.req.query('limit'))) });
});

interface MessageListRow {
  id: number;
  thread_id: number;
  mailbox_id: number;
  folder: string;
  direction: 'in' | 'out';
  status: string;
  message_id: string | null;
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  snippet: string;
  sent_at: number;
  created_at: number;
  is_read: number;
  has_attachments: number;
  seq: number;
}

// Messages in the order they became visible (received, or sent), for polling: pass the previous
// response's nextCursor to get only what came after it. The cursor is the message sequence number
// (see migration 0005), which follows commit order, so overlapping deliveries can't be skipped.
api.get('/messages', requireScope('read'), async (c) => {
  const db = c.env.DB;
  const mailboxIds = await mailboxScope(c, c.req.query('mailbox'));
  const direction = c.req.query('direction');
  if (direction && direction !== 'in' && direction !== 'out') throw badRequest('direction must be in or out.');
  const folder = c.req.query('folder');
  if (folder && !['inbox', 'archive', 'spam', 'trash'].includes(folder)) throw badRequest('folder must be inbox, archive, spam or trash.');
  const limit = limitParam(c.req.query('limit'));
  let after = 0;
  if (c.req.query('cursor') !== undefined) {
    after = Number(c.req.query('cursor'));
    if (!Number.isSafeInteger(after) || after < 0) throw badRequest('Invalid cursor: pass nextCursor from the previous response.');
  } else if (c.req.query('since') !== undefined) {
    const since = Number(c.req.query('since'));
    if (!Number.isFinite(since)) throw badRequest('since must be milliseconds since the epoch.');
    after = await seqBefore(db, mailboxIds, since);
  }
  if (!mailboxIds.length) return c.json({ messages: [], nextCursor: String(after) });
  const rows = await all<MessageListRow>(
    db,
    `SELECT g.id, g.thread_id, g.mailbox_id, t.folder, g.direction, g.status, g.message_id, g.from_addr, g.from_name, g.to_addrs, g.cc_addrs, g.subject, g.snippet,
            g.sent_at, g.created_at, g.is_read, g.has_attachments, g.seq
       FROM messages g JOIN threads t ON t.id = g.thread_id
      WHERE g.mailbox_id IN (${placeholders(mailboxIds.length)}) AND g.seq > ?
        ${direction ? 'AND g.direction = ?' : ''} ${folder ? 'AND t.folder = ?' : ''}
      ORDER BY g.seq LIMIT ?`,
    ...mailboxIds,
    after,
    ...(direction ? [direction] : []),
    ...(folder ? [folder] : []),
    limit,
  );
  return c.json({
    messages: rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      mailboxId: r.mailbox_id,
      folder: r.folder,
      direction: r.direction,
      status: r.status,
      messageId: r.message_id,
      from: { name: r.from_name, address: r.from_addr },
      to: parseJson<Address[]>(r.to_addrs, []),
      cc: parseJson<Address[]>(r.cc_addrs, []),
      subject: r.subject,
      snippet: r.snippet,
      sentAt: r.sent_at,
      receivedAt: r.created_at,
      isRead: !!r.is_read,
      hasAttachments: !!r.has_attachments,
    })),
    // Always a cursor, so a poller can keep asking from where it stopped.
    nextCursor: String(rows.at(-1)?.seq ?? after),
  });
});

// The sequence number just before the first message created at or after `since`; with none, the
// latest number, so polling starts from now.
async function seqBefore(db: D1Database, mailboxIds: number[], since: number): Promise<number> {
  const first = mailboxIds.length
    ? await db
        .prepare(`SELECT MIN(seq) AS seq FROM messages WHERE mailbox_id IN (${placeholders(mailboxIds.length)}) AND created_at >= ? AND seq IS NOT NULL`)
        .bind(...mailboxIds, since)
        .first<{ seq: number | null }>()
    : null;
  if (first?.seq) return first.seq - 1;
  return (await db.prepare("SELECT value FROM sequences WHERE name = 'messages'").first<{ value: number }>())?.value ?? 0;
}

api.get('/messages/:id', requireScope('read'), async (c) => {
  const m = await assertMessage(c.env.DB, currentUser(c), intParam(c, 'id'));
  assertKeyMailbox(c, m.mailboxId);
  const [{ thread, messages }, row] = await Promise.all([
    getThread(c.env.DB, m.threadId, m.messageId),
    first<{ created_at: number; has_attachments: number }>(c.env.DB, 'SELECT created_at, has_attachments FROM messages WHERE id = ?', m.messageId),
  ]);
  const detail = messages[0];
  if (!detail || !row) throw notFound('Message not found.');
  // getThread leaves large HTML bodies for a second request; the API returns them whole.
  const html = detail.htmlDeferred ? (await messageBody(c.env.DB, m.messageId)).html : detail.html;
  const { htmlDeferred: _deferred, ...rest } = detail;
  return c.json({ ...rest, html, threadId: m.threadId, mailboxId: m.mailboxId, folder: thread.folder, receivedAt: row.created_at, hasAttachments: !!row.has_attachments });
});

// Opens and clicks of a sent message, newest first.
api.get('/messages/:id/events', requireScope('read'), async (c) => {
  const m = await assertMessage(c.env.DB, currentUser(c), intParam(c, 'id'));
  assertKeyMailbox(c, m.mailboxId);
  return c.json(await trackingEvents(c.env.DB, m.messageId));
});

api.get('/attachments/:id', requireScope('read'), async (c) => {
  const a = await first<{ id: number; message_id: number; filename: string; content_type: string; stored: number }>(
    c.env.DB,
    'SELECT id, message_id, filename, content_type, stored FROM attachments WHERE id = ?',
    intParam(c, 'id'),
  );
  if (!a) throw notFound('Attachment not found.');
  const m = await assertMessage(c.env.DB, currentUser(c), a.message_id);
  assertKeyMailbox(c, m.mailboxId);
  if (!a.stored) throw new HttpError(404, 'not_stored', 'This attachment was not stored. Enable attachments (R2) to keep them for new mail.');
  const bytes = await attachmentBytes(c.env, await loadSettings(c.env.DB), a.id);
  if (!bytes) throw notFound('The attachment data is no longer available.');
  return new Response(bytes, {
    headers: {
      'Content-Type': MIME_TYPE.test(a.content_type) ? a.content_type : 'application/octet-stream',
      'Content-Disposition': contentDisposition('attachment', a.filename || 'attachment'),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
});

function decodeBase64(content: string, filename: string): Uint8Array {
  const clean = content.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw badRequest(`attachments: ${filename} is not valid base64.`);
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

api.post('/messages', requireScope('send'), async (c) => {
  const user = currentUser(c);
  const key = currentKey(c);
  const db = c.env.DB;
  const input = await body(c, apiSendSchema);
  const idemKey = c.req.header('idempotency-key')?.trim() || null;
  if (idemKey && idemKey.length > 200) throw badRequest('Idempotency-Key can be at most 200 characters.');
  const sendAt = typeof input.sendAt === 'string' ? Date.parse(input.sendAt) : (input.sendAt ?? null);
  if (idemKey) {
    const done = await first<{ message_id: number }>(db, 'SELECT message_id FROM api_idempotency WHERE key_id = ? AND idem_key = ?', key.id, idemKey);
    if (done) return c.json(await replay(c.env, user, key.id, idemKey));
  }

  const from = await first<{ mailbox_id: number }>(db, 'SELECT mailbox_id FROM addresses WHERE address = ?', normalizeAddress(input.from));
  const allowed = from ? (await keyMailboxes(c)).find((a) => a.mailboxId === from.mailbox_id) : null;
  if (!from || !allowed) throw badRequest(`${input.from} is not an address of a mailbox this key can use.`, 'bad_from');
  if (!allowed.canSend) throw new HttpError(403, 'forbidden', 'You can read this mailbox but not send from it.');
  if (input.inReplyTo) {
    const parent = await first<{ mailbox_id: number }>(db, 'SELECT mailbox_id FROM messages WHERE id = ?', input.inReplyTo);
    if (!parent || parent.mailbox_id !== from.mailbox_id) throw badRequest('inReplyTo must be a message in the same mailbox as from.');
  }
  // Attachments go through the same R2 uploads as the web composer.
  const uploadIds: string[] = [];
  if (input.attachments.length) {
    const store = await r2Store(c.env, await loadSettings(db));
    if (!store) throw new HttpError(409, 'attachments_disabled', 'Attachments are off. An admin can enable them in Admin > Integrations > Attachments.');
    const files = input.attachments.map((a) => ({ ...a, bytes: decodeBase64(a.content, a.filename) }));
    for (const f of files) if (f.bytes.byteLength > MAX_ATTACHMENT) throw badRequest(`attachments: ${f.filename} is larger than 20 MB.`);
    if (files.reduce((n, f) => n + f.bytes.byteLength, 0) > MAX_ATTACHMENTS_TOTAL) throw badRequest('attachments: at most 25 MB in total.');
    for (const f of files) {
      const id = crypto.randomUUID();
      const filename = f.filename.replace(/[\r\n"\\/]/g, '_');
      const type = f.contentType.split(';')[0].trim().toLowerCase();
      const contentType = MIME_TYPE.test(type) ? type : 'application/octet-stream';
      await store.put(`uploads/${id}`, f.bytes, contentType);
      await run(
        db,
        'INSERT INTO uploads (id, user_id, storage_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        user.id,
        `uploads/${id}`,
        filename,
        contentType,
        f.bytes.byteLength,
        Date.now(),
      );
      uploadIds.push(id);
    }
  }

  const draft = await saveDraft(c.env, user, {
    mailboxId: from.mailbox_id,
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html ?? '',
    text: input.text,
    replyToMessageId: input.inReplyTo ?? null,
    uploadIds,
  });
  if (idemKey) {
    // Two requests racing with the same key: the second gives up its draft and returns the first.
    const claimed = await run(
      db,
      'INSERT OR IGNORE INTO api_idempotency (key_id, idem_key, message_id, send_at, created_at) VALUES (?, ?, ?, ?, ?)',
      key.id,
      idemKey,
      draft.id,
      sendAt,
      Date.now(),
    );
    if (!claimed.meta.changes) {
      await deleteDraft(c.env, user, draft.id);
      return c.json(await replay(c.env, user, key.id, idemKey));
    }
    await queueOnce(c.env, user, key.id, idemKey);
  } else await sendDraft(c.env, user, draft.id, sendAt);
  return c.json(await sendResult(db, draft.id, false), 201);
});

// Hands an idempotent request's message to the send pipeline, once: whoever flips `queued` sends,
// with the first request's sendAt. If that fails before the message is queued, the flag is cleared
// so a retry can finish it.
async function queueOnce(env: Env, user: SessionUser, keyId: number, idemKey: string): Promise<void> {
  const row = await env.DB.prepare('UPDATE api_idempotency SET queued = 1 WHERE key_id = ? AND idem_key = ? AND queued = 0 RETURNING message_id, send_at')
    .bind(keyId, idemKey)
    .first<{ message_id: number; send_at: number | null }>();
  if (!row) return;
  try {
    await sendDraft(env, user, row.message_id, row.send_at);
  } catch (e) {
    await env.DB.prepare('UPDATE api_idempotency SET queued = 0 WHERE key_id = ? AND idem_key = ?').bind(keyId, idemKey).run();
    throw e;
  }
}

// A retry with the same Idempotency-Key returns the first message. If the first request stopped
// between saving the message and queueing it (an error, or the Worker stopping), the retry queues
// it; a message that was queued and later cancelled back to drafts is left alone.
async function replay(env: Env, user: SessionUser, keyId: number, idemKey: string) {
  const row = await first<{ message_id: number }>(env.DB, 'SELECT message_id FROM api_idempotency WHERE key_id = ? AND idem_key = ?', keyId, idemKey);
  if (!row) throw notFound('Message not found.');
  await queueOnce(env, user, keyId, idemKey);
  return sendResult(env.DB, row.message_id, true);
}

async function sendResult(db: D1Database, id: number, replayed: boolean) {
  const m = await first<{ thread_id: number; status: string; message_id: string | null; error: string | null; send_at: number | null }>(
    db,
    'SELECT thread_id, status, message_id, error, send_at FROM messages WHERE id = ?',
    id,
  );
  if (!m) throw notFound('Message not found.');
  // A failed send that will be retried has send_at set.
  return { id, threadId: m.thread_id, status: m.status, messageId: m.message_id, error: m.error, retryAt: m.status === 'failed' ? m.send_at : null, sendAt: m.status === 'scheduled' ? m.send_at : null, replayed };
}

// Cancels a scheduled send; the message goes back to drafts.
api.post('/messages/:id/cancel', requireScope('send'), async (c) => {
  const m = await assertMessage(c.env.DB, currentUser(c), intParam(c, 'id'));
  assertKeyMailbox(c, m.mailboxId);
  await cancelScheduled(c.env, currentUser(c), m.messageId);
  return c.json({ ok: true });
});
