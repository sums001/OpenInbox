// DNS record automation: plan the changes a set of desired records needs against what the zone
// already has, then apply them. Planning is pure, so it is unit tested; applying is idempotent.
import type { Cloudflare } from './client';
import { isSpf, mergeSpf, spfIncludes, unquoteTxt } from './spf';

export type RecordPurpose = 'spf' | 'dkim' | 'dmarc' | 'verification' | 'return-path' | 'mx' | 'tracking' | 'other';

export interface DnsRecordSpec {
  type: 'TXT' | 'CNAME' | 'MX';
  name: string; // relative ("send", "@") or fully qualified
  content: string; // TXT value without quotes, CNAME or MX target
  priority?: number;
  purpose?: RecordPurpose;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied?: boolean;
  ttl?: number;
}

export type DnsAction =
  | { op: 'noop'; spec: DnsRecordSpec; name: string; recordId: string }
  | { op: 'create'; spec: DnsRecordSpec; name: string; type: string; content: string; priority?: number }
  | { op: 'update'; spec: DnsRecordSpec; name: string; type: string; content: string; priority?: number; recordId: string }
  | { op: 'delete'; name: string; recordId: string; reason: string }
  | { op: 'conflict'; spec: DnsRecordSpec; name: string; message: string };

export function fqdn(name: string, domain: string): string {
  const n = name.trim().replace(/\.$/, '').toLowerCase();
  const d = domain.toLowerCase();
  if (n === '' || n === '@' || n === d) return d;
  return n.endsWith(`.${d}`) ? n : `${n}.${d}`;
}

const sameHost = (a: string, b: string) => a.replace(/\.$/, '').toLowerCase() === b.replace(/\.$/, '').toLowerCase();
const isDkim = (content: string) => /(^|;)\s*(v=DKIM1|k=rsa|p=)/i.test(unquoteTxt(content));
const isDmarc = (content: string) => /^v=DMARC1/i.test(unquoteTxt(content));

function purposeOf(spec: DnsRecordSpec): RecordPurpose {
  if (spec.purpose) return spec.purpose;
  if (spec.type === 'TXT' && isSpf(spec.content)) return 'spf';
  if (spec.type === 'TXT' && isDmarc(spec.content)) return 'dmarc';
  if (spec.type === 'TXT' && isDkim(spec.content)) return 'dkim';
  return spec.type === 'MX' ? 'mx' : 'other';
}

