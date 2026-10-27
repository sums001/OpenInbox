// Conversation lists, thread detail and thread actions. List queries are shaped so each one reads
// about one page of rows from an index (the free plan allows 5M rows read per day).
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { all, first, placeholders } from '../db/db';
import { parseJson } from '../lib/json';
import { badRequest, notFound } from '../lib/errors';
import { storeFor } from '../storage';
import type { Address } from '../mail/address';
import { THREAD_FOLDERS, type Folder } from '../../shared/constants';
import { ftsExpression, hasTextQuery, parseSearch } from '../../shared/search';
import { bumpState } from './mailboxes';

export interface ThreadRow {
  id: number;
  mailbox_id: number;
  folder: string;
  subject: string;
  snippet: string;
  participants: string;
  message_count: number;
  unread_count: number;
  draft_count: number;
  has_attachments: number;
  starred: number;
  last_message_at: number;
  last_sent_at: number | null;
  snoozed_until: number | null;
  assigned_to: number | null;
  updated_at: number;
}

export interface ThreadSummary {
  id: number;
  mailboxId: number;
  folder: string;
  subject: string;
  snippet: string;
  participants: Address[];
  messageCount: number;
  unreadCount: number;
  draftCount: number;
  hasAttachments: boolean;
  starred: boolean;
  lastMessageAt: number;
  lastSentAt: number | null;
  snoozedUntil: number | null;
  assignedTo: number | null;
  labels: number[];
}

const COLUMNS =
  'id, mailbox_id, folder, subject, snippet, participants, message_count, unread_count, draft_count, has_attachments, starred, last_message_at, last_sent_at, snoozed_until, assigned_to, updated_at';

function summary(r: ThreadRow, labels: number[]): ThreadSummary {
  return {
    id: r.id,
    mailboxId: r.mailbox_id,
    folder: r.folder,
    subject: r.subject,
    snippet: r.snippet,
    participants: parseJson(r.participants, []),
    messageCount: r.message_count,
    unreadCount: r.unread_count,
    draftCount: r.draft_count,
    hasAttachments: !!r.has_attachments,
    starred: !!r.starred,
    lastMessageAt: r.last_message_at,
    lastSentAt: r.last_sent_at,
    snoozedUntil: r.snoozed_until,
    assignedTo: r.assigned_to,
    labels,
  };
}

async function withLabels(db: D1Database, rows: ThreadRow[]): Promise<ThreadSummary[]> {
  if (!rows.length) return [];
  const links = await all<{ thread_id: number; label_id: number }>(
    db,
    `SELECT thread_id, label_id FROM thread_labels WHERE thread_id IN (${placeholders(rows.length)})`,
    ...rows.map((r) => r.id),
  );
  return rows.map((r) => summary(r, links.filter((l) => l.thread_id === r.id).map((l) => l.label_id)));
}

export interface ListParams {
  mailboxIds: number[];
  view: Folder | 'label' | 'scheduled' | 'assigned';
  labelId?: number;
  userId?: number;
  cursor?: string | null;
  limit?: number;
}

// The per-view filter and sort column. Each matches a (partial) index on threads.
function viewSql(view: ListParams['view']): { where: string; sort: string } {
  switch (view) {
    case 'inbox':
      return { where: "folder = 'inbox' AND snoozed_until IS NULL AND message_count > 0", sort: 'last_message_at' };
    case 'archive':
      return { where: "folder = 'archive' AND message_count > 0", sort: 'last_message_at' };
    case 'spam':
    case 'trash':
      return { where: `folder = '${view}'`, sort: 'last_message_at' };
    case 'sent':
      return { where: 'last_sent_at IS NOT NULL', sort: 'last_sent_at' };
    case 'drafts':
      return { where: 'draft_count > 0', sort: 'last_message_at' };
    case 'starred':
      return { where: "starred = 1 AND folder != 'trash'", sort: 'last_message_at' };
    case 'snoozed':
      return { where: 'snoozed_until IS NOT NULL', sort: 'snoozed_until' };
    case 'allmail':
      return { where: "folder NOT IN ('spam', 'trash')", sort: 'last_message_at' };
    default:
      return { where: '1', sort: 'last_message_at' };
  }
}

