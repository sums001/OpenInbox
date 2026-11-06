// Repairs received mail whose text or HTML body was stored as an attachment (see migration 0007):
// reads the kept raw message again with the current scanner and, where a body part had been filed
// as an attachment, stores the body and drops those attachment rows. Mail with a real text
// attachment, or without its raw message, is left as it is.
import type { Env } from '../env';
import { loadSettings } from '../db/settings';
import { all, first, placeholders } from '../db/db';
import { parseJson } from '../lib/json';
import { logError } from '../lib/log';
import { scan, type ScanResult } from '../mail/scan';
import { htmlToText, makeSnippet } from '../mail/html';
import { D1BlobStore, storeFor } from '../storage';
import { fitBody } from './bodies';
import { bumpState } from './mailboxes';

export async function reparseQueued(env: Env, limit = 20): Promise<number> {
  const db = env.DB;
  const rows = await all<{ id: number; thread_id: number; mailbox_id: number; raw_key: string | null; raw_store: 'd1' | 'r2' | null }>(
    db,
    'SELECT g.id, g.thread_id, g.mailbox_id, g.raw_key, g.raw_store FROM reparse_queue q JOIN messages g ON g.id = q.message_id LIMIT ?',
    limit,
  );
  if (!rows.length) return 0;
  const settings = await loadSettings(db);
  let fixed = 0;
  for (const r of rows) {
    const done = db.prepare('DELETE FROM reparse_queue WHERE message_id = ?').bind(r.id);
    try {
      const store = r.raw_store === 'd1' ? new D1BlobStore(db) : r.raw_store ? await storeFor(env, settings, r.raw_store) : null;
      const bytes = store && r.raw_key ? await store.get(r.raw_key) : null;
      let s: ScanResult | null = null;
      if (bytes) {
        try {
          s = scan(bytes);
        } catch {
          s = null;
        }
      }
      // Text attachments the scanner no longer reports were body parts. Offsets are the part's
      // position in the raw message, the same on every read.
      const kept = new Set(s?.attachments.map((a) => a.offset) ?? []);
      const textParts = s
        ? await all<{ id: number; byte_offset: number | null }>(
            db,
            "SELECT id, byte_offset FROM attachments WHERE message_id = ? AND content_type IN ('text/plain', 'text/html')",
            r.id,
          )
        : [];
      const misread = textParts.filter((a) => a.byte_offset !== null && !kept.has(a.byte_offset));
      const current = await first<{ subject: string; from_text: string; to_text: string; headers: string }>(
        db,
        'SELECT subject, from_text, to_text, headers FROM message_bodies WHERE message_id = ?',
        r.id,
      );
      if (!s || !misread.length || !current) {
        await done.run();
        continue;
      }
      const text = s.text ?? (s.html ? htmlToText(s.html) : '');
      const body = fitBody({ subject: current.subject, fromText: current.from_text, toText: current.to_text, text, html: s.html, headers: parseJson(current.headers, []) });
      const snippet = makeSnippet(text);
      await db.batch([
        db.prepare('UPDATE message_bodies SET text = ?, html = ? WHERE message_id = ?').bind(body.text, body.html, r.id),
        db.prepare(`DELETE FROM attachments WHERE id IN (${placeholders(misread.length)})`).bind(...misread.map((a) => a.id)),
        db
          .prepare(
            `UPDATE messages SET snippet = ?, truncated = ?,
               has_attachments = EXISTS (SELECT 1 FROM attachments WHERE message_id = ? AND (inline = 0 OR content_id IS NULL)) WHERE id = ?`,
          )
          .bind(snippet, body.truncated ? 1 : 0, r.id, r.id),
        // The thread's preview was empty if this was its latest message.
        db
          .prepare(
            `UPDATE threads SET snippet = CASE WHEN snippet = '' THEN ? ELSE snippet END,
               has_attachments = EXISTS (SELECT 1 FROM messages WHERE thread_id = ? AND has_attachments = 1) WHERE id = ?`,
          )
          .bind(snippet, r.thread_id, r.thread_id),
        bumpState(db, r.mailbox_id),
        done,
      ]);
      fixed++;
    } catch (e) {
      logError('reparse.failed', e, { id: r.id });
      await done.run();
    }
  }
  return fixed;
}
