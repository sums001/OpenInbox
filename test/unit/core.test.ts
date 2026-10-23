import { describe, expect, it } from 'vitest';
import { mergeSpf, spfLookupCount, unquoteTxt } from '../../src/worker/cloudflare/spf';
import { planRecords, quoteTxt, type CfDnsRecord } from '../../src/worker/cloudflare/dns';
import { base32Decode, base32Encode, totpCode, verifyTotp } from '../../src/worker/lib/totp';
import { decrypt, encrypt } from '../../src/worker/lib/crypto';
import { hashPassword, verifyPassword } from '../../src/worker/lib/password';
import { dotStuff, SmtpAdapter } from '../../src/worker/providers/smtp';
import { ftsExpression, parseSearch } from '../../src/shared/search';
import { applyFilters } from '../../src/worker/services/filters';
import { shouldAutoReply } from '../../src/worker/services/autoreply';
import { isNewer } from '../../src/worker/services/updates';
import { workerShare } from '../../src/worker/services/usage';
import { num } from '../../src/web/lib/format';
import type { Env } from '../../src/worker/env';

describe('SPF merge', () => {
  it('adds includes before the all mechanism and keeps the qualifier', () => {
    expect(mergeSpf(['"v=spf1 include:_spf.mx.cloudflare.net ~all"'], ['spf.mailjet.com'])).toBe('v=spf1 include:_spf.mx.cloudflare.net include:spf.mailjet.com ~all');
    expect(mergeSpf(['v=spf1 mx -all'], ['include:a.test', 'a.test'])).toBe('v=spf1 mx include:a.test -all');
  });

  it('merges duplicate records into one and dedupes', () => {
    expect(mergeSpf(['v=spf1 include:a.test ~all', 'v=spf1 include:b.test include:a.test -all'], [])).toBe('v=spf1 include:a.test include:b.test ~all');
  });

  it('counts DNS lookups and unquotes split TXT strings', () => {
    expect(spfLookupCount('v=spf1 include:a include:b mx a ip4:1.2.3.4 ~all')).toBe(4);
    expect(unquoteTxt('"v=spf1 include:a" " ~all"')).toBe('v=spf1 include:a ~all');
    expect(quoteTxt('x'.repeat(300)).split('" "')).toHaveLength(2);
  });
});