function decodeCursor(cursor: string | null | undefined): { t: number; id: number } | null {
  if (!cursor) return null;
  const [t, id] = cursor.split('.').map(Number);
  return Number.isFinite(t) && Number.isFinite(id) ? { t, id } : null;
}

export async function listThreads(db: D1Database, p: ListParams): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 100);
  if (!p.mailboxIds.length) return { threads: [], nextCursor: null };
  const cursor = decodeCursor(p.cursor);
  let rows: ThreadRow[];

  if (p.view === 'label') {
    if (!p.labelId) throw badRequest('Missing label.');
    rows = await all<ThreadRow>(
      db,
      `SELECT ${COLUMNS.split(', ').map((c) => `t.${c}`).join(', ')} FROM thread_labels tl JOIN threads t ON t.id = tl.thread_id
        WHERE tl.label_id = ? AND t.mailbox_id IN (${placeholders(p.mailboxIds.length)}) AND t.folder != 'trash'
          ${cursor ? 'AND (t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))' : ''}
        ORDER BY t.last_message_at DESC, t.id DESC LIMIT ?`,
      p.labelId,
      ...p.mailboxIds,
      ...(cursor ? [cursor.t, cursor.t, cursor.id] : []),
      limit + 1,
    );
  } else if (p.view === 'scheduled') {
    const ids = await all<{ thread_id: number }>(
      db,
      `SELECT DISTINCT thread_id FROM messages WHERE status = 'scheduled' AND mailbox_id IN (${placeholders(p.mailboxIds.length)}) LIMIT 200`,
      ...p.mailboxIds,
    );
    rows = ids.length
      ? await all<ThreadRow>(db, `SELECT ${COLUMNS} FROM threads WHERE id IN (${placeholders(ids.length)}) ORDER BY last_message_at DESC`, ...ids.map((i) => i.thread_id))
      : [];
  } else {
    const { where, sort } = p.view === 'assigned' ? { where: "assigned_to = ? AND folder != 'trash'", sort: 'last_message_at' } : viewSql(p.view);
    // One indexed subquery per mailbox, merged: each reads at most one page.
    const parts: string[] = [];
    const params: (number | string)[] = [];
    for (const m of p.mailboxIds) {
      parts.push(
        `SELECT * FROM (SELECT ${COLUMNS} FROM threads WHERE mailbox_id = ? AND ${where}
          ${cursor ? `AND (${sort} < ? OR (${sort} = ? AND id < ?))` : ''} ORDER BY ${sort} DESC, id DESC LIMIT ?)`,
      );
      params.push(m);
      if (p.view === 'assigned') params.push(p.userId ?? 0);
      if (cursor) params.push(cursor.t, cursor.t, cursor.id);
      params.push(limit + 1);
    }
    rows = await all<ThreadRow>(db, `${parts.join(' UNION ALL ')} ORDER BY ${sort} DESC, id DESC LIMIT ?`, ...params, limit + 1);
  }
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const sortKey = p.view === 'sent' ? last?.last_sent_at : p.view === 'snoozed' ? last?.snoozed_until : last?.last_message_at;
  return { threads: await withLabels(db, page), nextCursor: more && last ? `${sortKey}.${last.id}` : null };
}

export async function unreadCounts(db: D1Database, mailboxIds: number[]): Promise<Record<number, Record<string, number>>> {
  const out: Record<number, Record<string, number>> = {};
  if (!mailboxIds.length) return out;
  const rows = await all<{ mailbox_id: number; folder: string; n: number }>(
    db,
    `SELECT mailbox_id, folder, COUNT(*) AS n FROM threads WHERE mailbox_id IN (${placeholders(mailboxIds.length)}) AND unread_count > 0 AND snoozed_until IS NULL GROUP BY mailbox_id, folder`,
    ...mailboxIds,
  );
  const drafts = await all<{ mailbox_id: number; n: number }>(
    db,
    `SELECT mailbox_id, COUNT(*) AS n FROM threads WHERE mailbox_id IN (${placeholders(mailboxIds.length)}) AND draft_count > 0 GROUP BY mailbox_id`,
    ...mailboxIds,
  );
  for (const id of mailboxIds) out[id] = {};
  for (const r of rows) out[r.mailbox_id][r.folder] = r.n;
  for (const d of drafts) out[d.mailbox_id].drafts = d.n;
  return out;
}

