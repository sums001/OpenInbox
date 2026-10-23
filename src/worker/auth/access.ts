// Mailbox access. Reading mail is strictly by membership, for admins too: an admin who needs a
// mailbox adds themselves as a member, and that change is audited.
import type { SessionUser } from '../types';
import { forbidden, notFound } from '../lib/errors';

export interface MailboxAccess {
  mailboxId: number;
  canSend: boolean;
}

export async function accessibleMailboxes(db: D1Database, user: SessionUser): Promise<MailboxAccess[]> {
  const { results } = await db
    .prepare('SELECT mailbox_id, can_send FROM mailbox_members WHERE user_id = ?')
    .bind(user.id)
    .all<{ mailbox_id: number; can_send: number }>();
  return results.map((r) => ({ mailboxId: r.mailbox_id, canSend: !!r.can_send }));
}

export async function assertMailbox(db: D1Database, user: SessionUser, mailboxId: number, needSend = false): Promise<MailboxAccess> {
  const row = await db
    .prepare('SELECT can_send FROM mailbox_members WHERE user_id = ? AND mailbox_id = ?')
    .bind(user.id, mailboxId)
    .first<{ can_send: number }>();
  if (!row) throw notFound('Mailbox not found.');
  if (needSend && !row.can_send) throw forbidden('You can read this mailbox but not send from it.');
  return { mailboxId, canSend: !!row.can_send };
}

export async function assertThread(db: D1Database, user: SessionUser, threadId: number, needSend = false) {
  const row = await db
    .prepare(
      `SELECT t.id, t.mailbox_id, m.can_send FROM threads t
         JOIN mailbox_members m ON m.mailbox_id = t.mailbox_id AND m.user_id = ?
        WHERE t.id = ?`,
    )
    .bind(user.id, threadId)
    .first<{ id: number; mailbox_id: number; can_send: number }>();
  if (!row) throw notFound('Conversation not found.');
  if (needSend && !row.can_send) throw forbidden('You can read this mailbox but not send from it.');
  return { threadId: row.id, mailboxId: row.mailbox_id, canSend: !!row.can_send };
}

export async function assertMessage(db: D1Database, user: SessionUser, messageId: number) {
  const row = await db
    .prepare(
      `SELECT g.id, g.mailbox_id, g.thread_id, m.can_send FROM messages g
         JOIN mailbox_members m ON m.mailbox_id = g.mailbox_id AND m.user_id = ?
        WHERE g.id = ?`,
    )
    .bind(user.id, messageId)
    .first<{ id: number; mailbox_id: number; thread_id: number; can_send: number }>();
  if (!row) throw notFound('Message not found.');
  return { messageId: row.id, mailboxId: row.mailbox_id, threadId: row.thread_id, canSend: !!row.can_send };
}
