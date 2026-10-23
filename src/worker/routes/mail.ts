// Mail API for signed-in users: mailboxes, conversations, messages, attachments, search, labels,
// filters and per-mailbox settings. Access is always checked through mailbox membership.
import { Hono, type Context } from 'hono';
import type { AppBindings } from '../types';
import { body, intParam } from '../lib/validate';
import {
  blockSchema,
  filterSchema,
  labelSchema,
  noteSchema,
  threadActionSchema,
  updateMailboxSchema,
} from '../../shared/schemas';
import { all, first, placeholders, run } from '../db/db';
import { loadSettings } from '../db/settings';
import { accessibleMailboxes, assertMailbox, assertMessage, assertThread } from '../auth/access';
import { currentUser } from '../auth/middleware';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { parseJson } from '../lib/json';
import { FOLDERS, type Folder } from '../../shared/constants';
import { applyThreadAction, getThread, listThreads, messageBody, searchThreads, unreadCounts } from '../services/threads';
import { getMailbox, mailboxSettings, updateMailbox, bumpState } from '../services/mailboxes';
import { attachmentBytes } from '../services/send';
import { contentDisposition, isInlineSafe } from '../mail/decode';
import { storeFor } from '../storage';
import { buildMime } from '../mail/mime';
import { ingest } from '../services/inbound';
import { sendSystemReply } from '../services/send';
import { isValidAddress, normalizeAddress, singleLine } from '../mail/address';

export const mail = new Hono<AppBindings>();

mail.get('/mailboxes', async (c) => {
  const user = currentUser(c);
  const access = await accessibleMailboxes(c.env.DB, user);
  if (!access.length) return c.json([]);
  const ids = access.map((a) => a.mailboxId);
  const [boxes, addresses, labels, unread] = await Promise.all([
    all<{ id: number; address: string; display_name: string; kind: string; signature: string; state: number }>(
      c.env.DB,
      `SELECT id, address, display_name, kind, signature, state FROM mailboxes WHERE id IN (${placeholders(ids.length)}) ORDER BY address`,
      ...ids,
    ),
    all<{ id: number; address: string; mailbox_id: number; is_primary: number; display_name: string | null }>(
      c.env.DB,
      `SELECT id, address, mailbox_id, is_primary, display_name FROM addresses WHERE mailbox_id IN (${placeholders(ids.length)}) ORDER BY is_primary DESC, address`,
      ...ids,
    ),
    all<{ id: number; mailbox_id: number; name: string; color: string }>(
      c.env.DB,
      `SELECT id, mailbox_id, name, color FROM labels WHERE mailbox_id IN (${placeholders(ids.length)}) ORDER BY name`,
      ...ids,
    ),
    unreadCounts(c.env.DB, ids),
  ]);
  return c.json(
    boxes.map((b) => ({
      id: b.id,
      address: b.address,
      displayName: b.display_name,
      kind: b.kind,
      canSend: access.find((a) => a.mailboxId === b.id)?.canSend ?? false,
      signature: b.signature,
      state: b.state,
      addresses: addresses.filter((a) => a.mailbox_id === b.id).map((a) => ({ id: a.id, address: a.address, isPrimary: !!a.is_primary, displayName: a.display_name })),
      labels: labels.filter((l) => l.mailbox_id === b.id).map((l) => ({ id: l.id, name: l.name, color: l.color })),
      unread: unread[b.id] ?? {},
    })),
  );
});

// Polling endpoint: one tiny row per mailbox. Clients refetch lists only when a state changes.
mail.get('/sync', async (c) => {
  const user = currentUser(c);
  const rows = await all<{ id: number; state: number }>(
    c.env.DB,
    'SELECT m.id, m.state FROM mailboxes m JOIN mailbox_members mm ON mm.mailbox_id = m.id WHERE mm.user_id = ?',
    user.id,
  );
  return c.json({ states: Object.fromEntries(rows.map((r) => [r.id, r.state])) });
});

async function mailboxScope(c: Context<AppBindings>, param: string | undefined): Promise<number[]> {
  const user = currentUser(c);
  const access = await accessibleMailboxes(c.env.DB, user);
  if (!param || param === 'all') return access.map((a) => a.mailboxId);
  const id = Number(param);
  if (!access.some((a) => a.mailboxId === id)) throw notFound('Mailbox not found.');
  return [id];
}