export interface MessageDetail {
  id: number;
  direction: 'in' | 'out';
  status: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address | null;
  deliveredTo: string | null;
  subject: string;
  snippet: string;
  sentAt: number;
  isRead: boolean;
  text: string;
  html: string | null;
  htmlDeferred: boolean;
  truncated: boolean;
  rawAvailable: boolean;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  spamReason: string | null;
  listUnsubscribe: { url?: string; mailto?: string; oneClick: boolean } | null;
  error: string | null;
  sendAt: number | null;
  messageId: string | null;
  attachments: { id: number; filename: string; contentType: string; size: number; inline: boolean; contentId: string | null; stored: boolean }[];
}

interface MessageRow {
  id: number;
  direction: 'in' | 'out';
  status: string;
  message_id: string | null;
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc_addrs: string;
  bcc_addrs: string;
  reply_to: string | null;
  delivered_to: string | null;
  subject: string;
  snippet: string;
  sent_at: number;
  is_read: number;
  truncated: number;
  raw_key: string | null;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  spam_reason: string | null;
  list_unsubscribe: string | null;
  error: string | null;
  send_at: number | null;
}

const BODY_BUDGET = 2_500_000;

export async function getThread(db: D1Database, threadId: number) {
  const t = await first<ThreadRow>(db, `SELECT ${COLUMNS} FROM threads WHERE id = ?`, threadId);
  if (!t) throw notFound('Conversation not found.');
  const messages = await all<MessageRow>(
    db,
    `SELECT id, direction, status, message_id, from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, reply_to, delivered_to, subject, snippet, sent_at,
            is_read, truncated, raw_key, spf, dkim, dmarc, spam_reason, list_unsubscribe, error, send_at
       FROM messages WHERE thread_id = ? ORDER BY CASE WHEN direction = 'in' THEN created_at ELSE sent_at END, id LIMIT 300`,
    threadId,
  );
  const ids = messages.map((m) => m.id);
  const [bodies, attachments, labels, notes] = await Promise.all([
    ids.length
      ? all<{ message_id: number; text: string; html: string | null; size: number }>(
          db,
          `SELECT message_id, text, CASE WHEN length(html) < ? THEN html END AS html, length(html) AS size FROM message_bodies WHERE message_id IN (${placeholders(ids.length)})`,
          BODY_BUDGET,
          ...ids,
        )
      : Promise.resolve([]),
    ids.length
      ? all<{ id: number; message_id: number; filename: string; content_type: string; size: number; inline: number; content_id: string | null; stored: number }>(
          db,
          `SELECT id, message_id, filename, content_type, size, inline, content_id, stored FROM attachments WHERE message_id IN (${placeholders(ids.length)}) ORDER BY id`,
          ...ids,
        )
      : Promise.resolve([]),
    all<{ label_id: number }>(db, 'SELECT label_id FROM thread_labels WHERE thread_id = ?', threadId),
    all<{ id: number; user_id: number | null; name: string | null; body: string; created_at: number }>(
      db,
      'SELECT n.id, n.user_id, u.name, n.body, n.created_at FROM thread_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.thread_id = ? ORDER BY n.created_at',
      threadId,
    ),
  ]);
  // Keep the response bounded: newest bodies first, older large HTML bodies load on demand.
  let budget = BODY_BUDGET;
  const deferred = new Set<number>();
  for (const m of [...messages].reverse()) {
    const b = bodies.find((x) => x.message_id === m.id);
    const size = (b?.size ?? 0) + (b?.text.length ?? 0);
    if (b?.size && (budget - size < 0 || b.html === null)) deferred.add(m.id);
    budget -= size;
  }
  const detail: MessageDetail[] = messages.map((m) => {
    const b = bodies.find((x) => x.message_id === m.id);
    return {
      id: m.id,
      direction: m.direction,
      status: m.status,
      from: { name: m.from_name, address: m.from_addr },
      to: parseJson(m.to_addrs, []),
      cc: parseJson(m.cc_addrs, []),
      bcc: m.direction === 'out' ? parseJson(m.bcc_addrs, []) : [],
      replyTo: parseJson(m.reply_to, null),
      deliveredTo: m.delivered_to,
      subject: m.subject,
      snippet: m.snippet,
      sentAt: m.sent_at,
      isRead: !!m.is_read,
      text: b?.text ?? '',
      html: deferred.has(m.id) ? null : (b?.html ?? null),
      htmlDeferred: deferred.has(m.id),
      truncated: !!m.truncated,
      rawAvailable: !!m.raw_key,
      auth: { spf: m.spf, dkim: m.dkim, dmarc: m.dmarc },
      spamReason: m.spam_reason,
      listUnsubscribe: parseJson(m.list_unsubscribe, null),
      error: m.error,
      sendAt: m.send_at,
      messageId: m.message_id,
      attachments: attachments
        .filter((a) => a.message_id === m.id)
        .map((a) => ({ id: a.id, filename: a.filename, contentType: a.content_type, size: a.size, inline: !!a.inline, contentId: a.content_id, stored: !!a.stored })),
    };
  });
  return {
    thread: summary(t, labels.map((l) => l.label_id)),
    messages: detail,
    notes: notes.map((n) => ({ id: n.id, userId: n.user_id, name: n.name ?? 'Deleted user', body: n.body, createdAt: n.created_at })),
  };
}

