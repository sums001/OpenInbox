import { describe, expect, it } from 'vitest';
import { scan } from '../../src/worker/mail/scan';
import { decodeParam, decodeWords, parseStructured } from '../../src/worker/mail/headers';
import { parseAddressList, stripPlusTag } from '../../src/worker/mail/address';
import { htmlToText, makeSnippet } from '../../src/worker/mail/html';
import { buildMime, encodeQuotedPrintable } from '../../src/worker/mail/mime';
import { buildReferences, normalizeSubject, parseIdList } from '../../src/worker/mail/threading';
import { authSpamReason, parseAuthResults } from '../../src/worker/mail/auth-results';
import { decodeAttachment } from '../../src/worker/mail/decode';

const enc = new TextEncoder();
const eml = (s: string) => enc.encode(s.replace(/\n/g, '\r\n'));

describe('encoded words and parameters', () => {
  it('decodes RFC 2047 B and Q words, joining adjacent words', () => {
    expect(decodeWords('=?UTF-8?B?w6l0w6k=?=')).toBe('été');
    expect(decodeWords('=?ISO-8859-1?Q?Caf=E9_cr=E8me?=')).toBe('Café crème');
    expect(decodeWords('=?UTF-8?B?4oKs?= =?UTF-8?B?IHJhdGVz?=')).toBe('€ rates');
    expect(decodeWords('Hello =?UTF-8?Q?W=C3=B6rld?= again')).toBe('Hello Wörld again');
    // A multi-byte character split across two words.
    expect(decodeWords('=?UTF-8?B?4o?= =?UTF-8?B?Kr?=')).not.toContain('=?');
  });

  it('repairs raw UTF-8 header bytes read as latin1', () => {
    const latin1 = String.fromCharCode(...enc.encode('Grüße'));
    expect(decodeWords(latin1)).toBe('Grüße');
  });

  it('parses structured values with quoted semicolons and RFC 2231 names', () => {
    const t = parseStructured('application/pdf; name="a;b.pdf"; charset=utf-8');
    expect(t.value).toBe('application/pdf');
    expect(t.params.name).toBe('a;b.pdf');
    expect(decodeParam(parseStructured("attachment; filename*=UTF-8''%E2%82%AC%20rates.pdf").params, 'filename')).toBe('€ rates.pdf');
    expect(decodeParam(parseStructured("attachment; filename*0*=UTF-8''%E2%82%AC; filename*1*=%20x.pdf").params, 'filename')).toBe('€ x.pdf');
  });
});

describe('scanner', () => {
  const message = eml(`From: =?UTF-8?Q?Ana_L=C3=B3pez?= <ana@example.org>
To: "Doe, John" <john@example.com>, team@example.com
Subject: =?UTF-8?B?UmU6IEPDtHRl?=
Message-ID: <abc@example.org>
Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.org; dmarc=pass header.from=example.org; spf=pass smtp.mailfrom=ana@example.org
Authentication-Results: evil.example; dmarc=fail
Content-Type: multipart/mixed; boundary="mix"

--mix
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Ol=C3=A1 mundo
--alt
Content-Type: text/html; charset=utf-8

<p>Hola <b>mundo</b></p>
--alt--
--mix
Content-Type: application/pdf; name="report.pdf"
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--mix--
`);

  it('extracts text, html, headers and attachment ranges', () => {
    const s = scan(message);
    expect(s.text).toBe('Olá mundo');
    expect(s.html).toBe('<p>Hola <b>mundo</b></p>');
    expect(decodeWords(s.headers.subject)).toBe('Re: Côte');
    expect(s.attachments).toHaveLength(1);
    const a = s.attachments[0];
    expect(a.filename).toBe('report.pdf');
    expect(a.contentType).toBe('application/pdf');
    const bytes = decodeAttachment(message.subarray(a.offset, a.offset + a.length), a.encoding);
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.4\n');
  });

  it('trusts only the Cloudflare Authentication-Results header', () => {
    const s = scan(message);
    const r = parseAuthResults(s.headerList);
    expect(r).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    expect(authSpamReason(r)).toBeNull();
    expect(authSpamReason({ spf: 'pass', dkim: 'pass', dmarc: 'fail' })).toMatch(/DMARC/);
    expect(authSpamReason({ spf: 'fail', dkim: null, dmarc: 'none' })).toMatch(/SPF/);
  });

  it('handles plain single-part mail', () => {
    const s = scan(eml('Subject: hi\n\nJust text.\n'));
    expect(s.text).toBe('Just text.\n');
    expect(s.attachments).toHaveLength(0);
  });
});

