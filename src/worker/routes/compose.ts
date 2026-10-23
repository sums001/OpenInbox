// Drafts, sending, scheduling, retries and attachment uploads (uploads need attachments mode).
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { body, intParam } from '../lib/validate';
import { composeSchema, sendSchema } from '../../shared/schemas';
import { first, run } from '../db/db';
import { loadSettings } from '../db/settings';
import { assertMailbox } from '../auth/access';
import { currentUser } from '../auth/middleware';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { cancelScheduled, deleteDraft, retryMessage, saveDraft, sendDraft } from '../services/send';
import { r2Store } from '../storage';

export const compose = new Hono<AppBindings>();

const MAX_UPLOAD = 20 * 1024 * 1024;

compose.post('/drafts', async (c) => {
  const user = currentUser(c);
  const input = await body(c, composeSchema);
  await assertMailbox(c.env.DB, user, input.mailboxId, true);
  return c.json(await saveDraft(c.env, user, input));
});

compose.put('/drafts/:id', async (c) => {
  const user = currentUser(c);
  const input = await body(c, composeSchema);
  await assertMailbox(c.env.DB, user, input.mailboxId, true);
  return c.json(await saveDraft(c.env, user, input, intParam(c, 'id')));
});

compose.delete('/drafts/:id', async (c) => {
  await deleteDraft(c.env, currentUser(c), intParam(c, 'id'));
  return c.json({ ok: true });
});

compose.post('/drafts/:id/send', async (c) => {
  const { sendAt } = await body(c, sendSchema);
  return c.json(await sendDraft(c.env, currentUser(c), intParam(c, 'id'), sendAt));
});

compose.post('/messages/:id/retry', async (c) => {
  return c.json(await retryMessage(c.env, currentUser(c), intParam(c, 'id')));
});

compose.post('/messages/:id/cancel-schedule', async (c) => {
  await cancelScheduled(c.env, currentUser(c), intParam(c, 'id'));
  return c.json({ ok: true });
});

// Raw file body; the name comes in X-Filename (URL-encoded).
compose.post('/uploads', async (c) => {
  const user = currentUser(c);
  const settings = await loadSettings(c.env.DB);
  const store = settings.storageMode === 'r2' ? await r2Store(c.env, settings) : null;
  if (!store) throw new HttpError(409, 'attachments_disabled', 'Attachments are off. An admin can enable them in Admin > Integrations > Attachments.');
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > MAX_UPLOAD) throw badRequest('Files can be at most 20 MB.');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.byteLength) throw badRequest('Empty file.');
  if (bytes.byteLength > MAX_UPLOAD) throw badRequest('Files can be at most 20 MB.');
  const filename = decodeURIComponent(c.req.header('x-filename') ?? 'attachment').replace(/[\r\n"\\/]/g, '_').slice(0, 200) || 'attachment';
  const contentType = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0].trim().slice(0, 100) || 'application/octet-stream';
  const id = crypto.randomUUID();
  const key = `uploads/${id}`;
  await store.put(key, bytes, contentType);
  await run(
    c.env.DB,
    'INSERT INTO uploads (id, user_id, storage_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    user.id,
    key,
    filename,
    contentType,
    bytes.byteLength,
    Date.now(),
  );
  return c.json({ id, filename, contentType, size: bytes.byteLength });
});

compose.delete('/uploads/:id', async (c) => {
  const user = currentUser(c);
  const u = await first<{ storage_key: string }>(c.env.DB, 'SELECT storage_key FROM uploads WHERE id = ? AND user_id = ?', c.req.param('id'), user.id);
  if (!u) throw notFound();
  const settings = await loadSettings(c.env.DB);
  await (await r2Store(c.env, settings))?.delete([u.storage_key]).catch(() => undefined);
  await run(c.env.DB, 'DELETE FROM uploads WHERE id = ?', c.req.param('id'));
  return c.json({ ok: true });
});
