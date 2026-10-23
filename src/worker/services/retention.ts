// Daily maintenance, in small batches so each cron run stays within the free CPU limit.
import type { Env } from '../env';
import { loadSettings } from '../db/settings';
import { all, placeholders, run } from '../db/db';
import { DAY } from '../lib/time';
import { storeFor } from '../storage';
import { deleteBlobs } from './threads';
import { bumpState } from './mailboxes';

export async function purgeOldTrash(env: Env, batch = 40): Promise<number> {
  const settings = await loadSettings(env.DB);
  const now = Date.now();
  const rows = await all<{ id: number; mailbox_id: number }>(
    env.DB,
    `SELECT id, mailbox_id FROM threads WHERE (folder = 'trash' AND updated_at < ?) OR (folder = 'spam' AND updated_at < ?) LIMIT ?`,
    now - settings.trashRetentionDays * DAY,
    now - settings.spamRetentionDays * DAY,
    batch,
  );
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const raws = await all<{ raw_key: string; raw_store: 'd1' | 'r2' }>(
    env.DB,
    `SELECT raw_key, raw_store FROM messages WHERE thread_id IN (${placeholders(ids.length)}) AND raw_key IS NOT NULL`,
    ...ids,
  );
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM threads WHERE id IN (${placeholders(ids.length)})`).bind(...ids),
    ...[...new Set(rows.map((r) => r.mailbox_id))].map((m) => bumpState(env.DB, m)),
  ]);
  await deleteBlobs(env, settings, raws);
  return rows.length;
}

export async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  const db = env.DB;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM auth_attempts WHERE window_start < ?').bind(now - DAY),
    db.prepare('DELETE FROM cache WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM inbound_log WHERE received_at < ?').bind(now - 30 * DAY),
    db.prepare('DELETE FROM audit_log WHERE created_at < ?').bind(now - 365 * DAY),
    db.prepare('DELETE FROM autoreply_log WHERE sent_at < ?').bind(now - 30 * DAY),
    db.prepare("DELETE FROM quota_usage WHERE day < ?").bind(new Date(now - 100 * DAY).toISOString().slice(0, 10)),
    db.prepare("DELETE FROM daily_stats WHERE day < ?").bind(new Date(now - 400 * DAY).toISOString().slice(0, 10)),
  ]);
  // Uploads never attached to a message.
  const orphans = await all<{ id: string; storage_key: string }>(db, 'SELECT id, storage_key FROM uploads WHERE created_at < ? LIMIT 50', now - DAY);
  if (orphans.length) {
    const settings = await loadSettings(db);
    await (await storeFor(env, settings, 'r2'))?.delete(orphans.map((o) => o.storage_key)).catch(() => undefined);
    await run(db, `DELETE FROM uploads WHERE id IN (${placeholders(orphans.length)})`, ...orphans.map((o) => o.id));
  }
}
