// Counters the dashboard reads instead of scanning messages: per-day per-mailbox traffic, global
// counters (stored bytes and counts), and the inbound delivery log.
import { dayKey } from '../lib/time';
import { newId } from '../lib/ids';

export type DailyField = 'received' | 'sent' | 'spam' | 'rejected';

export function dailyStatStmt(db: D1Database, mailboxId: number, field: DailyField, delta = 1, day = dayKey()): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO daily_stats (day, mailbox_id, ${field}) VALUES (?, ?, ?) ON CONFLICT (day, mailbox_id) DO UPDATE SET ${field} = ${field} + excluded.${field}`)
    .bind(day, mailboxId, delta);
}

export function counterStmt(db: D1Database, key: string, delta: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = value + excluded.value')
    .bind(key, delta);
}

export type InboundStatus = 'delivered' | 'spam' | 'duplicate' | 'rejected' | 'unparsed' | 'error';

export function inboundLogStmt(
  db: D1Database,
  e: { from: string; to: string; subject?: string; size: number; status: InboundStatus; reason?: string | null; messageId?: number | null },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO inbound_log (id, received_at, mail_from, rcpt_to, subject, size, status, reason, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), Date.now(), e.from.slice(0, 320), e.to.slice(0, 320), (e.subject ?? '').slice(0, 300), e.size, e.status, e.reason ?? null, e.messageId ?? null);
}

export async function logInbound(db: D1Database, e: Parameters<typeof inboundLogStmt>[1], rejected = false): Promise<void> {
  const stmts = [inboundLogStmt(db, e)];
  if (rejected) stmts.push(dailyStatStmt(db, 0, 'rejected'));
  await db.batch(stmts).catch(() => undefined);
}