export async function messageBody(db: D1Database, messageId: number): Promise<{ text: string; html: string | null; headers: [string, string][] }> {
  const b = await first<{ text: string; html: string | null; headers: string }>(db, 'SELECT text, html, headers FROM message_bodies WHERE message_id = ?', messageId);
  if (!b) throw notFound('Message not found.');
  return { text: b.text, html: b.html, headers: parseJson(b.headers, []) };
}

export type ThreadAction =
  | 'read'
  | 'unread'
  | 'star'
  | 'unstar'
  | 'archive'
  | 'inbox'
  | 'spam'
  | 'notspam'
  | 'trash'
  | 'delete'
  | 'snooze'
  | 'unsnooze'
  | 'label'
  | 'unlabel'
  | 'assign';

export async function applyThreadAction(
  env: Env,
  settings: AppSettings,
  threads: { id: number; mailboxId: number }[],
  action: ThreadAction,
  opts: { labelId?: number; until?: number; userId?: number | null },
): Promise<void> {
  const db = env.DB;
  if (!threads.length) return;
  const ids = threads.map((t) => t.id);
  const inList = `(${placeholders(ids.length)})`;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const folderOf: Record<string, (typeof THREAD_FOLDERS)[number]> = { archive: 'archive', inbox: 'inbox', spam: 'spam', notspam: 'inbox', trash: 'trash' };

  switch (action) {
    case 'read':
      stmts.push(
        db.prepare(`UPDATE messages SET is_read = 1 WHERE thread_id IN ${inList} AND is_read = 0`).bind(...ids),
        db.prepare(`UPDATE threads SET unread_count = 0, updated_at = ? WHERE id IN ${inList}`).bind(now, ...ids),
      );
      break;
    case 'unread':
      // Like Gmail: the latest received message becomes unread.
      for (const id of ids) {
        stmts.push(
          db
            .prepare(
              "UPDATE messages SET is_read = 0 WHERE id = (SELECT id FROM messages WHERE thread_id = ? AND direction = 'in' ORDER BY sent_at DESC LIMIT 1)",
            )
            .bind(id),
        );
      }
      stmts.push(
        db
          .prepare(
            `UPDATE threads SET unread_count = (SELECT COUNT(*) FROM messages WHERE thread_id = threads.id AND is_read = 0 AND direction = 'in'), updated_at = ? WHERE id IN ${inList}`,
          )
          .bind(now, ...ids),
      );
      break;
    case 'star':
    case 'unstar':
      stmts.push(db.prepare(`UPDATE threads SET starred = ?, updated_at = ? WHERE id IN ${inList}`).bind(action === 'star' ? 1 : 0, now, ...ids));
      break;
    case 'archive':
    case 'inbox':
    case 'spam':
    case 'notspam':
    case 'trash':
      stmts.push(
        db.prepare(`UPDATE threads SET folder = ?, snoozed_until = NULL, updated_at = ? WHERE id IN ${inList}`).bind(folderOf[action], now, ...ids),
      );
      break;
    case 'snooze':
      if (!opts.until || opts.until < now) throw badRequest('Pick a time in the future.');
      stmts.push(db.prepare(`UPDATE threads SET snoozed_until = ?, folder = 'inbox', updated_at = ? WHERE id IN ${inList}`).bind(opts.until, now, ...ids));
      break;
    case 'unsnooze':
      stmts.push(db.prepare(`UPDATE threads SET snoozed_until = NULL, updated_at = ? WHERE id IN ${inList}`).bind(now, ...ids));
      break;
    case 'label':
    case 'unlabel': {
      if (!opts.labelId) throw badRequest('Missing label.');
      const label = await first<{ mailbox_id: number }>(db, 'SELECT mailbox_id FROM labels WHERE id = ?', opts.labelId);
      if (!label) throw notFound('Label not found.');
      for (const t of threads) {
        if (t.mailboxId !== label.mailbox_id) continue;
        stmts.push(
          action === 'label'
            ? db.prepare('INSERT OR IGNORE INTO thread_labels (thread_id, label_id) VALUES (?, ?)').bind(t.id, opts.labelId)
            : db.prepare('DELETE FROM thread_labels WHERE thread_id = ? AND label_id = ?').bind(t.id, opts.labelId),
        );
      }
      break;
    }
    case 'assign':
      stmts.push(db.prepare(`UPDATE threads SET assigned_to = ?, updated_at = ? WHERE id IN ${inList}`).bind(opts.userId ?? null, now, ...ids));
      break;
    case 'delete': {
      const raws = await all<{ raw_key: string; raw_store: 'd1' | 'r2' }>(
        db,
        `SELECT raw_key, raw_store FROM messages WHERE thread_id IN ${inList} AND raw_key IS NOT NULL`,
        ...ids,
      );
      const uploads = await all<{ upload_key: string }>(
        db,
        `SELECT a.upload_key FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id IN ${inList} AND a.upload_key LIKE 'uploads/%'`,
        ...ids,
      );
      await db.batch([
        db.prepare(`DELETE FROM threads WHERE id IN ${inList}`).bind(...ids),
        ...[...new Set(threads.map((t) => t.mailboxId))].map((m) => bumpState(db, m)),
      ]);
      await deleteBlobs(env, settings, raws, uploads.map((u) => u.upload_key));
      return;
    }
    default:
      throw badRequest('Unknown action.');
  }
  for (const m of new Set(threads.map((t) => t.mailboxId))) stmts.push(bumpState(db, m));
  await db.batch(stmts);
}

