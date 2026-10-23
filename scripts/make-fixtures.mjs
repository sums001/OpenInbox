// Generates large worst-case .eml fixtures into test/fixtures/generated (gitignored), from the
// Phase 0 spike: a 500 KB newsletter, 40 inline images, a 10 MB attachment, and a ~24 MB message
// near Email Routing's 25 MB cap. `npm test` then also runs the heavy scanner checks on them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../test/fixtures/generated/', import.meta.url));
mkdirSync(dir, { recursive: true });

const CRLF = '\r\n';
const b64 = (buf) => buf.toString('base64').replace(/.{76}/g, `$&${CRLF}`);
const headers = (subject, contentType) =>
  [
    'From: Sender <sender@example.org>',
    'To: admin@example.com',
    `Subject: ${subject}`,
    'Date: Tue, 20 Oct 2026 10:00:00 +0000',
    `Message-ID: <${randomBytes(8).toString('hex')}@example.org>`,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`,
  ].join(CRLF);

function qp(text) {
  return text
    .split('\n')
    .map((line) => {
      const enc = line.replace(/[=\x80-￿]/g, (c) => '=' + Buffer.from(c).toString('hex').toUpperCase().match(/../g).join('='));
      return enc.replace(/.{75}/g, `$&=${CRLF}`);
    })
    .join(CRLF);
}

function newsletterHtml(kb) {
  const row = (i) =>
    `<tr><td style="padding:12px;font-family:Arial,sans-serif;color:#333"><a href="https://example.org/track?u=${i}&amp;c=campaign-${i}" style="color:#06c">Article headline number ${i} — «special» offer</a><p style="margin:0;font-size:14px;line-height:20px">Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p></td></tr>\n`;
  let html = '<!doctype html><html><head><style>td{border:1px solid #eee}</style></head><body><table width="600" cellpadding="0" cellspacing="0">\n';
  for (let i = 0; html.length < kb * 1024; i++) html += row(i);
  return html + '</table></body></html>';
}

function alternative(html, boundary) {
  return [
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    qp(html.replace(/<[^>]+>/g, ' ').slice(0, 20000)),
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    qp(html),
    `--${boundary}--`,
  ].join(CRLF);
}

function attachment(boundary, name, bytes, type = 'application/octet-stream', cid) {
  return [
    `--${boundary}`,
    `Content-Type: ${type}; name="${name}"`,
    'Content-Transfer-Encoding: base64',
    cid ? `Content-ID: <${cid}>` : `Content-Disposition: attachment; filename="${name}"`,
    cid ? 'Content-Disposition: inline' : null,
    '',
    b64(randomBytes(bytes)),
  ]
    .filter((l) => l !== null)
    .join(CRLF);
}

const fixtures = {
  'newsletter-500kb.eml': () => headers('Big newsletter', 'multipart/alternative; boundary="alt"') + CRLF + CRLF + alternative(newsletterHtml(500), 'alt'),
  'attachment-10mb.eml': () =>
    [headers('10 MB attachment', 'multipart/mixed; boundary="mix"'), '', '--mix', 'Content-Type: text/plain; charset=utf-8', '', 'See attached.', attachment('mix', 'big.bin', 10 * 1024 * 1024), '--mix--'].join(CRLF),
  'inline-images-40.eml': () => {
    const imgs = Array.from({ length: 40 }, (_, i) => `img${i}@example.org`);
    const html = newsletterHtml(100).replace('<body>', '<body>' + imgs.map((c) => `<img src="cid:${c}" width="600">`).join(''));
    return [
      headers('Inline images', 'multipart/related; boundary="rel"'), '',
      '--rel', 'Content-Type: multipart/alternative; boundary="alt"', '', alternative(html, 'alt'),
      ...imgs.map((c, i) => attachment('rel', `image${i}.png`, 50 * 1024, 'image/png', c)),
      '--rel--',
    ].join(CRLF);
  },
  'kitchen-sink-24mb.eml': () => {
    const imgs = Array.from({ length: 40 }, (_, i) => `img${i}@example.org`);
    const html = newsletterHtml(500).replace('<body>', '<body>' + imgs.map((c) => `<img src="cid:${c}">`).join(''));
    return [
      headers('Kitchen sink', 'multipart/mixed; boundary="mix"'), '',
      '--mix', 'Content-Type: multipart/related; boundary="rel"', '',
      '--rel', 'Content-Type: multipart/alternative; boundary="alt"', '', alternative(html, 'alt'),
      ...imgs.map((c, i) => attachment('rel', `image${i}.png`, 50 * 1024, 'image/png', c)),
      '--rel--',
      ...Array.from({ length: 5 }, (_, i) => attachment('mix', `file${i}.pdf`, 3 * 1024 * 1024, 'application/pdf')),
      '--mix--',
    ].join(CRLF);
  },
};

for (const [name, build] of Object.entries(fixtures)) {
  const body = build();
  writeFileSync(dir + name, body);
  console.log(`${name.padEnd(26)} ${(Buffer.byteLength(body) / 1024 / 1024).toFixed(2)} MB`);
}