mail.get('/threads', async (c) => {
  const mailboxIds = await mailboxScope(c, c.req.query('mailbox'));
  const view = (c.req.query('view') ?? 'inbox') as Folder | 'label' | 'scheduled' | 'assigned';
  if (![...FOLDERS, 'label', 'scheduled', 'assigned'].includes(view)) throw badRequest('Unknown view.');
  const labelId = c.req.query('label') ? Number(c.req.query('label')) : undefined;
  return c.json(await listThreads(c.env.DB, { mailboxIds, view, labelId, userId: currentUser(c).id, cursor: c.req.query('cursor') }));
});

mail.get('/threads/:id', async (c) => {
  const user = currentUser(c);
  const t = await assertThread(c.env.DB, user, intParam(c, 'id'));
  const data = await getThread(c.env.DB, t.threadId);
  return c.json({ ...data, canSend: t.canSend });
});

mail.post('/threads/actions', async (c) => {
  const user = currentUser(c);
  const input = await body(c, threadActionSchema);
  const rows = await all<{ id: number; mailbox_id: number }>(
    c.env.DB,
    `SELECT t.id, t.mailbox_id FROM threads t JOIN mailbox_members mm ON mm.mailbox_id = t.mailbox_id AND mm.user_id = ? WHERE t.id IN (${placeholders(input.threadIds.length)})`,
    user.id,
    ...input.threadIds,
  );
  if (input.action === 'assign' && input.userId) {
    const member = await all<{ mailbox_id: number }>(
      c.env.DB,
      `SELECT mailbox_id FROM mailbox_members WHERE user_id = ? AND mailbox_id IN (${placeholders(rows.length || 1)})`,
      input.userId,
      ...(rows.length ? rows.map((r) => r.mailbox_id) : [0]),
    );
    if (member.length !== new Set(rows.map((r) => r.mailbox_id)).size) throw badRequest('That person is not a member of this mailbox.');
  }
  await applyThreadAction(c.env, await loadSettings(c.env.DB), rows.map((r) => ({ id: r.id, mailboxId: r.mailbox_id })), input.action, {
    labelId: input.labelId,
    until: input.until,
    userId: input.userId,
  });
  return c.json({ ok: true, count: rows.length });
});

mail.post('/threads/:id/notes', async (c) => {
  const user = currentUser(c);
  const t = await assertThread(c.env.DB, user, intParam(c, 'id'));
  const { body: text } = await body(c, noteSchema);
  const id = newId();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO thread_notes (id, thread_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, t.threadId, user.id, text, Date.now()),
    bumpState(c.env.DB, t.mailboxId),
  ]);
  return c.json({ id });
});

mail.delete('/notes/:id', async (c) => {
  const user = currentUser(c);
  const note = await first<{ thread_id: number; user_id: number }>(c.env.DB, 'SELECT thread_id, user_id FROM thread_notes WHERE id = ?', intParam(c, 'id'));
  if (!note) throw notFound();
  const t = await assertThread(c.env.DB, user, note.thread_id);
  if (note.user_id !== user.id && user.role === 'member') throw forbidden('You can only delete your own notes.');
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM thread_notes WHERE id = ?').bind(intParam(c, 'id')), bumpState(c.env.DB, t.mailboxId)]);
  return c.json({ ok: true });
});

mail.get('/messages/:id/body', async (c) => {
  const m = await assertMessage(c.env.DB, currentUser(c), intParam(c, 'id'));
  return c.json(await messageBody(c.env.DB, m.messageId));
});

// The original .eml when it was kept; otherwise rebuilt from the stored parts.
mail.get('/messages/:id/raw', async (c) => {
  const m = await assertMessage(c.env.DB, currentUser(c), intParam(c, 'id'));
  const row = await first<{ raw_key: string | null; raw_store: 'd1' | 'r2' | null; subject: string; from_addr: string; from_name: string; to_addrs: string; cc_addrs: string; message_id: string | null; in_reply_to: string | null; refs: string | null; sent_at: number }>(
    c.env.DB,
    'SELECT raw_key, raw_store, subject, from_addr, from_name, to_addrs, cc_addrs, message_id, in_reply_to, refs, sent_at FROM messages WHERE id = ?',
    m.messageId,
  );
  if (!row) throw notFound();
  const name = `${(row.subject || 'message').replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'message'}.eml`;
  if (row.raw_key && row.raw_store) {
    const store = await storeFor(c.env, await loadSettings(c.env.DB), row.raw_store);
    const bytes = await store?.get(row.raw_key);
    if (bytes) {
      return new Response(bytes, { headers: { 'Content-Type': 'message/rfc822', 'Content-Disposition': contentDisposition('attachment', name), 'Cache-Control': 'private, no-store' } });
    }
  }
  const b = await messageBody(c.env.DB, m.messageId);
  const raw = buildMime({
    from: { name: row.from_name, address: row.from_addr },
    to: parseJson(row.to_addrs, []),
    cc: parseJson(row.cc_addrs, []),
    subject: row.subject,
    text: b.text,
    html: b.html,
    messageId: row.message_id ?? `${m.messageId}@openinbox.invalid`,
    inReplyTo: row.in_reply_to,
    references: (row.refs ?? '').split(' ').filter(Boolean),
    date: new Date(row.sent_at),
    headers: { 'X-OpenInbox-Reconstructed': 'yes (the original was too large to keep in text-only mode)' },
  });
  return new Response(raw, { headers: { 'Content-Type': 'message/rfc822', 'Content-Disposition': contentDisposition('attachment', name), 'Cache-Control': 'private, no-store' } });
});

