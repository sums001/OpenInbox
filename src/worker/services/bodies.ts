// Fits a message's searchable fields and bodies into one D1 row (2 MB limit), clipping the HTML
// last. Clipped messages are flagged so the UI can offer the original .eml when it was kept.
import { Buffer } from 'node:buffer';

const ROW_BUDGET = 1_900_000;
const TEXT_MAX = 400_000;
const HEADERS_MAX = 64_000;
const ADDR_MAX = 16_000;

export function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function clipUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (s.length <= maxBytes / 3 || utf8Length(s) <= maxBytes) return s;
  let lo = 0;
  let hi = Math.min(s.length, maxBytes);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8Length(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // Don't cut a surrogate pair in half.
  const code = s.charCodeAt(lo - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? lo - 1 : lo);
}

export interface BodyFields {
  subject: string;
  fromText: string;
  toText: string;
  text: string;
  html: string | null;
  headers: string;
  truncated: boolean;
}

export function fitBody(input: { subject: string; fromText: string; toText: string; text: string; html: string | null; headers: [string, string][] }): BodyFields {
  const subject = clipUtf8(input.subject, 4000);
  const fromText = clipUtf8(input.fromText, 2000);
  const toText = clipUtf8(input.toText, ADDR_MAX);
  let headersJson = JSON.stringify(input.headers);
  if (utf8Length(headersJson) > HEADERS_MAX) {
    const kept: [string, string][] = [];
    let size = 2;
    for (const h of input.headers) {
      const len = utf8Length(JSON.stringify(h)) + 1;
      if (size + len > HEADERS_MAX) break;
      kept.push(h);
      size += len;
    }
    headersJson = JSON.stringify(kept);
  }
  const text = clipUtf8(input.text, TEXT_MAX);
  let truncated = text.length < input.text.length;
  let html = input.html;
  if (html != null) {
    const used = utf8Length(subject) + utf8Length(fromText) + utf8Length(toText) + utf8Length(headersJson) + utf8Length(text) + 1024;
    const clipped = clipUtf8(html, ROW_BUDGET - used);
    if (clipped.length < html.length) truncated = true;
    html = clipped;
  }
  return { subject, fromText, toText, text, html, headers: headersJson, truncated };
}
