// The Phase 2 exit check: a 50-message conversation set lands correctly threaded, including
// subject-fallback threading, duplicates and an unknown recipient; plus attachment metadata in
// text-only mode for messages too large to keep.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, setupInstance } from '../helpers/client';

interface Spec {
  id: string;
  subject: string;
  from: string;
  inReplyTo?: string;
  references?: string[];
  body: string;
}

// 10 conversations of 5 messages; conversations 0-6 thread by headers, 7-9 by subject only
// (a client that sends no In-Reply-To/References).
function corpus(): Spec[] {
  const out: Spec[] = [];
  for (let c = 0; c < 10; c++) {
    const ids: string[] = [];
    for (let m = 0; m < 5; m++) {
      const id = `c${c}m${m}@sender.test`;
      const byHeaders = c < 7;
      out.push({
        id,
        subject: m === 0 ? `Topic number ${c}` : `${m % 2 ? 'Re' : 'RE'}: Topic number ${c}`,
        // Without threading headers, only the same correspondent's mail joins by subject.
        from: byHeaders && m % 2 ? `person${c}@other.test` : `person${c}@sender.test`,
        inReplyTo: byHeaders && m > 0 ? ids[m - 1] : undefined,
        references: byHeaders && m > 0 ? [...ids] : undefined,
        body: `Conversation ${c}, message ${m}. Keyword-${c}-${m}.`,
      });
      ids.push(id);
    }
  }
  return out;
}

function toEml(s: Spec): string {
  return [
    `From: ${s.from}`,
    'To: admin@example.com',
    `Subject: ${s.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${s.id}>`,
    ...(s.inReplyTo ? [`In-Reply-To: <${s.inReplyTo}>`] : []),
    ...(s.references ? [`References: ${s.references.map((r) => `<${r}>`).join(' ')}`] : []),
    'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=sender.test; dmarc=pass header.from=sender.test; spf=pass smtp.mailfrom=x@sender.test',
    'Content-Type: text/plain; charset=utf-8',
    '',
    s.body,
    '',
  ].join('\n');
}

describe('fixture set', () => {
  let admin: Client;
  beforeEach(async () => {
    useFakeApis();
    admin = new Client();
    await setupInstance(admin);
  });

  it('threads a 50-message set by headers and by subject fallback', async () => {
    const specs = corpus();
    for (const s of specs) await deliver(toEml(s), { from: s.from, to: 'admin@example.com' });
    // Duplicates and an unknown recipient change nothing.
    await deliver(toEml(specs[3]), { from: specs[3].from, to: 'admin@example.com' });
    expect((await deliver(toEml(specs[4]), { from: specs[4].from, to: 'nobody@example.com' })).rejected).toBeTruthy();

    const threads: { subject: string; messageCount: number }[] = [];
    let cursor: string | null = null;
    do {
      const page: { threads: { subject: string; messageCount: number }[]; nextCursor: string | null } = await admin.get(`/api/threads?mailbox=all&view=inbox${cursor ? `&cursor=${cursor}` : ''}`);
      threads.push(...page.threads);
      cursor = page.nextCursor;
    } while (cursor);
    expect(threads).toHaveLength(10);
    expect(threads.every((t) => t.messageCount === 5)).toBe(true);
    expect(new Set(threads.map((t) => t.subject))).toEqual(new Set(Array.from({ length: 10 }, (_, c) => `Topic number ${c}`)));

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(count?.n).toBe(50);
    const hit = await admin.get('/api/search?q=Keyword-8-3');
    expect(hit.threads.map((t: { subject: string }) => t.subject)).toEqual(['Topic number 8']);
  });

  it('records attachment metadata without storing large messages in text-only mode', async () => {
    const big = 'A'.repeat(1_200_000).replace(/.{76}/g, '$&\r\n');
    const raw = [
      'From: Big <big@sender.test>',
      'To: admin@example.com',
      'Subject: Large attachment',
      `Message-ID: <big-1@sender.test>`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'See the attached file.',
      '--b',
      'Content-Type: application/zip; name="archive.zip"',
      'Content-Disposition: attachment; filename="archive.zip"',
      'Content-Transfer-Encoding: base64',
      '',
      big,
      '--b--',
      '',
    ].join('\n');
    await deliver(raw, { from: 'big@sender.test', to: 'admin@example.com' });
    const t = (await admin.get('/api/threads?mailbox=all&view=inbox')).threads[0];
    const detail = await admin.get(`/api/threads/${t.id}`);
    const m = detail.messages[0];
    expect(m.text).toContain('See the attached file.');
    expect(m.rawAvailable).toBe(false);
    expect(m.attachments).toEqual([expect.objectContaining({ filename: 'archive.zip', contentType: 'application/zip', stored: false })]);
    expect(m.attachments[0].size).toBeGreaterThan(800_000);
    expect(await admin.status('GET', `/api/attachments/${m.attachments[0].id}`)).toBe(404);

    // A small message keeps its raw .eml, so its attachment is downloadable even in text-only mode.
    const small = raw.replace('big-1@', 'small-1@').replace('Large attachment', 'Small attachment').replace(big, 'UEsDBAoAAAAAAA==');
    await deliver(small, { from: 'big@sender.test', to: 'admin@example.com' });
    const t2 = (await admin.get('/api/search?q=subject:small')).threads[0];
    const d2 = await admin.get(`/api/threads/${t2.id}`);
    const a2 = d2.messages[0].attachments[0];
    expect(a2.stored).toBe(true);
    const res = await admin.request('GET', `/api/attachments/${a2.id}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
  });
});
