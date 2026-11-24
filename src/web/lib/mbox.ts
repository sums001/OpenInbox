/**
 * Streaming parser & writer for mbox (RFC 4155) mail archives.
 * Designed to process arbitrarily large files (gigabytes) in the browser
 * using constant memory (~2-4 MB) via chunked slicing.
 */

export interface MboxMessage {
  /** The raw RFC 822 / .eml message content as a Uint8Array */
  bytes: Uint8Array;
  /** Estimated byte offset where this message started in the source file */
  offset: number;
  /** Sequential message index (1-based) */
  index: number;
  /** Destination folder based on Gmail system labels */
  targetFolder: 'inbox' | 'archive' | 'trash' | 'spam';
  /** Custom user tags/labels */
  customLabels: string[];
  /** Whether the message is starred */
  isStarred: boolean;
  /** True when the message exceeded maxMessageBytes and its body was skipped */
  oversized?: boolean;
  /** Byte length of the raw message before unescaping */
  size: number;
}

const enc = new TextEncoder();
const FROM_START = enc.encode('From ');
const FROM_DELIM_LF = enc.encode('\nFrom ');
const FROM_DELIM_CRLF = enc.encode('\r\nFrom ');

const DEFAULT_MAX_MESSAGE_BYTES = 26 * 1024 * 1024;
const MAX_HEADER_SCAN_BYTES = 64 * 1024;
const MAX_CUSTOM_LABELS = 10;
const MAX_LABEL_LENGTH = 60;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * Searches for needle inside buffer, starting at fromIndex.
 */
