// Light MIME scanner (from the Phase 0 spike). It decodes headers and the text/HTML bodies, and
// only records the byte range of each attachment in the raw message instead of decoding it.
// Full parsing of large mail exceeds the free CPU limit; this scanner measured 1-6 ms on the real
// email() path for messages up to 8 MB. Attachments are decoded on download (decode.ts).
import { Buffer } from 'node:buffer';
import { decodeCharset, decodeParam, parseStructured } from './headers';

const MAX_DEPTH = 10;

export interface ScannedAttachment {
  filename: string | null;
  contentType: string;
  contentId: string | null;
  inline: boolean;
  encoding: string;
  offset: number;
  length: number;
  approxSize: number;
}

export interface ScanResult {
  headers: Record<string, string>; // lowercase name -> value (repeated headers joined with ", ")
  headerList: [string, string][]; // every top-level header in order, unfolded, raw (not decoded)
  text: string | null;
  html: string | null;
  attachments: ScannedAttachment[];
}

// Walks line by line to the first blank line, so the search never runs past the headers.
function splitHeaders(buf: Buffer, start: number, end: number) {
  let lineStart = start;
  while (lineStart < end) {
    const nl = buf.indexOf(0x0a, lineStart);
    if (nl === -1 || nl >= end) break;
    const blank = nl === lineStart || (nl === lineStart + 1 && buf[lineStart] === 0x0d);
    if (blank) return { headerText: buf.toString('latin1', start, lineStart), bodyStart: nl + 1 };
    lineStart = nl + 1;
  }
  return { headerText: buf.toString('latin1', start, end), bodyStart: end };
}

function headerLines(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return out;
}

function headerMap(lines: [string, string][]): Map<string, string> {
  const headers = new Map<string, string>();
  for (const [name, value] of lines) {
    const key = name.toLowerCase();
    headers.set(key, headers.has(key) ? headers.get(key) + ', ' + value : value);
  }
  return headers;
}

function decodeQP(bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c !== 0x3d) {
      out[o++] = c;
      continue;
    }
    const a = bytes[i + 1];
    const b = bytes[i + 2];
    if (a === 0x0d && b === 0x0a) {
      i += 2; // soft break CRLF
      continue;
    }
    if (a === 0x0a) {
      i += 1; // soft break LF
      continue;
    }
    const hex = String.fromCharCode(a, b);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[o++] = parseInt(hex, 16);
      i += 2;
    } else out[o++] = c;
  }
  return out.subarray(0, o);
}

export function decodeTransfer(raw: Buffer, encoding: string): Buffer {
  if (encoding === 'base64') return Buffer.from(raw.toString('latin1'), 'base64');
  // RFC 2045: trailing whitespace on encoded QP lines is not part of the content.
  if (encoding === 'quoted-printable') {
    return decodeQP(Buffer.from(raw.toString('latin1').replace(/[ \t]+(?=\r?\n)/g, ''), 'latin1'));
  }
  return raw;
}

function decodeBody(buf: Buffer, start: number, end: number, encoding: string, charset: string | undefined): string {
  const bytes = decodeTransfer(buf.subarray(start, end), encoding);
  return decodeCharset(bytes, charset).replace(/\r\n/g, '\n');
}

function walk(buf: Buffer, start: number, end: number, out: ScanResult, depth: number): void {
  const { headerText, bodyStart } = splitHeaders(buf, start, end);
  const headers = headerMap(headerLines(headerText));
  const type = parseStructured(headers.get('content-type') || 'text/plain');
  const disposition = parseStructured(headers.get('content-disposition'));
  const encoding = (headers.get('content-transfer-encoding') || '7bit').toLowerCase().trim();

  if (type.value.startsWith('multipart/') && type.params.boundary && depth < MAX_DEPTH) {
    const delim = '--' + type.params.boundary;
    let pos = buf.indexOf(delim, bodyStart);
    while (pos !== -1 && pos > 0 && buf[pos - 1] !== 0x0a) pos = buf.indexOf(delim, pos + 1);
    while (pos !== -1 && pos < end) {
      if (buf[pos + delim.length] === 0x2d && buf[pos + delim.length + 1] === 0x2d) break; // closing --boundary--
      const lineEnd = buf.indexOf(0x0a, pos);
      if (lineEnd === -1 || lineEnd >= end) break;
      const partStart = lineEnd + 1;
      let next = buf.indexOf(delim, partStart);
      while (next !== -1 && buf[next - 1] !== 0x0a) next = buf.indexOf(delim, next + 1); // must start a line
      const stop = next === -1 || next > end ? end : next;
      const partEnd = stop === end ? end : stop - (buf[stop - 2] === 0x0d ? 2 : 1);
      if (partEnd > partStart) walk(buf, partStart, partEnd, out, depth + 1);
      pos = next === -1 || next >= end ? -1 : next;
    }
    return;
  }

  const filename = decodeParam(disposition.params, 'filename') ?? decodeParam(type.params, 'name');
  const isText = type.value === 'text/plain' || type.value === 'text/html';
  const isAttachment = disposition.value === 'attachment' || headers.has('content-id') || !isText;
  if (!isAttachment) {
    const key = type.value === 'text/html' ? 'html' : 'text';
    if (out[key] == null) {
      out[key] = decodeBody(buf, bodyStart, end, encoding, type.params.charset);
      return;
    }
    // A second body part of the same type. Named parts are files; unnamed ones are body pieces
    // some clients split around inline images.
    if (!filename) {
      out[key] += (key === 'text' ? '\n' : '') + decodeBody(buf, bodyStart, end, encoding, type.params.charset);
      return;
    }
  }

  const length = Math.max(0, end - bodyStart);
  out.attachments.push({
    filename,
    contentType: type.value || 'application/octet-stream',
    contentId: headers.get('content-id')?.replace(/^<|>$/g, '').trim() || null,
    inline: disposition.value === 'inline' || headers.has('content-id'),
    encoding,
    offset: bodyStart,
    length,
    approxSize: encoding === 'base64' ? Math.floor(length * 0.74) : length,
  });
}

export function scan(raw: ArrayBuffer | Uint8Array): ScanResult {
  const buf = raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : Buffer.from(raw);
  const { headerText } = splitHeaders(buf, 0, buf.length);
  const headerList = headerLines(headerText);
  const out: ScanResult = {
    headers: Object.fromEntries(headerMap(headerList)),
    headerList,
    text: null,
    html: null,
    attachments: [],
  };
  walk(buf, 0, buf.length, out, 0);
  return out;
}
