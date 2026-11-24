import { describe, expect, it } from 'vitest';
import { formatMboxEntry, parseGmailLabels, streamMbox, type MboxMessage } from '../../src/web/lib/mbox';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function collectMbox(blob: Blob, chunkSize?: number, maxMessageBytes?: number): Promise<MboxMessage[]> {
  const out: MboxMessage[] = [];
  for await (const msg of streamMbox(blob, chunkSize, undefined, maxMessageBytes)) {
    out.push(msg);
  }
  return out;
}

describe('parseGmailLabels', () => {
  it('routes Trash > Spam > Inbox > Archive and detects stars', () => {
    expect(parseGmailLabels(enc.encode('X-Gmail-Labels: Inbox,Important\r\nSubject: Hi\r\n\r\nBody'))).toEqual({
      targetFolder: 'inbox',
      customLabels: [],
      isStarred: false,
    });
    expect(parseGmailLabels(enc.encode('X-Gmail-Labels: Inbox,Spam,Starred\r\n\r\n'))).toEqual({
      targetFolder: 'spam',
      customLabels: [],
      isStarred: true,
    });
    expect(parseGmailLabels(enc.encode('X-Gmail-Labels: Inbox,Spam,Trash\r\n\r\n'))).toEqual({
      targetFolder: 'trash',
      customLabels: [],
      isStarred: false,
    });
    expect(parseGmailLabels(enc.encode('X-Gmail-Labels: ^i,^t\r\n\r\n'))).toEqual({
      targetFolder: 'inbox',
      customLabels: [],
      isStarred: true,
    });
    expect(parseGmailLabels(enc.encode('X-Gmail-Labels: Sent\r\n\r\n'))).toEqual({
      targetFolder: 'archive',
      customLabels: [],
      isStarred: false,
    });
  });

  it('handles folded headers, quoted labels with commas, RFC 2047 words, and long header blocks > 4KB', () => {
    const padding = 'Received: from mail.example.com by mx.example.com with ESMTPS id ' + 'x'.repeat(180) + '\r\n';
    const longHeaders = padding.repeat(30); // > 7 KB before X-Gmail-Labels
    const encodedLabel = `=?UTF-8?B?${btoa('Receipts, 2025')}?=`;
    const eml = `${longHeaders}X-Gmail-Labels: Inbox,"Sales, Q1",\r\n\t${encodedLabel},Category Updates,Work,work\r\nSubject: Test\r\n\r\nHello`;
    const info = parseGmailLabels(enc.encode(eml));
    expect(info.targetFolder).toBe('inbox');
    expect(info.customLabels).toEqual(['Sales, Q1', 'Receipts, 2025', 'Work']);
  });

  it('ignores X-Gmail-Labels inside the message body or mid-line of another header', () => {
    const bodySpoof = 'From: a@b.test\r\nSubject: Normal\r\n\r\nX-Gmail-Labels: Inbox,Starred,EvilLabel\r\n';
    expect(parseGmailLabels(enc.encode(bodySpoof))).toEqual({
      targetFolder: 'archive',
      customLabels: [],
      isStarred: false,
    });

    const headerSpoof = 'From: a@b.test\r\nSubject: Re: X-Gmail-Labels: Trash,Starred,Evil\r\n\r\nBody';
    expect(parseGmailLabels(enc.encode(headerSpoof))).toEqual({
      targetFolder: 'archive',
      customLabels: [],
      isStarred: false,
    });
  });

  it('sanitizes control chars, caps label length at 60, and caps count at 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => `Tag${i}`).join(',');
    const longName = 'A'.repeat(90);
    const info = parseGmailLabels(enc.encode(`X-Gmail-Labels: ${longName},${many}\r\n\r\n`));
    expect(info.customLabels).toHaveLength(10);
    expect(info.customLabels[0]).toHaveLength(60);
  });
});