function findSubarray(buffer: Uint8Array, needle: Uint8Array, fromIndex = 0): number {
  if (needle.length === 0 || buffer.length < needle.length) return -1;
  const max = buffer.length - needle.length;
  const first = needle[0];
  for (let i = fromIndex; i <= max; i++) {
    if (buffer[i] === first) {
      let match = true;
      for (let j = 1; j < needle.length; j++) {
        if (buffer[i + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
  }
  return -1;
}

/**
 * Checks if buffer at `pos` starts with "From " (0x46 0x72 0x6F 0x6D 0x20).
 */
function startsWithFromSpace(buffer: Uint8Array, pos: number): boolean {
  return (
    pos + 5 <= buffer.length &&
    buffer[pos] === 0x46 && // F
    buffer[pos + 1] === 0x72 && // r
    buffer[pos + 2] === 0x6f && // o
    buffer[pos + 3] === 0x6d && // m
    buffer[pos + 4] === 0x20 // ' '
  );
}

/**
 * Unescapes mboxrd / mboxo `>+From ` quote lines using subarray slices and a single allocation.
 * Removes one leading `>` on lines matching `\n(>+)From `.
 */
function cleanMboxMessage(rawBytes: Uint8Array): Uint8Array {
  const skipOffsets: number[] = [];
  for (let i = 0; i < rawBytes.length - 6; i++) {
    if (rawBytes[i] !== 0x0a) continue; // '\n'
    let p = i + 1;
    if (rawBytes[p] !== 0x3e) continue; // '>'
    while (p < rawBytes.length && rawBytes[p] === 0x3e) p++;
    if (startsWithFromSpace(rawBytes, p)) {
      skipOffsets.push(i + 1);
    }
  }
  if (skipOffsets.length === 0) return rawBytes;

  const out = new Uint8Array(rawBytes.length - skipOffsets.length);
  let src = 0;
  let dst = 0;
  for (const skipAt of skipOffsets) {
    const chunk = rawBytes.subarray(src, skipAt);
    out.set(chunk, dst);
    dst += chunk.length;
    src = skipAt + 1;
  }
  const tail = rawBytes.subarray(src);
  out.set(tail, dst);
  return out;
}

/**
 * Gmail system labels that should not be created as custom tags.
 */
const GMAIL_SYSTEM_LABELS = new Set([
  'inbox',
  'archive',
  'trash',
  'bin',
  'spam',
  'starred',
  'unread',
  'read',
  'opened',
  'important',
  'sent',
  'draft',
  'drafts',
  'chats',
  'chat',
  'muted',
  'category personal',
  'category social',
  'category updates',
  'category forums',
  'category promotions',
]);

export interface GmailLabelsInfo {
  targetFolder: 'inbox' | 'archive' | 'trash' | 'spam';
  customLabels: string[];
  isStarred: boolean;
}

/**
 * Extracts only the RFC 2822 header block (before the first blank line), bounded to MAX_HEADER_SCAN_BYTES.
 */
function extractHeaderText(bytes: Uint8Array): string {
  const limit = Math.min(bytes.length, MAX_HEADER_SCAN_BYTES);
  let headerEnd = limit;
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x0a) {
      if (i === 0 || bytes[i - 1] === 0x0a || (i >= 2 && bytes[i - 1] === 0x0d && bytes[i - 2] === 0x0a)) {
        headerEnd = i === 0 ? 0 : bytes[i - 1] === 0x0d ? i - 1 : i;
        break;
      }
      if (i + 1 < limit && bytes[i + 1] === 0x0a) {
        headerEnd = i;
        break;
      }
      if (i + 2 < limit && bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) {
        headerEnd = i;
        break;
      }
    }
  }
  return new TextDecoder('utf-8').decode(bytes.subarray(0, headerEnd));
}

function decodeCharsetBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Browser-safe RFC 2047 encoded-word decoder for header values like `=?UTF-8?Q?...?=`.
 */
function decodeRfc2047(value: string): string {
  if (!value.includes('=?')) return value;
  const collapsed = value.replace(/(\?=)[ \t]+(?==\?)/g, '$1');
  return collapsed.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (full, charset: string, encoding: string, data: string) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        const bin = atob(data.replace(/\s+/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return decodeCharsetBytes(bytes, charset);
      }
      const qp = data.replace(/_/g, ' ');
      const out: number[] = [];
      for (let i = 0; i < qp.length; i++) {
        if (qp[i] === '=' && /^[0-9a-fA-F]{2}$/.test(qp.slice(i + 1, i + 3))) {
          out.push(parseInt(qp.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          out.push(qp.charCodeAt(i) & 0xff);
        }
      }
      return decodeCharsetBytes(new Uint8Array(out), charset);
    } catch {
      return full;
    }
  });
}

/**
 * Splits a comma-separated label list while respecting double-quoted values (e.g. `"Sales, Q1"`).
 */
function splitCsvLabels(unfolded: string): string[] {
  const items: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i];
    if (ch === '"') {
      if (inQuotes && unfolded[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      const trimmed = current.trim();
      if (trimmed) items.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const tail = current.trim();
  if (tail) items.push(tail);
  return items;
}

function sanitizeLabelName(raw: string): string {
  // Strip C0/C1 control chars, collapse whitespace, and enforce labelSchema max length (60)
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, MAX_LABEL_LENGTH).trim();
}

/**
 * Parses Gmail labels and tags from raw RFC 822 message headers (never from the message body).
 */
export function parseGmailLabels(bytes: Uint8Array): GmailLabelsInfo {
  const headerText = extractHeaderText(bytes);
  if (!headerText) {
    return { targetFolder: 'archive', customLabels: [], isStarred: false };
  }

  // Anchor at start of header line; X-Gmail-Labels can be folded across lines
  const match = headerText.match(/(?:^|\r?\n)X-Gmail-Labels:[ \t]*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/i);
  if (!match) {
    return { targetFolder: 'archive', customLabels: [], isStarred: false };
  }

  const unfolded = match[1].replace(/\r?\n[ \t]+/g, ' ');
  const rawLabels = splitCsvLabels(unfolded)
    .map((l) => decodeRfc2047(l).trim())
    .filter(Boolean);

  const lowerSet = new Set(rawLabels.map((l) => l.toLowerCase()));

  // 1. Determine folder: Trash > Spam > Inbox > Archive
  let targetFolder: 'inbox' | 'archive' | 'trash' | 'spam' = 'archive';
  if (lowerSet.has('trash') || lowerSet.has('bin') || lowerSet.has('^k')) {
    targetFolder = 'trash';
  } else if (lowerSet.has('spam') || lowerSet.has('^s')) {
    targetFolder = 'spam';
  } else if (lowerSet.has('inbox') || lowerSet.has('^i')) {
    targetFolder = 'inbox';
  }

  // 2. Starred status
  const isStarred = lowerSet.has('starred') || lowerSet.has('^t');

  // 3. User custom labels (filter out system labels and internal ^ tags)
  const customLabels: string[] = [];
  const seenLower = new Set<string>();
  for (const raw of rawLabels) {
    const label = sanitizeLabelName(raw);
    if (!label) continue;
    const l = label.toLowerCase();
    if (l.startsWith('^')) continue;
    if (GMAIL_SYSTEM_LABELS.has(l)) continue;
    if (!seenLower.has(l)) {
      seenLower.add(l);
      customLabels.push(label);
      if (customLabels.length >= MAX_CUSTOM_LABELS) break;
    }
  }

  return { targetFolder, customLabels, isStarred };
}

/**
 * Strips leading envelope header line ("From <addr> <date>\r?\n") if present.
 */
function stripEnvelopeHeader(bytes: Uint8Array): Uint8Array {
  if (findSubarray(bytes, FROM_START, 0) === 0) {
    const eol = bytes.indexOf(10); // '\n'
    if (eol !== -1) {
      return bytes.subarray(eol + 1);
    }
    return new Uint8Array(0);
  }
  return bytes;
}

function concatParts(parts: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  let ptr = 0;
  for (const p of parts) {
    out.set(p, ptr);
    ptr += p.length;
  }
  return out;
}

/**
 * Asynchronously stream-parses an mbox File or Blob.
 * Yields messages one at a time while maintaining a fixed read buffer.
 */
export async function* streamMbox(
  file: File | Blob,
  chunkSize = 2 * 1024 * 1024,
  onProgress?: (bytesRead: number, totalBytes: number) => void,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
): AsyncGenerator<MboxMessage, void, void> {
  const totalBytes = file.size;
  if (totalBytes === 0) return;

  let fileOffset = 0;
  let carryOver: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  let messageIndex = 0;
  let messageStartOffset = 0;
  let currentMsgParts: Uint8Array[] = [];
  let currentMsgLen = 0;
  let skippingOversized = false;
  let oversizedLen = 0;
  let inEnvelopeLine = false;
  let sawFirstLine = false;

  const appendPart = (part: Uint8Array) => {
    if (part.length === 0) return;
    if (skippingOversized) {
      oversizedLen += part.length;
      return;
    }
    if (currentMsgLen + part.length > maxMessageBytes) {
      skippingOversized = true;
      oversizedLen = currentMsgLen + part.length;
      currentMsgParts = [];
      currentMsgLen = 0;
      return;
    }
    currentMsgParts.push(part.buffer.byteLength > part.byteLength * 2 ? part.slice() : part);
    currentMsgLen += part.length;
  };

  while (fileOffset < totalBytes || carryOver.length > 0) {
    const nextReadSize = Math.min(chunkSize, totalBytes - fileOffset);
    let chunkBytes: Uint8Array;

    if (nextReadSize > 0) {
      const slice = file.slice(fileOffset, fileOffset + nextReadSize);
      chunkBytes = new Uint8Array(await slice.arrayBuffer());
      fileOffset += nextReadSize;
      if (onProgress) onProgress(fileOffset, totalBytes);
    } else {
      chunkBytes = new Uint8Array(0);
    }

    let buffer: Uint8Array<ArrayBuffer>;
    if (carryOver.length > 0 && chunkBytes.length > 0) {
      buffer = new Uint8Array(carryOver.length + chunkBytes.length);
      buffer.set(carryOver, 0);
      buffer.set(chunkBytes, carryOver.length);
      carryOver = new Uint8Array(0);
    } else if (carryOver.length > 0) {
      buffer = carryOver;
      carryOver = new Uint8Array(0);
    } else {
      buffer = chunkBytes as Uint8Array<ArrayBuffer>;
    }

    if (buffer.length === 0) break;

    let searchPos = 0;

    if (inEnvelopeLine) {
      const eol = buffer.indexOf(10);
      if (eol === -1) {
        continue;
      }
      searchPos = eol + 1;
      messageStartOffset = fileOffset - buffer.length + searchPos;
      inEnvelopeLine = false;
    }

    // Handle very first "From " line at byte 0 of file
    if (!sawFirstLine) {
      sawFirstLine = true;
      if (findSubarray(buffer, FROM_START, 0) === 0) {
        const eol = buffer.indexOf(10); // '\n'
        if (eol !== -1) {
          searchPos = eol + 1;
          messageStartOffset = fileOffset - buffer.length + searchPos;
        } else if (fileOffset < totalBytes) {
          inEnvelopeLine = true;
          continue;
        } else {
          // File only has a single "From " line with no message content
          return;
        }
      }
    }

    while (searchPos < buffer.length) {
      let delimLen = 6;
      let nextDelim = findSubarray(buffer, FROM_DELIM_LF, searchPos);
      const crlfDelim = findSubarray(buffer, FROM_DELIM_CRLF, searchPos);

      if (crlfDelim !== -1 && (nextDelim === -1 || crlfDelim < nextDelim)) {
        nextDelim = crlfDelim;
        delimLen = 7;
      }

      if (nextDelim !== -1) {
        appendPart(buffer.subarray(searchPos, nextDelim));

        if (skippingOversized) {
          messageIndex++;
          yield {
            bytes: new Uint8Array(0),
            offset: messageStartOffset,
            index: messageIndex,
            targetFolder: 'archive',
            customLabels: [],
            isStarred: false,
            oversized: true,
            size: oversizedLen,
          };
          skippingOversized = false;
          oversizedLen = 0;
        } else if (currentMsgLen > 0) {
          const fullMsg = concatParts(currentMsgParts, currentMsgLen);
          currentMsgParts = [];
          currentMsgLen = 0;
          const cleaned = cleanMboxMessage(stripEnvelopeHeader(fullMsg));
          if (cleaned.length > 0) {
            messageIndex++;
            const labelsInfo = parseGmailLabels(cleaned);
            yield {
              bytes: cleaned,
              offset: messageStartOffset,
              index: messageIndex,
              targetFolder: labelsInfo.targetFolder,
              customLabels: labelsInfo.customLabels,
              isStarred: labelsInfo.isStarred,
              size: fullMsg.length,
            };
          }
        }

        const envelopeLineStart = nextDelim + delimLen;
        const envelopeEol = buffer.indexOf(10, envelopeLineStart);
        if (envelopeEol !== -1) {
          searchPos = envelopeEol + 1;
          messageStartOffset = fileOffset - buffer.length + searchPos;
        } else {
          if (fileOffset < totalBytes) {
            inEnvelopeLine = true;
          }
          break;
        }
      } else {
        // No more delimiters in this buffer
        if (fileOffset < totalBytes) {
          const keep = Math.min(8, buffer.length - searchPos);
          const safeEnd = buffer.length - keep;
          if (safeEnd > searchPos) {
            appendPart(buffer.subarray(searchPos, safeEnd));
            searchPos = safeEnd;
          }
          carryOver = buffer.slice(searchPos);
        } else {
          appendPart(buffer.subarray(searchPos));
          carryOver = new Uint8Array(0);
        }
        break;
      }
    }
  }

  // Final remaining message if any
  if (skippingOversized) {
    messageIndex++;
    yield {
      bytes: new Uint8Array(0),
      offset: messageStartOffset,
      index: messageIndex,
      targetFolder: 'archive',
      customLabels: [],
      isStarred: false,
      oversized: true,
      size: oversizedLen,
    };
  } else if (currentMsgLen > 0) {
    const fullMsg = concatParts(currentMsgParts, currentMsgLen);
    const cleaned = cleanMboxMessage(stripEnvelopeHeader(fullMsg));
    if (cleaned.length > 0) {
      messageIndex++;
      const labelsInfo = parseGmailLabels(cleaned);
      yield {
        bytes: cleaned,
        offset: messageStartOffset,
        index: messageIndex,
        targetFolder: labelsInfo.targetFolder,
        customLabels: labelsInfo.customLabels,
        isStarred: labelsInfo.isStarred,
        size: fullMsg.length,
      };
    }
  }
}

/**
 * Formats a Date in RFC 4155 asctime UTC format: "Mon Jan  1 00:00:00 2024".
 */
function formatRfc4155Date(date: Date): string {
  const d = Number.isNaN(date.getTime()) ? new Date() : date;
  const dayName = DAYS[d.getUTCDay()];
  const monthName = MONTHS[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, ' ');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${dayName} ${monthName} ${day} ${hh}:${mm}:${ss} ${year}`;
}

/**
 * Formats a message into mboxrd format with an RFC 4155 envelope line,
 * escaping inner `>*From ` lines directly on raw bytes without UTF-8 re-encoding.
 */
export function formatMboxEntry(rawEml: Uint8Array, date = new Date(), fromAddress = 'MAILER-DAEMON'): Uint8Array {
  const safeFrom = fromAddress.replace(/[\s\r\n]+/g, '') || 'MAILER-DAEMON';
  const header = enc.encode(`From ${safeFrom} ${formatRfc4155Date(date)}\r\n`);

  // Find every start-of-line matching `>*From ` directly on bytes
  const escapePositions: number[] = [];
  for (let i = 0; i < rawEml.length; i++) {
    if (i === 0 || rawEml[i - 1] === 0x0a) {
      let p = i;
      while (p < rawEml.length && rawEml[p] === 0x3e) p++; // skip '>'
      if (startsWithFromSpace(rawEml, p)) {
        escapePositions.push(i);
      }
    }
  }

  const endsWithLf = rawEml.length > 0 && rawEml[rawEml.length - 1] === 0x0a;
  const trailer = enc.encode(endsWithLf ? '\r\n' : '\r\n\r\n');

  const out = new Uint8Array(header.length + rawEml.length + escapePositions.length + trailer.length);
  out.set(header, 0);
  let dst = header.length;
  let src = 0;
  for (const pos of escapePositions) {
    if (pos > src) {
      const slice = rawEml.subarray(src, pos);
      out.set(slice, dst);
      dst += slice.length;
    }
    out[dst++] = 0x3e; // '>'
    src = pos;
  }
  if (src < rawEml.length) {
    const tail = rawEml.subarray(src);
    out.set(tail, dst);
    dst += tail.length;
  }
  out.set(trailer, dst);
  return out;
}
