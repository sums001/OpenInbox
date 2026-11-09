// Senders' logos (BIMI), when the admin turns them on. Mail that passes DMARC notes its sender's
// domain; the cron looks up the logo the domain publishes and caches it for a day; the thread
// view shows it next to that sender's messages that passed DMARC. The Worker fetches the logo,
// not the browser, so a sender never learns when or whether a message was read.
//
// Logos aren't checked against a mark certificate (VMC or CMC), which would mean validating an
// X.509 chain and the logo's hash in it. The admin setting says so.
import type { Env } from '../env';
import { all, first, placeholders, run } from '../db/db';
import { unquoteTxt } from '../cloudflare/spf';
import { BIMI_MAX_SVG, checkBimiSvg, dmarcEnforced, isBimi } from '../mail/bimi';
import { DAY, HOUR } from '../lib/time';
import { logError } from '../lib/log';

const DOH = 'https://cloudflare-dns.com/dns-query';
// A lookup makes at most five requests (BIMI and DMARC records at the domain and its
// organizational domain, then the logo). Five domains per run is 25 requests, which run on their
// own cron minute (cron.ts) to stay inside the free plan's 50 subrequests per invocation.
const PER_RUN = 5;
// Domains that haven't sent mail passing DMARC for this long are dropped from the cache.
export const SENDER_LOGO_WINDOW = 30 * DAY;
const VALID_DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const senderDomain = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

// The organizational domain, approximated without the public suffix list: the last two labels,
// or three under a country code's common second level (example.co.uk).
export function orgDomain(domain: string): string {
  const labels = domain.split('.');
  const three = labels.length > 2 && /^[a-z]{2}$/.test(labels[labels.length - 1]) && /^(co|com|net|org|ac|gov|edu|ne|or|go)$/.test(labels[labels.length - 2]);
  return labels.slice(three ? -3 : -2).join('.');
}

// A record's tag, e.g. l= in "v=BIMI1; l=https://…".
export function recordTag(record: string, name: string): string | undefined {
  for (const part of record.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim().toLowerCase() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

// Notes a sender whose mail passed DMARC, at most one write a day per domain.
export function noteSenderStmt(db: D1Database, domain: string, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO sender_logo_cache (domain, seen_at) VALUES (?, ?) ON CONFLICT (domain) DO UPDATE SET seen_at = excluded.seen_at WHERE seen_at < excluded.seen_at - ?')
    .bind(domain, now, DAY);
}

// When the switch is turned on, senders of the last 30 days get their logos too, not only those
// who write again.
export async function noteRecentSenders(db: D1Database): Promise<void> {
  const now = Date.now();
  await run(
    db,
    `INSERT OR IGNORE INTO sender_logo_cache (domain, seen_at)
       SELECT DISTINCT lower(substr(from_addr, instr(from_addr, '@') + 1)), ? FROM messages
        WHERE direction = 'in' AND dmarc = 'pass' AND instr(from_addr, '@') > 0 AND created_at > ?`,
    now,
    now - SENDER_LOGO_WINDOW,
  );
}

async function txt(name: string): Promise<string[]> {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`DNS lookup for ${name} failed (${res.status})`);
  const r = await res.json<{ Answer?: { type: number; data: string }[] }>();
  return (r.Answer ?? []).filter((a) => a.type === 16).map((a) => unquoteTxt(a.data));
}

// Looks at the domain, then its organizational domain.
async function findRecord(domain: string, prefix: string, match: (r: string) => boolean): Promise<string | null> {
  const org = orgDomain(domain);
  for (const d of org === domain ? [domain] : [domain, org]) {
    const found = (await txt(`${prefix}.${d}`)).find(match);
    if (found) return found;
  }
  return null;
}

async function readLimited(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get('content-length') ?? 0) > max || !res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

// The domain's logo, or null when it publishes none, declines (empty l=), doesn't enforce DMARC,
// or serves something that isn't a valid SVG Tiny PS logo over HTTPS.
export async function lookupLogo(domain: string): Promise<string | null> {
  const record = await findRecord(domain, 'default._bimi', isBimi);
  const url = record ? recordTag(record, 'l')?.split(',')[0].trim() : undefined;
  if (!url?.startsWith('https://')) return null;
  if (!dmarcEnforced(await findRecord(domain, '_dmarc', (r) => /^v=DMARC1/i.test(r)))) return null;
  const res = await fetch(url, { headers: { accept: 'image/svg+xml' }, signal: AbortSignal.timeout(5000) });
  // res.url is where redirects ended (empty for a response that wasn't fetched, as in tests).
  if (!res.ok || !(res.url || url).startsWith('https://')) return null;
  const svg = await readLimited(res, BIMI_MAX_SVG);
  return svg && !checkBimiSvg(svg) ? svg : null;
}

// Cron: looks up the logos that are due, oldest first. A failed lookup keeps what was cached and
// is tried again in an hour.
export async function refreshSenderLogos(env: Env): Promise<number> {
  const now = Date.now();
  const due = await all<{ domain: string }>(env.DB, 'SELECT domain FROM sender_logo_cache WHERE checked_at < ? ORDER BY checked_at LIMIT ?', now - DAY, PER_RUN);
  for (const { domain } of due) {
    try {
      const svg = VALID_DOMAIN.test(domain) ? await lookupLogo(domain) : null;
      await run(env.DB, 'UPDATE sender_logo_cache SET svg = ?, checked_at = ? WHERE domain = ?', svg, now, domain);
    } catch (e) {
      logError('sender_logo.lookup', e, { domain });
      await run(env.DB, 'UPDATE sender_logo_cache SET checked_at = ? WHERE domain = ?', now - DAY + HOUR, domain);
    }
  }
  return due.length;
}

// Domains among these with a cached logo, and when it was checked (a version for its URL).
export async function cachedLogos(db: D1Database, domains: string[]): Promise<Map<string, number>> {
  if (!domains.length) return new Map();
  const rows = await all<{ domain: string; checked_at: number }>(
    db,
    `SELECT domain, checked_at FROM sender_logo_cache WHERE svg IS NOT NULL AND domain IN (${placeholders(domains.length)})`,
    ...domains,
  );
  return new Map(rows.map((r) => [r.domain, r.checked_at]));
}

// The thread view's logo URLs: only for received messages that passed DMARC, so mail spoofing a
// domain never shows its logo.
export async function withSenderLogos<M extends { direction: string; from: { address: string }; auth: { dmarc: string | null }; fromLogo: string | null }>(db: D1Database, messages: M[]): Promise<M[]> {
  const passed = messages.filter((m) => m.direction === 'in' && m.auth.dmarc === 'pass' && m.from.address.includes('@'));
  const logos = await cachedLogos(db, [...new Set(passed.map((m) => senderDomain(m.from.address)))]);
  for (const m of passed) {
    const domain = senderDomain(m.from.address);
    const version = logos.get(domain);
    if (version) m.fromLogo = `/api/sender-logos/${encodeURIComponent(domain)}?v=${version}`;
  }
  return messages;
}

export async function senderLogoSvg(db: D1Database, domain: string): Promise<string | null> {
  return (await first<{ svg: string | null }>(db, 'SELECT svg FROM sender_logo_cache WHERE domain = ?', domain.toLowerCase()))?.svg ?? null;
}
