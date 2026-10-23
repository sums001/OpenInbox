// RFC 5322 / MIME message builder. Used to archive sent mail as .eml, by the SMTP adapter, and for
// exports. The output is pure 7-bit ASCII (headers use RFC 2047, bodies quoted-printable or
// base64), so the string's characters are its bytes.
import { Buffer } from 'node:buffer';
import { singleLine, type Address } from './address';

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
  inline?: boolean;
}

export interface MimeMessage {
  from: Address;
  to: Address[];
  cc?: Address[];
  replyTo?: Address | null;
  subject: string;
  text: string;
  html?: string | null;
  messageId: string; // without angle brackets
  inReplyTo?: string | null;
  references?: string[];
  date?: Date;
  headers?: Record<string, string>;
  attachments?: MimeAttachment[];
}

const CRLF = '\r\n';

function isAscii(s: string): boolean {
  return !/[\u0080-\uffff]/.test(s);
}

// RFC 2047 "B" encoding in UTF-8, split so each encoded word stays within 75 characters and no
// UTF-8 sequence is split between words.
export function encodeWord(text: string): string {
  if (isAscii(text) && !/[\r\n]/.test(text) && !/=\?/.test(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const ch of text.replace(/[\r\n]+/g, ' ')) {
    const next = chunk + ch;
    if (Buffer.byteLength(next, 'utf8') > 45) {
      words.push(chunk);
      chunk = ch;
    } else chunk = next;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(CRLF + ' ');
}

function quoteName(raw: string): string {
  const name = singleLine(raw);
  if (!isAscii(name)) return encodeWord(name);
  if (/^[\w !#$%&'*+\-/=?^`{|}~.]*$/.test(name) && !/^\s|\s$/.test(name)) return name;
  return `"${name.replace(/(["\\])/g, '\\$1')}"`;
}

// Names and addresses can come from received mail, so neither may break the header line.
export function formatAddressHeader(list: Address[]): string {
  return list.map((a) => (a.name ? `${quoteName(a.name)} <${singleLine(a.address)}>` : singleLine(a.address))).join(', ');
}

// Folds a header line at spaces so lines stay under 78 characters where possible.
function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78 || value.includes(CRLF)) return line;
  const out: string[] = [];
  let current = '';
  for (const token of line.split(' ')) {
    if (current && current.length + token.length + 1 > 78) {
      out.push(current);
      current = ' ' + token;
    } else current = current ? `${current} ${token}` : token;
  }
  if (current) out.push(current);
  return out.join(CRLF);
}

export function encodeQuotedPrintable(text: string): string {
  const bytes = Buffer.from(text.replace(/\r?\n/g, '\n'), 'utf8');
  const lines: string[] = [];
  let line = '';
  const push = (token: string) => {
    if (line.length + token.length > 75) {
      lines.push(line + '=');
      line = '';
    }
    line += token;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0a) {
      lines.push(line);
      line = '';
      continue;
    }
    const nextIsBreak = i + 1 >= bytes.length || bytes[i + 1] === 0x0a;
    if ((b === 0x20 || b === 0x09) && nextIsBreak) push('=' + b.toString(16).toUpperCase().padStart(2, '0'));
    else if ((b >= 33 && b <= 126 && b !== 0x3d) || b === 0x20 || b === 0x09) push(String.fromCharCode(b));
    else push('=' + b.toString(16).toUpperCase().padStart(2, '0'));
  }
  lines.push(line);
  return lines.join(CRLF);
}

function base64Lines(content: Uint8Array): string {
  const b64 = Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

function textPart(contentType: string, body: string): string {
  const plain = isAscii(body) && body.split('\n').every((l) => l.length <= 900);
  const headers = [`Content-Type: ${contentType}; charset=utf-8`];
  if (plain) {
    headers.push('Content-Transfer-Encoding: 7bit');
    return headers.join(CRLF) + CRLF + CRLF + body.replace(/\r?\n/g, CRLF);
  }
  headers.push('Content-Transfer-Encoding: quoted-printable');
  return headers.join(CRLF) + CRLF + CRLF + encodeQuotedPrintable(body);
}

function filenameParams(filename: string): string {
  if (isAscii(filename) && !/["\\\r\n]/.test(filename)) return `filename="${filename}"`;
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function attachmentPart(a: MimeAttachment): string {
  const safeType = /^[\w.+-]+\/[\w.+-]+$/.test(a.contentType) ? a.contentType : 'application/octet-stream';
  const name = isAscii(a.filename) ? singleLine(a.filename).replace(/["\\]/g, '_') : encodeWord(a.filename);
  const headers = [
    `Content-Type: ${safeType}; name="${name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; ${filenameParams(a.filename)}`,
  ];
  if (a.contentId) headers.push(`Content-ID: <${singleLine(a.contentId)}>`);
  return headers.join(CRLF) + CRLF + CRLF + base64Lines(a.content);
}

function multipart(subtype: string, parts: string[]): string {
  const boundary = `=_oi_${crypto.randomUUID().replace(/-/g, '')}`;
  return (
    `Content-Type: multipart/${subtype}; boundary="${boundary}"` +
    CRLF +
    CRLF +
    parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) +
    `${CRLF}--${boundary}--`
  );
}

export function formatDate(date: Date): string {
  return date.toUTCString().replace('GMT', '+0000');
}

export function buildMime(msg: MimeMessage): string {
  const headers: [string, string][] = [
    ['Date', formatDate(msg.date ?? new Date())],
    ['From', formatAddressHeader([msg.from])],
  ];
  if (msg.to.length) headers.push(['To', formatAddressHeader(msg.to)]);
  if (msg.cc?.length) headers.push(['Cc', formatAddressHeader(msg.cc)]);
  if (msg.replyTo) headers.push(['Reply-To', formatAddressHeader([msg.replyTo])]);
  headers.push(['Subject', encodeWord(singleLine(msg.subject))]);
  headers.push(['Message-ID', `<${singleLine(msg.messageId)}>`]);
  if (msg.inReplyTo) headers.push(['In-Reply-To', `<${singleLine(msg.inReplyTo)}>`]);
  if (msg.references?.length) headers.push(['References', msg.references.map((r) => `<${singleLine(r)}>`).join(' ')]);
  for (const [k, v] of Object.entries(msg.headers ?? {})) headers.push([k, singleLine(v)]);
  headers.push(['MIME-Version', '1.0']);

  const inline = (msg.attachments ?? []).filter((a) => a.inline && a.contentId);
  const files = (msg.attachments ?? []).filter((a) => !(a.inline && a.contentId));

  let body = msg.html ? multipart('alternative', [textPart('text/plain', msg.text), textPart('text/html', msg.html)]) : textPart('text/plain', msg.text);
  if (inline.length) body = multipart('related', [body, ...inline.map(attachmentPart)]);
  if (files.length) body = multipart('mixed', [body, ...files.map(attachmentPart)]);

  return headers.map(([k, v]) => foldHeader(k, v)).join(CRLF) + CRLF + body + CRLF;
}