mail.get('/attachments/:id', async (c) => {
  const user = currentUser(c);
  const a = await first<{ id: number; message_id: number; filename: string; content_type: string; stored: number }>(
    c.env.DB,
    'SELECT id, message_id, filename, content_type, stored FROM attachments WHERE id = ?',
    intParam(c, 'id'),
  );
  if (!a) throw notFound('Attachment not found.');
  await assertMessage(c.env.DB, user, a.message_id);
  if (!a.stored) throw new HttpError(404, 'not_stored', 'This attachment was not stored. Enable attachments (R2) to keep them for new mail.');
  const bytes = await attachmentBytes(c.env, await loadSettings(c.env.DB), a.id);
  if (!bytes) throw notFound('The attachment data is no longer available.');
  const inline = c.req.query('inline') === '1' && isInlineSafe(a.content_type);
  return new Response(bytes, {
    headers: {
      'Content-Type': inline ? a.content_type : 'application/octet-stream',
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', a.filename || 'attachment'),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

mail.post('/messages/:id/unsubscribe', async (c) => {
  const user = currentUser(c);
  const m = await assertMessage(c.env.DB, user, intParam(c, 'id'));
  const row = await first<{ list_unsubscribe: string | null; thread_id: number; delivered_to: string | null; message_id: string | null; refs: string | null }>(
    c.env.DB,
    'SELECT list_unsubscribe, thread_id, delivered_to, message_id, refs FROM messages WHERE id = ?',
    m.messageId,
  );
  const lu = parseJson<{ url?: string; mailto?: string; oneClick: boolean } | null>(row?.list_unsubscribe, null);
  if (!lu) throw badRequest('This message has no unsubscribe option.');
  if (lu.oneClick && lu.url) {
    const res = await fetch(lu.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click', redirect: 'follow' });
    return c.json({ ok: res.ok, method: 'one-click' });
  }
  if (lu.mailto && m.canSend) {
    // The mailto comes from the sender: its address must be a plain address (a decoded CR/LF
    // would inject SMTP commands), and its subject and body stay short.
    const url = new URL(lu.mailto);
    let to = '';
    try {
      to = normalizeAddress(decodeURIComponent(url.pathname));
    } catch {
      // malformed percent-escape
    }
    if (!isValidAddress(to)) throw badRequest('This message has an invalid unsubscribe address.');
    const box = await getMailbox(c.env.DB, m.mailboxId);
    await sendSystemReply(c.env, await loadSettings(c.env.DB), {
      mailboxId: m.mailboxId,
      threadId: row!.thread_id,
      from: { name: box.display_name, address: box.address },
      to: { name: '', address: to },
      subject: singleLine(url.searchParams.get('subject') ?? '').trim().slice(0, 200) || 'unsubscribe',
      text: (url.searchParams.get('body') ?? '').slice(0, 500) || 'unsubscribe',
      inReplyTo: null,
      references: [],
    });
    return c.json({ ok: true, method: 'mailto' });
  }
  return c.json({ ok: false, method: 'link', url: lu.url ?? null });
});

mail.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').slice(0, 500);
  if (!q.trim()) return c.json({ threads: [] });
  const mailboxIds = await mailboxScope(c, c.req.query('mailbox'));
  return c.json({ threads: await searchThreads(c.env.DB, mailboxIds, q) });
});

mail.get('/contacts', async (c) => {
  const user = currentUser(c);
  const ids = (await accessibleMailboxes(c.env.DB, user)).map((a) => a.mailboxId);
  const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 100);
  if (!ids.length || !q) return c.json([]);
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = await all<{ address: string; name: string }>(
    c.env.DB,
    `SELECT address, MAX(name) AS name FROM contacts WHERE mailbox_id IN (${placeholders(ids.length)}) AND (address LIKE ? OR name LIKE ?)
      GROUP BY address ORDER BY MAX(use_count) DESC, MAX(last_used_at) DESC LIMIT 8`,
    ...ids,
    like,
    like,
  );
  return c.json(rows);
});

// Labels -------------------------------------------------------------------------------------------

mail.post('/mailboxes/:id/labels', async (c) => {
  const mailboxId = intParam(c, 'id');
  await assertMailbox(c.env.DB, currentUser(c), mailboxId);
  const input = await body(c, labelSchema);
  const id = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO labels (id, mailbox_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, mailboxId, input.name, input.color, Date.now()),
      bumpState(c.env.DB, mailboxId),
    ]);
  } catch {
    throw badRequest(`A label named "${input.name}" already exists.`);
  }
  return c.json({ id });
});