describe('streamMbox and formatMboxEntry', () => {
  it('parses multi-message mbox archives across tiny chunk boundaries', async () => {
    const raw = [
      'From a@example.com Mon Jan  1 00:00:00 2024',
      'X-Gmail-Labels: Inbox,Receipts',
      'Subject: First',
      '',
      'Hello',
      '>From the desk of Alice',
      '>>From quoted line',
      '',
      'From b@example.com Tue Jan  2 12:34:56 2024',
      'X-Gmail-Labels: Starred,Work',
      'Subject: Second',
      '',
      'Second body',
      '',
    ].join('\r\n');

    // Use a 13-byte chunk size to split every delimiter and envelope line across chunks
    const msgs = await collectMbox(new Blob([enc.encode(raw)]), 13);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].targetFolder).toBe('inbox');
    expect(msgs[0].customLabels).toEqual(['Receipts']);
    expect(dec.decode(msgs[0].bytes)).toContain('\r\nFrom the desk of Alice\r\n>From quoted line');

    expect(msgs[1].targetFolder).toBe('archive');
    expect(msgs[1].isStarred).toBe(true);
    expect(msgs[1].customLabels).toEqual(['Work']);
    expect(dec.decode(msgs[1].bytes)).toContain('Second body');
  });

  it('preserves raw non-UTF-8 bytes losslessly across formatMboxEntry -> streamMbox round-trip', async () => {
    // ISO-8859-1 / binary bytes (0xE9, 0xFF, 0xFE, 0x80) plus From-line escaping
    const eml = new Uint8Array([
      ...enc.encode('Subject: Binary\r\n\r\nFrom start\r\n>From nested\r\n'),
      0xe9,
      0xff,
      0xfe,
      0x80,
      ...enc.encode('\r\nEnd'),
    ]);
    const entry1 = formatMboxEntry(eml, new Date('2025-02-03T04:05:06Z'), 'user @ example.com\r\nEvil: 1');
    const entry2 = formatMboxEntry(enc.encode('Subject: Two\r\n\r\nBody 2'), new Date('invalid'), 'b@example.com');

    // RFC 4155 header uses space-free sender and asctime UTC date
    const headerLine = dec.decode(entry1.subarray(0, entry1.indexOf(10)));
    expect(headerLine).toBe('From user@example.comEvil:1 Mon Feb  3 04:05:06 2025\r');

    const combined = new Uint8Array(entry1.length + entry2.length);
    combined.set(entry1, 0);
    combined.set(entry2, entry1.length);

    const parsed = await collectMbox(new Blob([combined]), 17);
    expect(parsed).toHaveLength(2);
    // Exact byte sequences preserved (no U+FFFD replacement)
    expect(parsed[0].bytes.includes(0xe9)).toBe(true);
    expect(parsed[0].bytes.includes(0xff)).toBe(true);
    expect(parsed[0].bytes.includes(0xfe)).toBe(true);
    expect(parsed[0].bytes.includes(0x80)).toBe(true);
    expect(dec.decode(parsed[0].bytes.subarray(0, 45))).toBe('Subject: Binary\r\n\r\nFrom start\r\n>From nested\r\n');
    expect(dec.decode(parsed[1].bytes)).toContain('Body 2');
  });

  it('skips oversized messages cleanly without crashing or dropping subsequent messages', async () => {
    const bigBody = 'x'.repeat(200);
    const mbox = [
      'From a@test Mon Jan  1 00:00:00 2024',
      'Subject: Big',
      '',
      bigBody,
      '',
      'From b@test Mon Jan  1 00:00:01 2024',
      'Subject: Small',
      '',
      'ok',
      '',
    ].join('\n');

    const msgs = await collectMbox(new Blob([enc.encode(mbox)]), 32, 100);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].oversized).toBe(true);
    expect(msgs[0].bytes).toHaveLength(0);
    expect(msgs[0].size).toBeGreaterThan(100);
    expect(msgs[1].oversized).toBeUndefined();
    expect(dec.decode(msgs[1].bytes)).toContain('Subject: Small');
  });

  it('yields nothing for empty or envelope-only files', async () => {
    expect(await collectMbox(new Blob([]))).toHaveLength(0);
    expect(await collectMbox(new Blob([enc.encode('From a@test Mon Jan 1 00:00:00 2024')]))).toHaveLength(0);
  });
});
