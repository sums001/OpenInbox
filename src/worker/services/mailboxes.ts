// Mailboxes, their addresses (primary + aliases) and members.
import { all, first, placeholders, run } from '../db/db';
import { newId } from '../lib/ids';
import { badRequest, conflict, notFound } from '../lib/errors';
import { isValidAddress, normalizeAddress, VALID_LOCAL_PART } from '../mail/address';
import { parseJson } from '../lib/json';

export interface MailboxRow {
  id: number;
  domain_id: number;
  address: string;
  display_name: string;
  kind: 'personal' | 'shared';
  signature: string;
  auto_reply: string | null;
  forward_to: string;
  state: number;
  created_at: number;
}

export interface AutoReply {
  enabled: boolean;
  subject: string;
  body: string;
  startAt?: number | null;
  endAt?: number | null;
}

export async function domainForAddress(db: D1Database, address: string): Promise<{ id: number; name: string }> {
  const at = address.lastIndexOf('@');
  const domain = address.slice(at + 1);
  const d = await first<{ id: number; name: string }>(db, 'SELECT id, name FROM domains WHERE name = ?', domain);
  if (!d) throw badRequest(`${domain} is not a connected domain.`);
  return d;
}

export function validateNewAddress(localPart: string, domain: string): string {
  const local = localPart.trim().toLowerCase();
  if (!VALID_LOCAL_PART.test(local)) throw badRequest('Use letters, digits, dots, dashes, underscores or plus signs, starting and ending with a letter or digit.');
  const address = normalizeAddress(`${local}@${domain}`);
  if (!isValidAddress(address)) throw badRequest(`${address} is not a valid address.`);
  return address;
}

export async function assertAddressFree(db: D1Database, address: string): Promise<void> {
  const taken = await first(db, 'SELECT id FROM addresses WHERE address = ?', address);
  if (taken) throw conflict(`${address} is already in use.`);
}