async function labelOwner(c: Context<AppBindings>, id: number): Promise<number> {
  const label = await first<{ mailbox_id: number }>(c.env.DB, 'SELECT mailbox_id FROM labels WHERE id = ?', id);
  if (!label) throw notFound('Label not found.');
  await assertMailbox(c.env.DB, currentUser(c), label.mailbox_id);
  return label.mailbox_id;
}

mail.patch('/labels/:id', async (c) => {
  const id = intParam(c, 'id');
  const mailboxId = await labelOwner(c, id);
  const input = await body(c, labelSchema);
  await c.env.DB.batch([c.env.DB.prepare('UPDATE labels SET name = ?, color = ? WHERE id = ?').bind(input.name, input.color, id), bumpState(c.env.DB, mailboxId)]);
  return c.json({ ok: true });
});

mail.delete('/labels/:id', async (c) => {
  const id = intParam(c, 'id');
  const mailboxId = await labelOwner(c, id);
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM labels WHERE id = ?').bind(id), bumpState(c.env.DB, mailboxId)]);
  return c.json({ ok: true });
});

// Filters ------------------------------------------------------------------------------------------

mail.get('/mailboxes/:id/filters', async (c) => {
  const mailboxId = intParam(c, 'id');
  await assertMailbox(c.env.DB, currentUser(c), mailboxId);
  const rows = await all<{ id: number; name: string; conditions: string; actions: string; position: number; enabled: number }>(
    c.env.DB,
    'SELECT id, name, conditions, actions, position, enabled FROM filters WHERE mailbox_id = ? ORDER BY position, id',
    mailboxId,
  );
  return c.json(rows.map((r) => ({ id: r.id, name: r.name, conditions: parseJson(r.conditions, {}), actions: parseJson(r.actions, {}), position: r.position, enabled: !!r.enabled })));
});

mail.post('/mailboxes/:id/filters', async (c) => {
  const mailboxId = intParam(c, 'id');
  await assertMailbox(c.env.DB, currentUser(c), mailboxId);
  const f = await body(c, filterSchema);
  const id = newId();
  const max = await first<{ p: number | null }>(c.env.DB, 'SELECT MAX(position) AS p FROM filters WHERE mailbox_id = ?', mailboxId);
  await run(
    c.env.DB,
    'INSERT INTO filters (id, mailbox_id, name, conditions, actions, position, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    mailboxId,
    f.name,
    JSON.stringify(f.conditions),
    JSON.stringify(f.actions),
    (max?.p ?? 0) + 1,
    f.enabled ? 1 : 0,
    Date.now(),
  );
  return c.json({ id });
});

async function filterOwner(c: Context<AppBindings>, id: number): Promise<number> {
  const f = await first<{ mailbox_id: number }>(c.env.DB, 'SELECT mailbox_id FROM filters WHERE id = ?', id);
  if (!f) throw notFound('Filter not found.');
  await assertMailbox(c.env.DB, currentUser(c), f.mailbox_id);
  return f.mailbox_id;
}

mail.put('/filters/:id', async (c) => {
  const id = intParam(c, 'id');
  await filterOwner(c, id);
  const f = await body(c, filterSchema);
  await run(c.env.DB, 'UPDATE filters SET name = ?, conditions = ?, actions = ?, enabled = ? WHERE id = ?', f.name, JSON.stringify(f.conditions), JSON.stringify(f.actions), f.enabled ? 1 : 0, id);
  return c.json({ ok: true });
});

mail.delete('/filters/:id', async (c) => {
  const id = intParam(c, 'id');
  await filterOwner(c, id);
  await run(c.env.DB, 'DELETE FROM filters WHERE id = ?', id);
  return c.json({ ok: true });
});

