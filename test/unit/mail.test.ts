import { describe, expect, it } from 'vitest';
import { scan } from '../../src/worker/mail/scan';
import { decodeParam, decodeWords, parseStructured } from '../../src/worker/mail/headers';
import { parseAddressList, stripPlusTag } from '../../src/worker/mail/address';
import { htmlToText, makeSnippet } from '../../src/worker/mail/html';
import { applyTracking, classifyHit } from '../../src/worker/mail/tracking';
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

describe('tracking', () => {
  it('adds a pixel and redirects web links only', async () => {
    const { html, links } = await applyTracking(
      '<html><body><p><a href="https://a.example/x?a=1&amp;b=2">A</a> <a href="mailto:x@y.test">mail</a> <a href="https://a.example/x?a=1&amp;b=2">again</a> <a href="http://b.example">B</a></p></body></html>',
      { base: 'https://mail.example.com', token: 'tok' },
    );
    expect(links).toEqual(['https://a.example/x?a=1&b=2', 'http://b.example/']);
    expect(html).toContain('href="https://mail.example.com/api/t/tok/0">A</a>');
    expect(html).toContain('href="mailto:x@y.test"');
    expect(html).toContain('href="https://mail.example.com/api/t/tok/0">again</a>');
    expect(html).toContain('href="https://mail.example.com/api/t/tok/1"');
    expect(html).toMatch(/<img src="https:\/\/mail\.example\.com\/api\/t\/tok\.gif"[^>]*><\/body>/);
  });

  it('stores links as browsers follow them and skips invalid ones', async () => {
    const { html, links } = await applyTracking('<a href="https://bücher.example/straße?q=ü ">A</a><a href="https://exa mple.com/">B</a><a href="https://x.test/&#13;&#10;Set-Cookie:a=b">C</a>', {
      base: 'https://m.test',
      token: 't',
    });
    expect(links).toEqual(['https://xn--bcher-kva.example/stra%C3%9Fe?q=%C3%BC', 'https://x.test/Set-Cookie:a=b']);
    expect(html).toContain('href="https://exa mple.com/"');
  });

  it("leaves links in quoted and forwarded mail alone", async () => {
    const { html, links } = await applyTracking(
      '<p><a href="https://mine.test/">mine</a></p><p>On Mon, Ann wrote:</p><blockquote><p><a href="https://phish.test/">theirs</a></p><blockquote><a href="https://deep.test/">x</a></blockquote><a href="https://phish2.test/">y</a></blockquote><p><a href="https://mine2.test/">after</a></p><p>---------- Forwarded message ----------<br>From: Bob</p><a href="https://fwd.test/">fwd</a>',
      { base: 'https://m.test', token: 't' },
    );
    expect(links).toEqual(['https://mine.test/', 'https://mine2.test/']);
    for (const kept of ['https://phish.test/', 'https://deep.test/', 'https://phish2.test/', 'https://fwd.test/']) expect(html).toContain(`href="${kept}"`);
  });

  it('appends the pixel to a fragment without a body', async () => {
    const { html } = await applyTracking('<p>Hi</p>', { base: 'https://m.test', token: 't' });
    expect(html).toMatch(/^<p>Hi<\/p><img src="https:\/\/m\.test\/api\/t\/t\.gif"/);
  });

  it('tells people from machines', () => {
    const base = { kind: 'open' as const, method: 'GET', org: 'Comcast Cable', msSinceSent: 3_600_000 };
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
    expect(classifyHit({ ...base, userAgent: chrome })).toBe('human');
    expect(classifyHit({ ...base, userAgent: 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)', org: 'Google LLC' })).toBe('proxy');
    expect(classifyHit({ ...base, userAgent: 'Mozilla/5.0', org: 'Apple Inc.' })).toBe('apple');
    expect(classifyHit({ ...base, userAgent: chrome, org: 'Microsoft Corporation' })).toBe('proxy');
    expect(classifyHit({ ...base, kind: 'click', userAgent: chrome, org: 'Microsoft Corporation' })).toBe('scanner');
    expect(classifyHit({ ...base, kind: 'click', userAgent: chrome, org: 'Mimecast Ltd' })).toBe('scanner');
    expect(classifyHit({ ...base, kind: 'click', userAgent: 'python-requests/2.32' })).toBe('scanner');
    expect(classifyHit({ ...base, kind: 'click', userAgent: chrome, method: 'HEAD' })).toBe('scanner');
    expect(classifyHit({ ...base, kind: 'click', userAgent: chrome, msSinceSent: 2_000 })).toBe('scanner');
    expect(classifyHit({ ...base, kind: 'click', userAgent: chrome })).toBe('human');
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
