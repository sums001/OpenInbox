// "Select all conversations": counting a whole view and acting on it one batch at a time.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, setupInstance } from '../helpers/client';
import { countView } from '../../src/worker/services/threads';

// Inserts conversations straight into D1: delivering hundreds of messages would make the test slow.
async function seed(mailboxId: number, n: number, folder = 'inbox', startId = 1_000_000): Promise<number[]> {
  const ids = Array.from({ length: n }, (_, i) => startId + i);
  const now = Date.now();
  await env.DB.batch(
    ids.map((id, i) =>
      env.DB.prepare(
        'INSERT INTO threads (id, mailbox_id, folder, subject, message_count, unread_count, last_message_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)',
      ).bind(id, mailboxId, folder, `Thread ${i}`, now - i * 1000, now),
    ),
  );
  return ids;
}

async function runOnView(c: Client, body: Record<string, unknown>): Promise<{ total: number; requests: number }> {
  let cursor: string | null = null;
  let total = 0;
  let requests = 0;
  do {
    const r: { count: number; nextCursor: string | null } = await c.post('/api/threads/actions/view', { ...body, cursor });
    total += r.count;
    cursor = r.nextCursor;
    requests++;
  } while (cursor && requests < 50);
  return { total, requests };
}

describe('select all conversations in a view', () => {
  let admin: Client;
  let mailboxId: number;
  beforeEach(async () => {
    useFakeApis();
    admin = new Client();
    await setupInstance(admin);
    mailboxId = (await admin.get('/api/mailboxes'))[0].id;
  });

  it('counts a view and archives every conversation in it, beyond the loaded page', async () => {
    await seed(mailboxId, 250);
    expect(await admin.get('/api/threads/count?mailbox=all&view=inbox')).toEqual({ count: 250, capped: false });

    const { total, requests } = await runOnView(admin, { mailbox: 'all', view: 'inbox', action: 'archive' });
    expect(total).toBe(250);
    expect(requests).toBe(3);
    expect(await admin.get('/api/threads/count?mailbox=all&view=inbox')).toEqual({ count: 0, capped: false });
    expect(await admin.get(`/api/threads/count?mailbox=${mailboxId}&view=archive`)).toEqual({ count: 250, capped: false });
  });

  it('visits each conversation once when the action keeps it in the view', async () => {
    await seed(mailboxId, 200);
    const { total } = await runOnView(admin, { mailbox: mailboxId, view: 'inbox', action: 'read' });
    expect(total).toBe(200);
    const unread = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE unread_count > 0').first<{ n: number }>();
    expect(unread?.n).toBe(0);
  });

  it('leaves mail that arrives during the action alone', async () => {
    await seed(mailboxId, 120);
    const first: { count: number; nextCursor: string } = await admin.post('/api/threads/actions/view', { mailbox: 'all', view: 'inbox', action: 'trash' });
    expect(first.count).toBe(90);
    await deliver(email({ subject: 'Arrived meanwhile', messageId: 'new@sender.test' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    const rest: { count: number; nextCursor: string | null } = await admin.post('/api/threads/actions/view', { mailbox: 'all', view: 'inbox', action: 'trash', cursor: first.nextCursor });
    expect(rest).toEqual({ count: 30, nextCursor: null });
    const inbox = await admin.get('/api/threads?mailbox=all&view=inbox');
    expect(inbox.threads.map((t: { subject: string }) => t.subject)).toEqual(['Arrived meanwhile']);
  });

  it('deletes a whole label view and caps the count', async () => {
    const ids = await seed(mailboxId, 100, 'archive');
    const label = await admin.post(`/api/mailboxes/${mailboxId}/labels`, { name: 'Newsletters' });
    await env.DB.batch(ids.slice(0, 95).map((id) => env.DB.prepare('INSERT INTO thread_labels (thread_id, label_id) VALUES (?, ?)').bind(id, label.id)));

    expect(await admin.get(`/api/threads/count?mailbox=all&view=label&label=${label.id}`)).toEqual({ count: 95, capped: false });
    expect(await countView(env.DB, { mailboxIds: [mailboxId], view: 'label', labelId: label.id }, 50)).toEqual({ count: 50, capped: true });
    expect(await countView(env.DB, { mailboxIds: [mailboxId], view: 'archive' }, 50)).toEqual({ count: 50, capped: true });

    const { total } = await runOnView(admin, { mailbox: 'all', view: 'label', label: label.id, action: 'delete' });
    expect(total).toBe(95);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads').first<{ n: number }>();
    expect(left?.n).toBe(5);
  });

  it('applies the per-id action to more conversations than one query can bind', async () => {
    const ids = await seed(mailboxId, 230);
    expect(await admin.post('/api/threads/actions', { threadIds: ids, action: 'star' })).toEqual({ ok: true, count: 230 });
    expect((await admin.get('/api/threads/count?mailbox=all&view=starred')).count).toBe(230);
  });

  it('only touches mailboxes the user is a member of', async () => {
    const boxes = await admin.get('/api/admin/mailboxes');
    const created = await admin.post('/api/admin/users', { name: 'Bob', role: 'member', newMailbox: { localPart: 'bob', domainId: boxes[0].domainId } });
    await seed(mailboxId, 10);
    const bob = new Client();
    await bob.init();
    await bob.post('/api/auth/login', { email: 'bob@example.com', password: created.password });
    await bob.post('/api/account/password', { next: 'bobs new password 1' });

    expect(await bob.status('POST', '/api/threads/actions/view', { mailbox: mailboxId, view: 'inbox', action: 'trash' })).toBe(404);
    expect(await bob.status('GET', `/api/threads/count?mailbox=${mailboxId}&view=inbox`)).toBe(404);
    expect(await bob.post('/api/threads/actions/view', { mailbox: 'all', view: 'inbox', action: 'trash' })).toEqual({ count: 0, nextCursor: null });
    expect((await admin.get('/api/threads/count?mailbox=all&view=inbox')).count).toBe(10);
  });

  it('rejects views that cannot be walked as a whole', async () => {
    expect(await admin.status('POST', '/api/threads/actions/view', { mailbox: 'all', view: 'search', action: 'trash' })).toBe(400);
    expect(await admin.status('GET', '/api/threads/count?mailbox=all&view=scheduled')).toBe(400);
  });
});