// Members of a mailbox, for assigning conversations in shared inboxes.
mail.get('/mailboxes/:id/members', async (c) => {
  const mailboxId = intParam(c, 'id');
  await assertMailbox(c.env.DB, currentUser(c), mailboxId);
  const members = await all<{ user_id: number; name: string; email: string }>(
    c.env.DB,
    "SELECT mm.user_id, u.name, u.email FROM mailbox_members mm JOIN users u ON u.id = mm.user_id WHERE mm.mailbox_id = ? AND u.status = 'active' ORDER BY u.name",
    mailboxId,
  );
  return c.json({ members: members.map((m) => ({ userId: m.user_id, name: m.name, email: m.email })) });
});

// Per-mailbox settings members can change: signature, auto-reply, forwarding -------------------

mail.get('/mailboxes/:id/settings', async (c) => {
  const mailboxId = intParam(c, 'id');
  await assertMailbox(c.env.DB, currentUser(c), mailboxId);
  const m = await getMailbox(c.env.DB, mailboxId);
  const destinations = await all<{ address: string; verified_at: number | null }>(c.env.DB, 'SELECT address, verified_at FROM forward_destinations ORDER BY address');
  return c.json({ ...mailboxSettings(m), displayName: m.display_name, destinations: destinations.map((d) => ({ address: d.address, verified: !!d.verified_at })) });
});

mail.patch('/mailboxes/:id/settings', async (c) => {
  const user = currentUser(c);
  const mailboxId = intParam(c, 'id');
  await assertMailbox(c.env.DB, user, mailboxId, true);
  const input = await body(c, updateMailboxSchema.omit({ kind: true }));
  if (input.forwardTo?.length) {
    const known = await all<{ address: string }>(
      c.env.DB,
      `SELECT address FROM forward_destinations WHERE address IN (${placeholders(input.forwardTo.length)})`,
      ...input.forwardTo.map((a) => a.toLowerCase()),
    );
    if (known.length !== input.forwardTo.length) throw badRequest('Forwarding addresses must be added and verified by an admin first (Admin > Settings > Forwarding).');
  }
  await updateMailbox(c.env.DB, mailboxId, { ...input, forwardTo: input.forwardTo?.map((a) => a.toLowerCase()) });
  await run(c.env.DB, 'UPDATE mailboxes SET state = state + 1 WHERE id = ?', mailboxId);
  return c.json({ ok: true });
});

mail.post('/blocked', async (c) => {
  const user = currentUser(c);
  const input = await body(c, blockSchema);
  if (input.mailboxId) await assertMailbox(c.env.DB, user, input.mailboxId);
  else if (user.role === 'member') throw forbidden('Only admins can block senders for every mailbox.');
  const pattern = input.pattern.toLowerCase();
  if (!/^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(pattern)) throw badRequest('Enter an address or @domain.');
  await run(c.env.DB, 'INSERT INTO blocked_senders (id, mailbox_id, pattern, created_at) VALUES (?, ?, ?, ?)', newId(), input.mailboxId ?? null, pattern, Date.now());
  return c.json({ ok: true });
});

// Import: one .eml per request (the web app sends files one by one).
mail.post('/mailboxes/:id/import', async (c) => {
  const user = currentUser(c);
  const mailboxId = intParam(c, 'id');
  await assertMailbox(c.env.DB, user, mailboxId);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.byteLength) throw badRequest('Empty file.');
  if (bytes.byteLength > 25 * 1024 * 1024) throw badRequest('Files over 25 MB cannot be imported.');
  const box = await getMailbox(c.env.DB, mailboxId);
  const settings = await loadSettings(c.env.DB);
  const r = await ingest({ env: c.env, settings }, bytes, {
    rcpt: box.address,
    envelopeFrom: '',
    recipient: { mailboxId, address: box.address, via: 'exact' },
    folderOverride: c.req.query('folder') === 'inbox' ? 'inbox' : 'archive',
    markRead: true,
  });
  return c.json(r);
});

// Export: message ids for the web app to download one by one and zip in the browser.
mail.get('/mailboxes/:id/export', async (c) => {
  const mailboxId = intParam(c, 'id');
  await assertMailbox(c.env.DB, currentUser(c), mailboxId);
  const after = Number(c.req.query('after') ?? 0);
  const rows = await all<{ id: number; subject: string; sent_at: number }>(
    c.env.DB,
    "SELECT id, subject, sent_at FROM messages WHERE mailbox_id = ? AND status NOT IN ('draft') AND id > ? ORDER BY id LIMIT 500",
    mailboxId,
    after,
  );
  return c.json({ messages: rows, next: rows.length === 500 ? rows[rows.length - 1].id : null });
});
