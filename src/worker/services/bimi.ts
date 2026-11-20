// Sender logos (BIMI): stores a domain's logo and mark certificate, serves them publicly, and
// keeps the domain's default._bimi record pointing at them.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { first, run } from '../db/db';
import type { Cloudflare } from '../cloudflare/client';
import { applyActions, applyRecords, type DnsAction } from '../cloudflare/dns';
import { unquoteTxt } from '../cloudflare/spf';
import { badRequest, errorMessage, HttpError } from '../lib/errors';
import { BIMI_MAX_SVG, bimiRecord, checkBimiSvg, checkCertificate, dmarcEnforced, enforcedDmarc, isBimi } from '../mail/bimi';
import { readLimited } from './sender-logos';
import { getDomain, requireCf } from './domains';

interface LogoRow {
  svg: string;
  certificate: string | null;
  updated_at: number;
}

export interface SenderLogo {
  logo: { url: string; certificateUrl: string | null; updatedAt: number } | null;
  // The default._bimi record OpenInbox wants, and what the zone has now.
  record: { name: string; expected: string | null; current: string | null };
  // fix: the record enforceDmarc would write, when the policy isn't enforced yet.
  dmarc: { record: string | null; enforced: boolean; fix: string | null };
  // Mail apps fetch logos over HTTPS only.
  https: boolean;
}

// The version in the file names changes the record on every upload, so mail apps that cache
// logos by URL fetch the new one.
function urls(base: string, domain: string, row: Pick<LogoRow, 'certificate' | 'updated_at'>) {
  const dir = `${base}/api/bimi/${domain}`;
  return { url: `${dir}/logo-${row.updated_at}.svg`, certificateUrl: row.certificate ? `${dir}/certificate-${row.updated_at}.pem` : null };
}

async function txt(cf: Cloudflare, zoneId: string, name: string): Promise<string[]> {
  const records = await cf.get<{ content: string }[]>(`/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`);
  return records.map((r) => unquoteTxt(r.content));
}

export async function getSenderLogo(env: Env, settings: AppSettings, base: string, domainId: number): Promise<SenderLogo> {
  const d = await getDomain(env.DB, domainId);
  const row = await first<LogoRow>(env.DB, 'SELECT svg, certificate, updated_at FROM sender_logos WHERE domain_id = ?', d.id);
  const cf = await requireCf(env, settings);
  const name = `default._bimi.${d.name}`;
  const [bimi, dmarc] = await Promise.all([txt(cf, d.zone_id, name), txt(cf, d.zone_id, `_dmarc.${d.name}`)]);
  const logo = row ? { ...urls(base, d.name, row), updatedAt: row.updated_at } : null;
  const dmarcRecord = dmarc.find((r) => /^v=DMARC1/i.test(r)) ?? null;
  return {
    logo,
    record: { name, expected: logo ? bimiRecord(logo.url, logo.certificateUrl) : null, current: bimi.find(isBimi) ?? null },
    dmarc: { record: dmarcRecord, enforced: dmarcEnforced(dmarcRecord), fix: dmarcEnforced(dmarcRecord) ? null : enforcedDmarc(dmarcRecord) },
    https: base.startsWith('https://'),
  };
}

// A logo at an address, such as the brand's site, for the dialog to preview and then save like an
// uploaded file. The server fetches it because most sites don't let a browser read them from
// another origin. It is stored, not linked, so a change at that address can't break the logo.
export async function fetchLogo(url: string): Promise<string> {
  if (!url.startsWith('https://')) throw badRequest('Use an https:// address.', 'invalid_logo');
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'image/svg+xml' }, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw badRequest(`The logo could not be loaded: ${errorMessage(e)}`, 'logo_unreachable');
  }
  if (!res.ok) throw badRequest(`The logo could not be loaded (HTTP ${res.status}).`, 'logo_unreachable');
  const svg = await readLimited(res, BIMI_MAX_SVG);
  if (svg === null) throw badRequest('The logo is larger than 32 KB, the size mail apps accept.', 'invalid_logo');
  const problem = checkBimiSvg(svg);
  if (problem) throw badRequest(problem, 'invalid_logo');
  return svg;
}