describe('DNS planner', () => {
  const existing: CfDnsRecord[] = [
    { id: 'spf1', type: 'TXT', name: 'example.com', content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' },
    { id: 'spf2', type: 'TXT', name: 'example.com', content: '"v=spf1 include:old.test ~all"' },
    { id: 'dkim', type: 'TXT', name: 'resend._domainkey.example.com', content: '"p=OLDKEY"' },
    { id: 'dmarc', type: 'TXT', name: '_dmarc.example.com', content: '"v=DMARC1; p=reject"' },
    { id: 'www', type: 'A', name: 'www.example.com', content: '192.0.2.1' },
  ];

  it('merges SPF, replaces DKIM, keeps an existing DMARC and reports CNAME conflicts', () => {
    const actions = planRecords('example.com', existing, [
      { type: 'TXT', name: '@', content: 'v=spf1 include:spf.mailjet.com ~all', purpose: 'spf' },
      { type: 'TXT', name: 'resend._domainkey', content: 'p=NEWKEY', purpose: 'dkim' },
      { type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none', purpose: 'dmarc' },
      { type: 'CNAME', name: 'www', content: 'target.test' },
      { type: 'MX', name: 'send', content: 'feedback-smtp.test', priority: 10 },
    ]);
    const byOp = (op: string) => actions.filter((a) => a.op === op);
    const spfUpdate = actions.find((a) => a.op === 'update' && a.type === 'TXT' && a.name === 'example.com');
    expect(spfUpdate && 'content' in spfUpdate && spfUpdate.content).toBe('v=spf1 include:_spf.mx.cloudflare.net include:old.test include:spf.mailjet.com ~all');
    expect(byOp('delete').map((a) => (a as { recordId: string }).recordId)).toEqual(['spf2']);
    expect(actions.find((a) => a.name === 'resend._domainkey.example.com')).toMatchObject({ op: 'update', recordId: 'dkim', content: 'p=NEWKEY' });
    expect(actions.find((a) => a.name === '_dmarc.example.com')?.op).toBe('noop');
    expect(actions.find((a) => a.name === 'www.example.com')?.op).toBe('conflict');
    expect(actions.find((a) => a.name === 'send.example.com')).toMatchObject({ op: 'create', type: 'MX', priority: 10 });
  });

  it('is idempotent once applied', () => {
    const recs: CfDnsRecord[] = [{ id: 'a', type: 'TXT', name: 'send.example.com', content: '"v=spf1 include:amazonses.com ~all"' }];
    const actions = planRecords('example.com', recs, [{ type: 'TXT', name: 'send', content: 'v=spf1 include:amazonses.com ~all' }]);
    expect(actions.map((a) => a.op)).toEqual(['noop']);
  });
});

describe('crypto', () => {
  const env = { ENCRYPTION_KEY: 'k'.repeat(40) } as Env;

  it('round-trips AES-GCM and falls back to the previous key during rotation', async () => {
    const enc = await encrypt(env, 'secret value');
    expect(enc.startsWith('v1.')).toBe(true);
    expect(await decrypt(env, enc)).toBe('secret value');
    const rotated = { ENCRYPTION_KEY: 'n'.repeat(40), ENCRYPTION_KEY_PREVIOUS: 'k'.repeat(40) } as Env;
    expect(await decrypt(rotated, enc)).toBe('secret value');
    await expect(decrypt({ ENCRYPTION_KEY: 'x'.repeat(40) } as Env, enc)).rejects.toThrow(/cannot be decrypted/);
  });

  it('hashes passwords with PBKDF2', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('generates and verifies TOTP codes (RFC 6238 test vector)', async () => {
    const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
    expect(base32Decode(secret)).toEqual(new TextEncoder().encode('12345678901234567890'));
    expect(await totpCode(secret, 59_000)).toBe('287082');
    expect(await verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(await verifyTotp(secret, '000000', 59_000)).toBe(false);
  });
});

describe('SMTP client', () => {
  // A scripted SMTP server on fake streams.
  function fakeSmtp(script: (line: string) => string | null) {
    const sent: string[] = [];
    let push: (s: string) => void = () => {};
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (s) => controller.enqueue(new TextEncoder().encode(s));
        push('220 smtp.test ESMTP\r\n');
      },
    });
    let buffer = '';
    let inData = false;
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        buffer += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          sent.push(line);
          if (inData) {
            if (line === '.') {
              inData = false;
              push('250 2.0.0 Ok: queued as ABC123\r\n');
            }
            continue;
          }
          if (line === 'DATA') inData = true;
          const reply = script(line);
          if (reply) push(reply);
        }
      },
    });
    const socket = { readable, writable, close: async () => {}, startTls: () => socket, closed: Promise.resolve(), opened: Promise.resolve({}) };
    return { connect: () => socket as unknown as Socket, sent };
  }

  it('authenticates and sends with dot-stuffing', async () => {
    const server = fakeSmtp((line) => {
      if (line.startsWith('EHLO')) return '250-smtp.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1000000\r\n';
      if (line.startsWith('AUTH PLAIN')) return '235 2.7.0 Authentication successful\r\n';
      if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) return '250 2.1.0 Ok\r\n';
      if (line === 'DATA') return '354 End data with <CR><LF>.<CR><LF>\r\n';
      if (line === 'QUIT') return '221 Bye\r\n';
      return '500 unknown\r\n';
    });
    const adapter = new SmtpAdapter({ host: 'smtp.test', port: 465, security: 'tls', username: 'u', password: 'p' }, server.connect as never);
    const r = await adapter.send({
      from: { name: '', address: 'me@example.com' },
      to: [{ name: '', address: 'a@x.test' }],
      cc: [],
      bcc: [{ name: '', address: 'b@x.test' }],
      subject: 's',
      text: 't',
      messageId: 'id@example.com',
      references: ['id@example.com'],
      attachments: [],
      raw: 'Subject: s\r\n\r\n.leading dot\r\nbody\r\n',
    });
    expect(r.providerMessageId).toBe('ABC123');
    expect(server.sent).toContain('RCPT TO:<b@x.test>');
    expect(server.sent).toContain('..leading dot');
    expect(dotStuff('.a\n.b')).toBe('..a\r\n..b');
  });

  it('refuses addresses that would inject SMTP commands', async () => {
    const server = fakeSmtp(() => '250 Ok\r\n');
    const adapter = new SmtpAdapter({ host: 'smtp.test', port: 465, security: 'tls', username: '', password: '' }, server.connect as never);
    const message = (address: string) => ({
      from: { name: '', address: 'me@example.com' },
      to: [{ name: '', address }],
      cc: [],
      bcc: [],
      subject: 's',
      text: 't',
      messageId: 'id@example.com',
      references: ['id@example.com'],
      attachments: [],
      raw: 'Subject: s\r\n\r\nbody\r\n',
    });
    for (const bad of ['a@b.test>\r\nRCPT TO:<x@evil.test', 'a@b.test> NOTIFY=NEVER', 'a b@c.test']) {
      await expect(adapter.send(message(bad))).rejects.toThrow(/SMTP cannot carry/);
    }
    expect(server.sent).toHaveLength(0);
  });

  it('refuses port 25', async () => {
    const adapter = new SmtpAdapter({ host: 'smtp.test', port: 25, security: 'starttls', username: '', password: '' });
    await expect(adapter.validate()).rejects.toThrow(/Port 25/);
  });
});

