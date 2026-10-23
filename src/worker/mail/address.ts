// Address list parsing (RFC 5322, forgiving): "Ann <a@x>", "Last, First" <b@y>, c@z, group: d@w;
import { decodeWords } from './headers';

export interface Address {
  name: string;
  address: string;
}

// Splits on commas outside quotes, angle brackets and comments; also drops group syntax.
function splitList(input: string): string[] {
  const items: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      current += ch + input[++i];
      continue;
    }
    if (!comment && ch === '"') quoted = !quoted;
    else if (!quoted && ch === '(') comment++;
    else if (!quoted && ch === ')' && comment) comment--;
    else if (!quoted && !comment && ch === '<') angle++;
    else if (!quoted && !comment && ch === '>' && angle) angle--;
    if (!quoted && !comment && !angle && (ch === ',' || ch === ';')) {
      items.push(current);
      current = '';
      continue;
    }
    if (!quoted && !comment && !angle && ch === ':' && !current.includes('@')) {
      current = ''; // "Group name:" prefix
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((s) => s.trim()).filter(Boolean);
}

const ADDRESS_RE = /[^\s<>(),;:"]+@[^\s<>(),;:"]+/;

export function parseAddress(item: string): Address | null {
  const angle = /<([^<>]*)>/.exec(item);
  let address: string;
  let name: string;
  if (angle) {
    address = angle[1].trim();
    name = (item.slice(0, angle.index) + item.slice(angle.index + angle[0].length)).trim();
  } else {
    const m = ADDRESS_RE.exec(item);
    if (!m) return null;
    address = m[0];
    name = item.replace(m[0], '').trim();
  }
  // A comment holds the name in the old "a@x (Ann)" form.
  const comment = /^\((.*)\)$/.exec(name);
  if (comment) name = comment[1];
  name = name.replace(/\([^)]*\)/g, '').trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  address = address.replace(/^mailto:/i, '').trim();
  if (!address.includes('@')) return null;
  return { name: singleLine(decodeWords(name)).trim(), address: normalizeAddress(address) };
}

export function parseAddressList(input: string | null | undefined): Address[] {
  if (!input) return [];
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const item of splitList(input)) {
    const a = parseAddress(item);
    if (a && !seen.has(a.address)) {
      seen.add(a.address);
      out.push(a);
    }
  }
  return out;
}

// Lowercases the domain; the local part is kept (it is technically case sensitive, but every
// address OpenInbox owns is stored lowercase and matched case-insensitively).
export function normalizeAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return address.trim().toLowerCase();
  return (address.slice(0, at) + '@' + address.slice(at + 1)).trim().toLowerCase();
}

// Text bound for a header or an SMTP command stays on one line: a CR or LF (say, from a decoded
// encoded-word in a sender's name) would start a new header or command.
export function singleLine(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ');
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

export function localPart(address: string): string {
  return address.slice(0, address.lastIndexOf('@'));
}

// name+tag@domain -> name@domain
export function stripPlusTag(address: string): string | null {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const plus = local.indexOf('+');
  if (plus <= 0) return null;
  return local.slice(0, plus) + address.slice(at);
}

const VALID_ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function isValidAddress(address: string): boolean {
  return address.length <= 254 && VALID_ADDRESS.test(address);
}

export const VALID_LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/i;

export function formatAddress({ name, address }: Address): string {
  return name ? `${name} <${address}>` : address;
}