// Leaving out the logo or the certificate keeps the stored one; a null certificate removes it.
export async function setSenderLogo(env: Env, settings: AppSettings, base: string, domainId: number, input: { svg?: string; certificate?: string | null }): Promise<SenderLogo> {
  const d = await getDomain(env.DB, domainId);
  const stored = await first<LogoRow>(env.DB, 'SELECT svg, certificate, updated_at FROM sender_logos WHERE domain_id = ?', d.id);
  const svg = input.svg ?? stored?.svg;
  if (!svg) throw badRequest('Choose an SVG logo.', 'invalid_logo');
  const certificate = input.certificate === undefined ? (stored?.certificate ?? null) : input.certificate?.trim() || null;
  const problem = checkBimiSvg(svg) ?? (certificate ? checkCertificate(certificate) : null);
  if (problem) throw badRequest(problem, 'invalid_logo');
  const cf = await requireCf(env, settings);
  const row = { certificate, updated_at: Date.now() };
  await run(
    env.DB,
    'INSERT INTO sender_logos (domain_id, svg, certificate, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (domain_id) DO UPDATE SET svg = excluded.svg, certificate = excluded.certificate, updated_at = excluded.updated_at',
    d.id,
    svg,
    certificate,
    row.updated_at,
  );
  const { url, certificateUrl } = urls(base, d.name, row);
  const [result] = await applyRecords(cf, d.zone_id, d.name, [{ type: 'TXT', name: 'default._bimi', content: bimiRecord(url, certificateUrl), purpose: 'bimi' }]);
  if (!result?.ok) throw new HttpError(502, 'dns_failed', `The logo is saved, but the default._bimi record could not be written: ${result?.message ?? 'unknown error'}`);
  return getSenderLogo(env, settings, base, d.id);
}

// Enforces the domain's DMARC policy, which mail apps need before they show the logo. Mail that
// fails DMARC then goes to spam, so the admin confirms it in the dialog first.
export async function enforceDmarc(env: Env, settings: AppSettings, domainId: number): Promise<SenderLogo['dmarc']> {
  const d = await getDomain(env.DB, domainId);
  const cf = await requireCf(env, settings);
  const name = `_dmarc.${d.name}`;
  const records = await cf.get<{ id: string; content: string }[]>(`/zones/${d.zone_id}/dns_records?type=TXT&name=${encodeURIComponent(name)}`);
  const dmarc = records.filter((r) => /^v=DMARC1/i.test(unquoteTxt(r.content)));
  if (dmarc.length > 1) throw badRequest(`${name} has ${dmarc.length} DMARC records, so receivers ignore them all. Keep one in Cloudflare DNS, then try again.`, 'dmarc_duplicate');
  const content = enforcedDmarc(dmarc[0] ? unquoteTxt(dmarc[0].content) : null);
  const spec = { type: 'TXT' as const, name: '_dmarc', content, purpose: 'dmarc' as const };
  const action: DnsAction = dmarc[0] ? { op: 'update', spec, name, type: 'TXT', content, recordId: dmarc[0].id } : { op: 'create', spec, name, type: 'TXT', content };
  const [result] = await applyActions(cf, d.zone_id, [action]);
  if (!result?.ok) throw new HttpError(502, 'dns_failed', `The DMARC record could not be written: ${result?.message ?? 'unknown error'}`);
  return { record: content, enforced: true, fix: null };
}

// Removes the logo and the domain's BIMI record, whoever wrote it: it would point nowhere.
export async function removeSenderLogo(env: Env, settings: AppSettings, domainId: number): Promise<void> {
  const d = await getDomain(env.DB, domainId);
  const cf = await requireCf(env, settings);
  const records = await cf.get<{ id: string; content: string }[]>(`/zones/${d.zone_id}/dns_records?type=TXT&name=${encodeURIComponent(`default._bimi.${d.name}`)}`);
  for (const r of records.filter((x) => isBimi(unquoteTxt(x.content)))) await cf.request('DELETE', `/zones/${d.zone_id}/dns_records/${r.id}`);
  await run(env.DB, 'DELETE FROM sender_logos WHERE domain_id = ?', d.id);
}

// The public files. Any version in the name serves the current file, so a mail app that fetches
// an older URL still gets a logo.
export async function senderLogoFile(env: Env, domain: string, file: string): Promise<{ body: string; type: string } | null> {
  const kind = /^logo(-\d+)?\.svg$/.test(file) ? 'svg' : /^certificate(-\d+)?\.pem$/.test(file) ? 'pem' : null;
  if (!kind) return null;
  const row = await first<LogoRow>(env.DB, 'SELECT l.svg, l.certificate, l.updated_at FROM sender_logos l JOIN domains d ON d.id = l.domain_id WHERE d.name = ?', domain.toLowerCase());
  if (!row) return null;
  if (kind === 'svg') return { body: row.svg, type: 'image/svg+xml' };
  return row.certificate ? { body: row.certificate, type: 'application/pem-certificate-chain' } : null;
}