describe('search, filters, auto-reply, versions', () => {
  it('parses search operators into a safe FTS expression', () => {
    const p = parseSearch('invoice from:ann "due date" -spam has:attachment is:unread in:archive after:2026-01-02');
    expect(p).toMatchObject({ terms: ['invoice'], from: ['ann'], phrases: ['due date'], exclude: ['spam'], hasAttachment: true, isUnread: true, in: 'archive' });
    expect(p.after).toBe(Date.UTC(2026, 0, 2));
    expect(ftsExpression(p)).toBe('"invoice"* AND "due date" AND from_text : "ann" NOT "spam"');
    expect(ftsExpression(parseSearch('a" OR 1=1'))).not.toContain(' OR 1');
  });

  it('combines matching filters', () => {
    const actions = applyFilters(
      [
        { conditions: { from: 'shop' }, actions: { labelIds: [1], markRead: true } },
        { conditions: { subject: 'receipt', match: 'all' }, actions: { folder: 'archive', labelIds: [2] } },
        { conditions: { to: 'nobody' }, actions: { star: true } },
      ],
      { fromAddr: 'orders@shop.test', fromName: 'Shop', recipients: ['me@x.test'], subject: 'Your receipt', text: '', hasAttachment: false, isList: false },
    );
    expect(actions).toEqual({ labelIds: [1, 2], markRead: true, folder: 'archive' });
  });

  it('does not auto-reply to automated or bulk mail', () => {
    const base = { subject: 'Hi', from: { name: '', address: 'ann@x.test' }, to: [], cc: [], replyTo: null, date: 0, messageId: 'a@x', inReplyTo: null, references: [], listUnsubscribe: null, isBulk: false, isAutoSubmitted: false, text: '', html: null };
    const reply = { enabled: true, subject: '', body: 'Away' };
    expect(shouldAutoReply(reply, base, 'me@example.com')).toBe(true);
    expect(shouldAutoReply(reply, { ...base, isBulk: true }, 'me@example.com')).toBe(false);
    expect(shouldAutoReply(reply, { ...base, from: { name: '', address: 'noreply@x.test' } }, 'me@example.com')).toBe(false);
    expect(shouldAutoReply({ ...reply, endAt: 1 }, base, 'me@example.com', 10)).toBe(false);
    expect(shouldAutoReply(reply, { ...base, replyTo: { name: '', address: 'a@b.test\r\nrcpt to:<x@evil.test>' } }, 'me@example.com')).toBe(false);
  });

  it('compares versions', () => {
    expect(isNewer('v1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('v1.0.1', '1.10.0')).toBe(false);
  });
});

describe('dashboard figures', () => {
  const row = (scriptName: string, requests: number) => ({ sum: { requests }, dimensions: { scriptName } });
  it('counts this Worker, and reports unknown while analytics has not named it yet', () => {
    expect(workerShare([row('openinbox', 7), row('other', 3)], 'openinbox')).toBe(7);
    expect(workerShare([row('other', 3)], 'openinbox')).toBe(0);
    expect(workerShare([row('__unknown__', 45)], 'openinbox')).toBeUndefined();
    expect(workerShare([row('openinbox', 2), row('__unknown__', 1)], 'openinbox')).toBe(2);
    expect(workerShare([row('openinbox', 2)], null)).toBeUndefined();
  });
  it('prints compact figures with K and M in every locale', () => {
    expect(num(4_999_883)).toBe('5M');
    expect(num(1_250_000)).toBe('1.3M');
    expect(num(100_000)).toBe('100K');
  });
});
