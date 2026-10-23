// Audit log of sensitive actions (sign-ins, user and mailbox changes, credentials, domains).
import { newId } from '../lib/ids';

export interface AuditEntry {
  userId?: number | null;
  action: string;
  target?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

export function auditStmt(db: D1Database, e: AuditEntry): D1PreparedStatement {
  return db
    .prepare('INSERT INTO audit_log (id, user_id, action, target, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), e.userId ?? null, e.action, e.target ?? null, e.details ? JSON.stringify(e.details) : null, e.ip ?? null, Date.now());
}

export async function audit(db: D1Database, e: AuditEntry): Promise<void> {
  await auditStmt(db, e).run();
}
