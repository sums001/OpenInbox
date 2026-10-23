// Header field decoding: structured values with parameters (RFC 2045/2231) and encoded words
// (RFC 2047). Headers are read as latin1, so raw UTF-8 (RFC 6532) is repaired here too.
import { Buffer } from 'node:buffer';

export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export interface Structured {
  value: string;
  params: Record<string, string>;
}

// Splits on ";" outside quoted strings: text/html; charset=utf-8; name="a;b.png".
function splitParams(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\' && quoted && i + 1 < input.length) {
      current += ch + input[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

export function parseStructured(value = ''): Structured {
  const [head, ...rest] = splitParams(value);
  const params: Record<string, string> = {};
  for (const p of rest) {
    const i = p.indexOf('=');
    if (i === -1) continue;
    const key = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    params[key] = v;
  }
  return { value: (head ?? '').trim().toLowerCase(), params };
}

function percentDecode(text: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return decodeCharset(new Uint8Array(bytes), charset);
}

// Reads a parameter in any of its forms: name="x", name*=utf-8''x, name*0*=...;name*1*=...
export function decodeParam(params: Record<string, string>, name: string): string | null {
  if (params[`${name}*`] !== undefined) {
    const m = /^([^']*)'[^']*'(.*)$/.exec(params[`${name}*`]);
    return m ? percentDecode(m[2], m[1] || 'utf-8') : percentDecode(params[`${name}*`], 'utf-8');
  }
  if (params[`${name}*0*`] !== undefined || params[`${name}*0`] !== undefined) {
    let charset = 'utf-8';
    let joined = '';
    let encoded = false;
    for (let i = 0; ; i++) {
      const enc = params[`${name}*${i}*`];
      const plain = params[`${name}*${i}`];
      if (enc === undefined && plain === undefined) break;
      if (enc !== undefined) {
        let piece = enc;
        if (i === 0) {
          const m = /^([^']*)'[^']*'(.*)$/.exec(enc);
          if (m) {
            charset = m[1] || 'utf-8';
            piece = m[2];
          }
        }
        encoded = true;
        joined += piece;
      } else joined += plain;
    }
    return encoded ? percentDecode(joined, charset) : joined;
  }
  const v = params[name];
  return v === undefined ? null : decodeWords(v);
}

function qDecode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '_') bytes.push(0x20);
    else if (ch === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(bytes);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

// Raw 8-bit header bytes were read as latin1; if they form valid UTF-8, decode them as UTF-8.
export function repairUtf8(value: string): string {
  if (!/[\x80-\xff]/.test(value)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Buffer.from(value, 'latin1'));
  } catch {
    return value;
  }
}

// Decodes RFC 2047 encoded words. Adjacent words with the same charset are joined before
// decoding, because a multi-byte character may be split across two words.
export function decodeWords(input: string): string {
  if (!input) return '';
  const value = repairUtf8(input);
  if (!value.includes('=?')) return value;
  let out = '';
  let last = 0;
  let prevWasWord = false;
  let pending: { charset: string; bytes: number[] } | null = null;
  const flush = () => {
    if (pending) {
      out += decodeCharset(new Uint8Array(pending.bytes), pending.charset);
      pending = null;
    }
  };
  ENCODED_WORD.lastIndex = 0;
  for (let m = ENCODED_WORD.exec(value); m; m = ENCODED_WORD.exec(value)) {
    const between = value.slice(last, m.index);
    const onlySpace = /^\s*$/.test(between);
    const charset = m[1].split('*')[0].toLowerCase();
    let bytes: Uint8Array;
    try {
      bytes = m[2].toUpperCase() === 'B' ? new Uint8Array(Buffer.from(m[3], 'base64')) : qDecode(m[3]);
    } catch {
      flush();
      out += between + m[0];
      last = m.index + m[0].length;
      prevWasWord = false;
      continue;
    }
    if (pending && onlySpace && pending.charset === charset) {
      for (const b of bytes) pending.bytes.push(b);
    } else {
      flush();
      // Whitespace between two encoded words is not displayed (RFC 2047 section 6.2).
      if (!(prevWasWord && onlySpace)) out += between;
      pending = { charset, bytes: [...bytes] };
    }
    prevWasWord = true;
    last = m.index + m[0].length;
  }
  flush();
  return out + value.slice(last);
}