// Statements that create a mailbox with its primary address; run them in one batch.
export function mailboxStatements(
  db: D1Database,
  input: { id?: number; domainId: number; address: string; displayName: string; kind?: 'personal' | 'shared' },
): { mailboxId: number; statements: D1PreparedStatement[] } {
  const mailboxId = input.id ?? newId();
  const now = Date.now();
  return {
    mailboxId,
    statements: [
      db
        .prepare('INSERT INTO mailboxes (id, domain_id, address, display_name, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(mailboxId, input.domainId, input.address, input.displayName, input.kind ?? 'personal', now),
      db
        .prepare('INSERT INTO addresses (id, address, domain_id, mailbox_id, is_primary, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .bind(newId(), input.address, input.domainId, mailboxId, now),
    ],
  };
}

export function memberStatement(db: D1Database, mailboxId: number, userId: number, canSend = true): D1PreparedStatement {
  return db
    .prepare('INSERT INTO mailbox_members (mailbox_id, user_id, can_send) VALUES (?, ?, ?) ON CONFLICT (mailbox_id, user_id) DO UPDATE SET can_send = excluded.can_send')
    .bind(mailboxId, userId, canSend ? 1 : 0);
}

export async function getMailbox(db: D1Database, id: number): Promise<MailboxRow> {
  const m = await first<MailboxRow>(db, 'SELECT * FROM mailboxes WHERE id = ?', id);
  if (!m) throw notFound('Mailbox not found.');
  return m;
}

export interface MailboxSummary {
  id: number;
  address: string;
  displayName: string;
  kind: 'personal' | 'shared';
  domainId: number;
  aliases: { id: number; address: string }[];
  members: { userId: number; name: string; email: string; canSend: boolean }[];
  threads: number;
  unread: number;
  isCatchAll: boolean;
  createdAt: number;
}

export async function listMailboxesAdmin(db: D1Database): Promise<MailboxSummary[]> {
  const boxes = await all<MailboxRow>(db, 'SELECT * FROM mailboxes ORDER BY address');
  if (!boxes.length) return [];
  const [aliases, members, counts, catchAll] = await Promise.all([
    all<{ id: number; address: string; mailbox_id: number }>(db, 'SELECT id, address, mailbox_id FROM addresses WHERE is_primary = 0 ORDER BY address'),
    all<{ mailbox_id: number; user_id: number; can_send: number; name: string; email: string }>(
      db,
      'SELECT mm.mailbox_id, mm.user_id, mm.can_send, u.name, u.email FROM mailbox_members mm JOIN users u ON u.id = mm.user_id ORDER BY u.name',
    ),
    all<{ mailbox_id: number; threads: number; unread: number }>(
      db,
      "SELECT mailbox_id, COUNT(*) AS threads, SUM(CASE WHEN unread_count > 0 AND folder = 'inbox' THEN 1 ELSE 0 END) AS unread FROM threads GROUP BY mailbox_id",
    ),
    all<{ catch_all_mailbox_id: number }>(db, 'SELECT catch_all_mailbox_id FROM domains WHERE catch_all_mailbox_id IS NOT NULL'),
  ]);
  const catchAllIds = new Set(catchAll.map((c) => c.catch_all_mailbox_id));
  return boxes.map((b) => {
    const c = counts.find((x) => x.mailbox_id === b.id);
    return {
      id: b.id,
      address: b.address,
      displayName: b.display_name,
      kind: b.kind,
      domainId: b.domain_id,
      aliases: aliases.filter((a) => a.mailbox_id === b.id).map((a) => ({ id: a.id, address: a.address })),
      members: members.filter((m) => m.mailbox_id === b.id).map((m) => ({ userId: m.user_id, name: m.name, email: m.email, canSend: !!m.can_send })),
      threads: c?.threads ?? 0,
      unread: c?.unread ?? 0,
      isCatchAll: catchAllIds.has(b.id),
      createdAt: b.created_at,
    };
  });
}

export async function createMailbox(
  db: D1Database,
  input: { localPart: string; domainId: number; displayName: string; kind: 'personal' | 'shared'; members: { userId: number; canSend: boolean }[] },
): Promise<number> {
  const domain = await first<{ id: number; name: string }>(db, 'SELECT id, name FROM domains WHERE id = ?', input.domainId);
  if (!domain) throw notFound('Domain not found.');
  const address = validateNewAddress(input.localPart, domain.name);
  await assertAddressFree(db, address);
  const { mailboxId, statements } = mailboxStatements(db, { domainId: domain.id, address, displayName: input.displayName.trim(), kind: input.kind });
  for (const m of input.members) statements.push(memberStatement(db, mailboxId, m.userId, m.canSend));
  await db.batch(statements);
  return mailboxId;
}

export async function addAlias(db: D1Database, mailboxId: number, localPart: string, domainId: number): Promise<string> {
  await getMailbox(db, mailboxId);
  const domain = await first<{ id: number; name: string }>(db, 'SELECT id, name FROM domains WHERE id = ?', domainId);
  if (!domain) throw notFound('Domain not found.');
  const address = validateNewAddress(localPart, domain.name);
  await assertAddressFree(db, address);
  await run(
    db,
    'INSERT INTO addresses (id, address, domain_id, mailbox_id, is_primary, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    newId(),
    address,
    domain.id,
    mailboxId,
    Date.now(),
  );
  return address;
}

export async function removeAlias(db: D1Database, mailboxId: number, aliasId: number): Promise<void> {
  const r = await run(db, 'DELETE FROM addresses WHERE id = ? AND mailbox_id = ? AND is_primary = 0', aliasId, mailboxId);
  if (!r.meta.changes) throw notFound('Alias not found.');
}

export async function setMembers(db: D1Database, mailboxId: number, members: { userId: number; canSend: boolean }[]): Promise<void> {
  await getMailbox(db, mailboxId);
  const ids = members.map((m) => m.userId);
  const stmts: D1PreparedStatement[] = [
    ids.length
      ? db.prepare(`DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id NOT IN (${placeholders(ids.length)})`).bind(mailboxId, ...ids)
      : db.prepare('DELETE FROM mailbox_members WHERE mailbox_id = ?').bind(mailboxId),
    ...members.map((m) => memberStatement(db, mailboxId, m.userId, m.canSend)),
  ];
  await db.batch(stmts);
}

export async function updateMailbox(
  db: D1Database,
  id: number,
  patch: { displayName?: string; kind?: 'personal' | 'shared'; signature?: string; autoReply?: AutoReply | null; forwardTo?: string[] },
): Promise<void> {
  const m = await getMailbox(db, id);
  await run(
    db,
    'UPDATE mailboxes SET display_name = ?, kind = ?, signature = ?, auto_reply = ?, forward_to = ? WHERE id = ?',
    patch.displayName?.trim() ?? m.display_name,
    patch.kind ?? m.kind,
    patch.signature ?? m.signature,
    patch.autoReply === undefined ? m.auto_reply : patch.autoReply ? JSON.stringify(patch.autoReply) : null,
    patch.forwardTo === undefined ? m.forward_to : JSON.stringify(patch.forwardTo),
    id,
  );
}

export function mailboxSettings(m: MailboxRow) {
  return {
    signature: m.signature,
    autoReply: parseJson<AutoReply | null>(m.auto_reply, null),
    forwardTo: parseJson<string[]>(m.forward_to, []),
  };
}

// Deletes the mailbox and all its mail. Returns raw blob keys to remove from storage.
export async function deleteMailbox(db: D1Database, id: number): Promise<{ d1: string[]; r2: string[] }> {
  await getMailbox(db, id);
  const raws = await all<{ raw_key: string; raw_store: string }>(db, 'SELECT raw_key, raw_store FROM messages WHERE mailbox_id = ? AND raw_key IS NOT NULL', id);
  // Delete in steps so a mailbox with many messages doesn't hit statement limits.
  await run(db, 'UPDATE domains SET catch_all_mailbox_id = NULL WHERE catch_all_mailbox_id = ?', id);
  await run(db, 'DELETE FROM messages WHERE mailbox_id = ?', id);
  await run(db, 'DELETE FROM threads WHERE mailbox_id = ?', id);
  await run(db, 'DELETE FROM mailboxes WHERE id = ?', id);
  return {
    d1: raws.filter((r) => r.raw_store === 'd1').map((r) => r.raw_key),
    r2: raws.filter((r) => r.raw_store === 'r2').map((r) => r.raw_key),
  };
}

// Clients poll mailboxes.state to learn that something changed; bump it with every change.
export function bumpState(db: D1Database, mailboxId: number): D1PreparedStatement {
  return db.prepare('UPDATE mailboxes SET state = state + 1 WHERE id = ?').bind(mailboxId);
}