export function planRecords(domain: string, existing: CfDnsRecord[], desired: DnsRecordSpec[]): DnsAction[] {
  const actions: DnsAction[] = [];
  // SPF specs for the same name merge into one action.
  const spfByName = new Map<string, DnsRecordSpec[]>();

  for (const spec of desired) {
    const name = fqdn(spec.name, domain);
    const atName = existing.filter((r) => sameHost(r.name, name));
    const purpose = purposeOf(spec);

    if (spec.type === 'TXT' && purpose === 'spf') {
      spfByName.set(name, [...(spfByName.get(name) ?? []), spec]);
      continue;
    }

    if (spec.type === 'TXT' && purpose === 'dmarc') {
      const found = atName.find((r) => r.type === 'TXT' && isDmarc(r.content));
      actions.push(found ? { op: 'noop', spec, name, recordId: found.id } : { op: 'create', spec, name, type: 'TXT', content: spec.content });
      continue;
    }

    if (spec.type === 'TXT') {
      const exact = atName.find((r) => r.type === 'TXT' && unquoteTxt(r.content) === spec.content);
      if (exact) {
        actions.push({ op: 'noop', spec, name, recordId: exact.id });
        continue;
      }
      const cname = atName.find((r) => r.type === 'CNAME');
      if (cname) {
        actions.push({ op: 'conflict', spec, name, message: `${name} is a CNAME, so it can't also hold a TXT record.` });
        continue;
      }
      // A DKIM key at the same name is replaced; anything else gets an extra TXT record.
      const old = purpose === 'dkim' ? atName.find((r) => r.type === 'TXT' && isDkim(r.content)) : undefined;
      actions.push(
        old
          ? { op: 'update', spec, name, type: 'TXT', content: spec.content, recordId: old.id }
          : { op: 'create', spec, name, type: 'TXT', content: spec.content },
      );
      continue;
    }

    if (spec.type === 'CNAME') {
      const cname = atName.find((r) => r.type === 'CNAME');
      if (cname) {
        actions.push(
          sameHost(cname.content, spec.content)
            ? { op: 'noop', spec, name, recordId: cname.id }
            : { op: 'update', spec, name, type: 'CNAME', content: spec.content, recordId: cname.id },
        );
      } else if (atName.length) {
        actions.push({ op: 'conflict', spec, name, message: `${name} already has ${atName.map((r) => r.type).join(', ')} records, so it can't be a CNAME.` });
      } else {
        actions.push({ op: 'create', spec, name, type: 'CNAME', content: spec.content });
      }
      continue;
    }

    // MX
    const mx = atName.find((r) => r.type === 'MX' && sameHost(r.content, spec.content));
    if (mx) {
      actions.push(
        mx.priority === undefined || spec.priority === undefined || mx.priority === spec.priority
          ? { op: 'noop', spec, name, recordId: mx.id }
          : { op: 'update', spec, name, type: 'MX', content: spec.content, priority: spec.priority, recordId: mx.id },
      );
    } else if (atName.some((r) => r.type === 'CNAME')) {
      actions.push({ op: 'conflict', spec, name, message: `${name} is a CNAME, so it can't hold MX records.` });
    } else {
      actions.push({ op: 'create', spec, name, type: 'MX', content: spec.content, priority: spec.priority ?? 10 });
    }
  }

  for (const [name, specs] of spfByName) {
    const records = existing.filter((r) => sameHost(r.name, name) && r.type === 'TXT' && isSpf(r.content));
    const includes = specs.flatMap((s) => spfIncludes(s.content));
    if (!records.length) {
      actions.push({ op: 'create', spec: specs[0], name, type: 'TXT', content: mergeSpf(specs.map((s) => s.content), []) });
      continue;
    }
    const merged = mergeSpf(records.map((r) => r.content), includes);
    const [keep, ...extra] = records;
    actions.push(
      unquoteTxt(keep.content) === merged
        ? { op: 'noop', spec: specs[0], name, recordId: keep.id }
        : { op: 'update', spec: specs[0], name, type: 'TXT', content: merged, recordId: keep.id },
    );
    // Two SPF records at one name make SPF fail everywhere; merging repairs that.
    for (const r of extra) actions.push({ op: 'delete', name, recordId: r.id, reason: 'merged duplicate SPF record' });
  }
  return actions;
}

// TXT strings longer than 255 characters must be split into several quoted strings.
export function quoteTxt(content: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += 255) chunks.push(content.slice(i, i + 255));
  return chunks.map((c) => `"${c.replace(/(["\\])/g, '\\$1')}"`).join(' ');
}

export function listRecords(cf: Cloudflare, zoneId: string): Promise<CfDnsRecord[]> {
  return cf.paginate<CfDnsRecord>(`/zones/${zoneId}/dns_records`, 100, 20);
}

export interface AppliedRecord {
  name: string;
  type: string;
  op: DnsAction['op'];
  ok: boolean;
  message?: string;
}

export async function applyActions(cf: Cloudflare, zoneId: string, actions: DnsAction[]): Promise<AppliedRecord[]> {
  const results: AppliedRecord[] = [];
  for (const a of actions) {
    const type = a.op === 'delete' ? 'TXT' : a.op === 'create' || a.op === 'update' ? a.type : a.spec.type;
    try {
      if (a.op === 'create' || a.op === 'update') {
        const body: Record<string, unknown> = {
          type: a.type,
          name: a.name,
          content: a.type === 'TXT' ? quoteTxt(a.content) : a.content,
          ttl: 1,
          comment: 'Managed by OpenInbox',
        };
        if (a.type === 'CNAME') body.proxied = false;
        if (a.type === 'MX') body.priority = a.priority ?? 10;
        if (a.op === 'create') await cf.request('POST', `/zones/${zoneId}/dns_records`, body);
        else await cf.request('PUT', `/zones/${zoneId}/dns_records/${a.recordId}`, body);
      } else if (a.op === 'delete') {
        await cf.request('DELETE', `/zones/${zoneId}/dns_records/${a.recordId}`);
      }
      results.push({ name: a.name, type, op: a.op, ok: a.op !== 'conflict', message: a.op === 'conflict' ? a.message : undefined });
    } catch (e) {
      results.push({ name: a.name, type, op: a.op, ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

export async function applyRecords(cf: Cloudflare, zoneId: string, domain: string, desired: DnsRecordSpec[]): Promise<AppliedRecord[]> {
  const existing = await listRecords(cf, zoneId);
  return applyActions(cf, zoneId, planRecords(domain, existing, desired));
}
