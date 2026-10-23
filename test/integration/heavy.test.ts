// Worst-case mail from Phase 0. Generate the fixtures first with `npm run fixtures` (they are
// large and not committed); without them these tests are skipped.
import { beforeEach, describe, expect, it } from 'vitest';
import { scan } from '../../src/worker/mail/scan';
import { decodeAttachment } from '../../src/worker/mail/decode';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, setupInstance } from '../helpers/client';

const files = import.meta.glob<string>('../fixtures/generated/*.eml', { query: '?raw', import: 'default' });
const expected: Record<string, { attachments: number; html: boolean }> = {
  'newsletter-500kb.eml': { attachments: 0, html: true },
  'attachment-10mb.eml': { attachments: 1, html: false },
  'inline-images-40.eml': { attachments: 40, html: true },
  'kitchen-sink-24mb.eml': { attachments: 45, html: true },
};

describe.skipIf(Object.keys(files).length === 0)('heavy fixtures', () => {
  for (const [path, load] of Object.entries(files)) {
    const name = path.split('/').pop()!;
    it(`scans ${name} without decoding attachments`, async () => {
      const bytes = new TextEncoder().encode(await load());
      const s = scan(bytes);
      const exp = expected[name];
      if (exp) {
        expect(s.attachments).toHaveLength(exp.attachments);
        expect(s.html !== null).toBe(exp.html);
      }
      expect(s.text ?? s.html).toBeTruthy();
      const first = s.attachments[0];
      if (first) {
        const decoded = decodeAttachment(bytes.subarray(first.offset, first.offset + first.length), first.encoding);
        expect(Math.abs(decoded.byteLength - first.approxSize) / decoded.byteLength).toBeLessThan(0.05);
      }
    });
  }

  describe('ingest', () => {
    let admin: Client;
    beforeEach(async () => {
      useFakeApis();
      admin = new Client();
      await setupInstance(admin);
    });

    it('stores the largest message as text plus attachment metadata in text-only mode', async () => {
      const entry = Object.entries(files).find(([p]) => p.endsWith('kitchen-sink-24mb.eml'));
      if (!entry) return;
      const raw = await entry[1]();
      const r = await deliver(raw, { from: 'sender@example.org', to: 'admin@example.com' });
      expect(r.rejected).toBeNull();
      const t = (await admin.get('/api/threads?mailbox=all&view=inbox')).threads[0];
      const detail = await admin.get(`/api/threads/${t.id}`);
      const m = detail.messages[0];
      expect(m.rawAvailable).toBe(false);
      expect(m.attachments).toHaveLength(45);
      expect(m.attachments.every((a: { stored: boolean }) => !a.stored)).toBe(true);
      expect(m.html).toContain('Article headline number 1');
    });
  });
});
