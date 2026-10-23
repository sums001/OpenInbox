// Decodes one attachment from the raw .eml on download, using the byte range the scanner
// recorded on arrival. This is where attachment decoding cost is paid, once per download.
import { Buffer } from 'node:buffer';
import { decodeTransfer } from './scan';

export function decodeAttachment(rawRange: Uint8Array, encoding: string | null): Uint8Array {
  const buf = Buffer.from(rawRange.buffer, rawRange.byteOffset, rawRange.byteLength);
  return new Uint8Array(decodeTransfer(buf, (encoding || '7bit').toLowerCase()));
}

// Content types that are safe to show inline in the browser. Anything else (HTML, SVG, XML,
// scripts) is always served as a download so it can't run in the app's origin.
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain|audio\/(mpeg|ogg|wav|webm)|video\/(mp4|webm|ogg))$/i;

export function isInlineSafe(contentType: string): boolean {
  return INLINE_SAFE.test(contentType);
}

export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'file';
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename || 'file')}`;
}