describe('addresses', () => {
  it('parses names, quoted commas, groups and dedupes', () => {
    const list = parseAddressList('"Doe, John" <John@Example.com>, =?UTF-8?Q?Ana_L=C3=B3pez?= <ana@x.org>, bare@y.org, Team: a@z.org, b@z.org;, bare@Y.org');
    expect(list).toEqual([
      { name: 'Doe, John', address: 'john@example.com' },
      { name: 'Ana López', address: 'ana@x.org' },
      { name: '', address: 'bare@y.org' },
      { name: '', address: 'a@z.org' },
      { name: '', address: 'b@z.org' },
    ]);
  });

  it('keeps names from encoded words on one line', () => {
    const b64 = btoa('Ann\r\nReply-To: attacker@evil.test');
    expect(parseAddressList(`=?UTF-8?B?${b64}?= <ann@example.com>`)).toEqual([{ name: 'Ann Reply-To: attacker@evil.test', address: 'ann@example.com' }]);
  });

  it('strips plus tags', () => {
    expect(stripPlusTag('me+news@x.org')).toBe('me@x.org');
    expect(stripPlusTag('me@x.org')).toBeNull();
  });
});

describe('html and snippets', () => {
  it('converts html to text', () => {
    const t = htmlToText('<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>there</b></p><ul><li>One</li><li>Two &amp; three</li></ul></body></html>');
    expect(t).toBe('Hello there\n\n• One\n• Two & three');
  });

  it('makes snippets without quoted text', () => {
    expect(makeSnippet('Thanks!\n\nOn Mon, Ann wrote:\n> old text')).toBe('Thanks!');
  });
});

describe('threading helpers', () => {
  it('normalizes subjects', () => {
    expect(normalizeSubject('Re: Fwd: RE[2]: AW:  Invoice   October')).toBe('invoice october');
  });

  it('parses id lists and builds references with our id last', () => {
    expect(parseIdList('<a@x> <b@y>\r\n <c@z>')).toEqual(['a@x', 'b@y', 'c@z']);
    expect(buildReferences(['root@x'], 'parent@y', 'own@z')).toEqual(['root@x', 'parent@y', 'own@z']);
  });
});

describe('MIME builder', () => {
  it('builds messages the scanner reads back', () => {
    const raw = buildMime({
      from: { name: 'Zoë', address: 'zoe@example.com' },
      to: [{ name: 'Bob, Jr.', address: 'bob@example.org' }],
      subject: 'Grüße and a very long subject line that keeps going well past seventy-eight characters',
      text: 'Hallo Bob,\nschöne Grüße.\n',
      html: '<p>Hallo Bob,<br>schöne Grüße.</p>',
      messageId: 'm1@example.com',
      inReplyTo: 'p@example.org',
      references: ['r@example.org', 'p@example.org', 'm1@example.com'],
      attachments: [{ filename: 'naïve.txt', contentType: 'text/plain', content: enc.encode('file body') }],
    });
    expect(/[\u0080-\uffff]/.test(raw)).toBe(false);
    const s = scan(enc.encode(raw));
    expect(s.text).toBe('Hallo Bob,\nschöne Grüße.\n');
    expect(s.html).toBe('<p>Hallo Bob,<br>schöne Grüße.</p>');
    expect(decodeWords(s.headers.subject)).toMatch(/^Grüße and a very long subject/);
    expect(parseAddressList(s.headers.from)[0]).toEqual({ name: 'Zoë', address: 'zoe@example.com' });
    expect(parseIdList(s.headers.references)).toEqual(['r@example.org', 'p@example.org', 'm1@example.com']);
    expect(s.attachments[0].filename).toBe('naïve.txt');
    const a = s.attachments[0];
    const bytes = decodeAttachment(enc.encode(raw).subarray(a.offset, a.offset + a.length), a.encoding);
    expect(new TextDecoder().decode(bytes)).toBe('file body');
  });

  it('never lets a CR or LF in a value start a new header', () => {
    const evil = '\r\nBcc: attacker@evil.test\r\n\r\nInjected body';
    const raw = buildMime({
      from: { name: `Me${evil}`, address: 'me@example.com' },
      to: [{ name: `Ann${evil}`, address: 'ann@example.org' }],
      replyTo: { name: '', address: `r@example.org${evil}` },
      subject: `Hi${evil}`,
      text: 'Hello',
      messageId: `m1@example.com>${evil}`,
      inReplyTo: `p@example.org${evil}`,
      references: [`r@example.org${evil}`],
      headers: { 'Auto-Submitted': `auto-replied${evil}` },
      attachments: [{ filename: `a${evil}.txt`, contentType: 'text/plain', content: enc.encode('x'), contentId: `c${evil}`, inline: true }],
    });
    const lines = raw.split('\r\n');
    expect(lines.some((l) => /^Bcc:/i.test(l))).toBe(false);
    expect(lines).not.toContain('Injected body');
    // Every top-level header line is a "Name: value" line or a folded continuation.
    const head = raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n');
    expect(head.every((l) => /^[\w-]+: /.test(l) || /^[ \t]/.test(l))).toBe(true);
  });

  it('wraps quoted-printable lines under 76 characters', () => {
    const qp = encodeQuotedPrintable('é'.repeat(100));
    expect(qp.split('\r\n').every((l) => l.length <= 76)).toBe(true);
  });
});