export async function deleteBlobs(env: Env, settings: AppSettings, raws: { raw_key: string; raw_store: 'd1' | 'r2' }[], uploadKeys: string[] = []): Promise<void> {
  const d1 = raws.filter((r) => r.raw_store === 'd1').map((r) => r.raw_key);
  const r2 = [...raws.filter((r) => r.raw_store === 'r2').map((r) => r.raw_key), ...uploadKeys];
  if (d1.length) await (await storeFor(env, settings, 'd1'))?.delete(d1);
  if (r2.length) await (await storeFor(env, settings, 'r2'))?.delete(r2).catch(() => undefined);
}

export async function searchThreads(db: D1Database, mailboxIds: number[], query: string, limit = 50): Promise<ThreadSummary[]> {
  if (!mailboxIds.length) return [];
  const p = parseSearch(query);
  const filters: string[] = [];
  const params: (string | number)[] = [];
  const folderFilter =
    p.in && p.in !== 'anywhere' && p.in !== 'all'
      ? p.in === 'sent'
        ? 't.last_sent_at IS NOT NULL'
        : p.in === 'drafts'
          ? 't.draft_count > 0'
          : (THREAD_FOLDERS as readonly string[]).includes(p.in)
            ? `t.folder = '${p.in}'`
            : null
      : p.in === 'anywhere' || p.in === 'all'
        ? null
        : "t.folder NOT IN ('spam', 'trash')";
  if (folderFilter) filters.push(folderFilter);
  if (p.isStarred) filters.push('t.starred = 1');
  if (p.isUnread === true) filters.push('t.unread_count > 0');
  if (p.isUnread === false) filters.push('t.unread_count = 0');
  if (p.hasAttachment) filters.push('t.has_attachments = 1');
  if (p.label.length) {
    filters.push(`t.id IN (SELECT tl.thread_id FROM thread_labels tl JOIN labels l ON l.id = tl.label_id WHERE l.name IN (${placeholders(p.label.length)}) COLLATE NOCASE)`);
    params.push(...p.label);
  }

  if (!hasTextQuery(p)) {
    const dateFilters: string[] = [];
    const dateParams: number[] = [];
    if (p.before) {
      dateFilters.push('t.last_message_at < ?');
      dateParams.push(p.before);
    }
    if (p.after) {
      dateFilters.push('t.last_message_at >= ?');
      dateParams.push(p.after);
    }
    const rows = await all<ThreadRow>(
      db,
      `SELECT ${COLUMNS.split(', ').map((c) => `t.${c}`).join(', ')} FROM threads t
        WHERE t.mailbox_id IN (${placeholders(mailboxIds.length)}) AND t.message_count > 0 ${[...filters, ...dateFilters].map((f) => `AND ${f}`).join(' ')}
        ORDER BY t.last_message_at DESC LIMIT ?`,
      ...mailboxIds,
      ...params,
      ...dateParams,
      limit,
    );
    return withLabels(db, rows);
  }

  const expr = ftsExpression(p);
  if (!expr) return [];
  const msgFilters: string[] = [];
  const msgParams: number[] = [];
  if (p.before) {
    msgFilters.push('m.sent_at < ?');
    msgParams.push(p.before);
  }
  if (p.after) {
    msgFilters.push('m.sent_at >= ?');
    msgParams.push(p.after);
  }
  const hits = await all<{ thread_id: number; hit_at: number }>(
    db,
    `SELECT m.thread_id, MAX(m.sent_at) AS hit_at FROM messages_fts f JOIN messages m ON m.id = f.rowid
      WHERE messages_fts MATCH ? AND m.mailbox_id IN (${placeholders(mailboxIds.length)}) ${msgFilters.map((f) => `AND ${f}`).join(' ')}
      GROUP BY m.thread_id ORDER BY hit_at DESC LIMIT 200`,
    expr,
    ...mailboxIds,
    ...msgParams,
  );
  if (!hits.length) return [];
  const rows = await all<ThreadRow>(
    db,
    `SELECT ${COLUMNS.split(', ').map((c) => `t.${c}`).join(', ')} FROM threads t WHERE t.id IN (${placeholders(hits.length)}) ${filters.map((f) => `AND ${f}`).join(' ')}`,
    ...hits.map((h) => h.thread_id),
    ...params,
  );
  const order = new Map(hits.map((h, i) => [h.thread_id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return withLabels(db, rows.slice(0, limit));
}

// Cron: snoozed threads whose time has come return to the top of the inbox.
export async function wakeSnoozed(db: D1Database): Promise<void> {
  const now = Date.now();
  const due = await all<{ id: number; mailbox_id: number }>(db, 'SELECT id, mailbox_id FROM threads WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? LIMIT 50', now);
  if (!due.length) return;
  await db.batch([
    db
      .prepare(`UPDATE threads SET snoozed_until = NULL, folder = 'inbox', last_message_at = MAX(last_message_at, ?), unread_count = MAX(unread_count, 1), updated_at = ? WHERE id IN (${placeholders(due.length)})`)
      .bind(now, now, ...due.map((d) => d.id)),
    ...[...new Set(due.map((d) => d.mailbox_id))].map((m) => bumpState(db, m)),
  ]);
}
