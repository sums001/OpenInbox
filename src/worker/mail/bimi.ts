// BIMI (Brand Indicators for Message Identification): a TXT record at default._bimi.<domain>
// points to a square SVG logo, which mail apps that support BIMI show next to mail from the
// domain once its DMARC policy is enforced. Gmail and Apple Mail also need a mark certificate
// (VMC or CMC) from a certificate authority, referenced by the same record.
//
// checkBimiSvg checks the main rules of the SVG Tiny Portable/Secure profile BIMI requires, so an
// admin learns about a rejected logo here rather than from its silent absence in the inbox. It
// is a validator, not a sanitizer: the logo is served with a sandboxing CSP, so nothing in it can
// run in the app's origin even if a check here misses something.

export const BIMI_MAX_SVG = 32 * 1024;
export const BIMI_MAX_CERTIFICATE = 64 * 1024;

const attrs = (tag: string) => new Map([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));

export function checkBimiSvg(svg: string): string | null {
  if (new TextEncoder().encode(svg).length > BIMI_MAX_SVG) return 'The logo is larger than 32 KB, the size mail apps accept.';
  const s = svg.replace(/<!--[\s\S]*?-->/g, '');
  const root = /<svg\b[^>]*>/i.exec(s);
  if (!root) return 'This is not an SVG file.';
  if (s.slice(0, root.index).replace(/<\?xml[^>]*\?>/i, '').trim()) return 'Nothing but the XML declaration may come before the <svg> element (no DOCTYPE).';
  const a = attrs(root[0]);
  if (a.get('baseprofile') !== 'tiny-ps' || a.get('version') !== '1.2') {
    return 'BIMI needs the SVG Tiny PS profile: the <svg> element must have version="1.2" and baseProfile="tiny-ps". Export or convert the logo to SVG Tiny PS.';
  }
  if (a.has('x') || a.has('y')) return 'The <svg> element must not have x or y attributes.';
  const box = a.get('viewbox')?.trim().split(/[\s,]+/).map(Number);
  const [w, h] = box?.length === 4 ? [box[2], box[3]] : [parseFloat(a.get('width') ?? ''), parseFloat(a.get('height') ?? '')];
  if (!(w > 0 && h > 0)) return 'The logo needs a viewBox.';
  if (Math.abs(w - h) > 0.01 * w) return 'The logo must be square.';
  if (!/<title\b[^>]*>[^<]*\S[^<]*<\/title>/i.test(s)) return 'The logo needs a <title> with the brand name.';
  if (/<!ENTITY/i.test(s)) return 'The logo must not declare entities.';
  if (/<\s*(script|foreignObject|iframe|animate\w*|set)\b/i.test(s)) return 'The logo must not contain scripts or animation.';
  if (/\son[a-z]+\s*=/i.test(s)) return 'The logo must not contain event handlers.';
  if (/\s(?:xlink:)?href\s*=\s*["'](?!#)/i.test(s) || /url\(\s*["']?(?!#)/i.test(s)) return 'The logo must not refer to other files or images, only to its own elements.';
  return null;
}

export function checkCertificate(pem: string): string | null {
  if (pem.length > BIMI_MAX_CERTIFICATE) return 'The certificate file is larger than 64 KB.';
  const block = /-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----/g;
  if (!block.test(pem)) return 'The certificate must be a PEM file, starting with -----BEGIN CERTIFICATE-----.';
  if (pem.replace(block, '').trim()) return 'The PEM file may only hold certificates (the VMC or CMC and its chain).';
  return null;
}

// BIMI logos are shown only for mail under an enforced DMARC policy: p=quarantine or p=reject,
// applied to all mail (no pct below 100), with subdomains not exempted by sp=none.
export function dmarcEnforced(record: string | null): boolean {
  if (!record) return false;
  const tags = new Map(record.split(';').map((t) => t.split('=').map((x) => x.trim().toLowerCase()) as [string, string]));
  return (tags.get('p') === 'quarantine' || tags.get('p') === 'reject') && (tags.get('pct') ?? '100') === '100' && tags.get('sp') !== 'none';
}

export function bimiRecord(logoUrl: string, certificateUrl: string | null): string {
  return certificateUrl ? `v=BIMI1; l=${logoUrl}; a=${certificateUrl}` : `v=BIMI1; l=${logoUrl}`;
}

export const isBimi = (content: string) => /^v=BIMI1\b/i.test(content.trim());
