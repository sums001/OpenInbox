// SPF merge logic. A name must have exactly one SPF record: providers' includes are merged into
// the existing record, never added as a second one.

export function isSpf(content: string): boolean {
  return /^v=spf1(\s|$)/i.test(unquoteTxt(content));
}

// Cloudflare returns TXT content quoted, possibly split into several strings.
export function unquoteTxt(content: string): string {
  const t = content.trim();
  if (!t.startsWith('"')) return t;
  return [...t.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join('');
}

function tokens(content: string): string[] {
  return unquoteTxt(content).trim().split(/\s+/).slice(1).filter(Boolean);
}

const isAll = (t: string) => /^[+~?-]?all$/i.test(t);
const isRedirect = (t: string) => /^redirect=/i.test(t);

// Merges one or more existing SPF records with the includes a domain needs.
export function mergeSpf(existing: string[], includes: string[]): string {
  const seen = new Set<string>();
  const mechanisms: string[] = [];
  let all: string | null = null;
  let redirect: string | null = null;
  for (const record of existing) {
    for (const t of tokens(record)) {
      if (isAll(t)) {
        all ??= t;
        continue;
      }
      if (isRedirect(t)) {
        redirect ??= t;
        continue;
      }
      const key = t.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        mechanisms.push(t);
      }
    }
  }
  for (const inc of includes) {
    const t = inc.toLowerCase().startsWith('include:') ? inc : `include:${inc}`;
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      mechanisms.push(t);
    }
  }
  // "all" makes redirect= ignored, so keep redirect only when there is no all.
  const tail = all ?? (redirect ? redirect : '~all');
  return ['v=spf1', ...mechanisms, tail].join(' ');
}

export function spfIncludes(content: string): string[] {
  return tokens(content)
    .filter((t) => /^[+~?-]?include:/i.test(t))
    .map((t) => t.replace(/^[+~?-]?include:/i, '').toLowerCase());
}

// Mechanisms that cost a DNS lookup; SPF allows at most 10.
export function spfLookupCount(content: string): number {
  return tokens(content).filter((t) => /^[+~?-]?(include:|a\b|a:|a\/|mx\b|mx:|mx\/|ptr|exists:|redirect=)/i.test(t)).length;
}
