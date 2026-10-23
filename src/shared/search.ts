// Search query parser shared by the Worker (to build the FTS5 query) and the web app (to show
// active filters). Supports: free text, "phrases", -exclusions, from: to: subject: label:
// has:attachment is:unread|read|starred in:inbox|sent|archive|spam|trash|drafts|anywhere
// before:YYYY-MM-DD after:YYYY-MM-DD

export interface ParsedQuery {
  terms: string[];
  phrases: string[];
  exclude: string[];
  from: string[];
  to: string[];
  subject: string[];
  label: string[];
  hasAttachment: boolean;
  isUnread: boolean | null;
  isStarred: boolean;
  in: string | null;
  before: number | null;
  after: number | null;
}

const KEYS = new Set(['from', 'to', 'subject', 'has', 'is', 'in', 'before', 'after', 'label', 'older', 'newer']);

function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /(-?[a-z]+:"[^"]*"|-?"[^"]*"|\S+)/gi;
  for (const m of q.matchAll(re)) out.push(m[1]);
  return out;
}

function parseDate(v: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

export function parseSearch(q: string): ParsedQuery {
  const r: ParsedQuery = {
    terms: [],
    phrases: [],
    exclude: [],
    from: [],
    to: [],
    subject: [],
    label: [],
    hasAttachment: false,
    isUnread: null,
    isStarred: false,
    in: null,
    before: null,
    after: null,
  };
  for (const raw of tokenize(q.trim())) {
    const neg = raw.startsWith('-') && raw.length > 1;
    const tok = neg ? raw.slice(1) : raw;
    const colon = tok.indexOf(':');
    const key = colon > 0 ? tok.slice(0, colon).toLowerCase() : '';
    if (key && KEYS.has(key)) {
      const value = tok.slice(colon + 1).replace(/^"(.*)"$/, '$1').trim();
      if (!value) continue;
      if (key === 'from') r.from.push(value);
      else if (key === 'to') r.to.push(value);
      else if (key === 'subject') r.subject.push(value);
      else if (key === 'label') r.label.push(value);
      else if (key === 'has' && /^attachments?$/i.test(value)) r.hasAttachment = true;
      else if (key === 'is' && /^unread$/i.test(value)) r.isUnread = true;
      else if (key === 'is' && /^read$/i.test(value)) r.isUnread = false;
      else if (key === 'is' && /^starred$/i.test(value)) r.isStarred = true;
      else if (key === 'in') r.in = value.toLowerCase();
      else if (key === 'before' || key === 'older') r.before = parseDate(value);
      else if (key === 'after' || key === 'newer') r.after = parseDate(value);
      continue;
    }
    if (tok.startsWith('"') && tok.endsWith('"') && tok.length > 1) {
      const phrase = tok.slice(1, -1).trim();
      if (phrase) (neg ? r.exclude : r.phrases).push(phrase);
      continue;
    }
    (neg ? r.exclude : r.terms).push(tok);
  }
  return r;
}

export function hasTextQuery(p: ParsedQuery): boolean {
  return !!(p.terms.length || p.phrases.length || p.from.length || p.to.length || p.subject.length);
}

// Builds an FTS5 MATCH expression. Every user value is quoted, so FTS operators in the input
// are treated as text.
export function ftsExpression(p: ParsedQuery): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const parts: string[] = [];
  p.terms.forEach((t, i) => {
    const clean = t.replace(/[^\p{L}\p{N}@._'+-]/gu, ' ').trim();
    if (!clean) return;
    // Prefix-match the last word, so results appear while typing.
    parts.push(i === p.terms.length - 1 && clean.length >= 2 ? `${q(clean)}*` : q(clean));
  });
  for (const ph of p.phrases) parts.push(q(ph));
  for (const v of p.from) parts.push(`from_text : ${q(v)}`);
  for (const v of p.to) parts.push(`to_text : ${q(v)}`);
  for (const v of p.subject) parts.push(`subject : ${q(v)}`);
  let expr = parts.join(' AND ');
  for (const ex of p.exclude) expr = expr ? `${expr} NOT ${q(ex)}` : '';
  return expr;
}
