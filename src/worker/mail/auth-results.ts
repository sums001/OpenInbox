// Reads SPF, DKIM and DMARC results from the Authentication-Results header that Cloudflare's MX
// adds. Only the header with authserv-id mx.cloudflare.net is trusted: a sender can put any
// Authentication-Results header in their own message.

export type AuthResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror' | 'policy';

export interface AuthResults {
  spf: AuthResult | null;
  dkim: AuthResult | null;
  dmarc: AuthResult | null;
}

const TRUSTED = ['mx.cloudflare.net'];
const RESULTS = new Set(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'policy']);

function strip(value: string): string {
  return value.replace(/\([^)]*\)/g, ' ');
}

export function parseAuthResults(headerList: [string, string][]): AuthResults {
  const out: AuthResults = { spf: null, dkim: null, dmarc: null };
  for (const [name, value] of headerList) {
    if (name.toLowerCase() !== 'authentication-results') continue;
    const parts = strip(value).split(';').map((p) => p.trim());
    const servId = parts[0]?.split(/\s+/)[0]?.toLowerCase();
    if (!servId || !TRUSTED.includes(servId)) continue;
    for (const part of parts.slice(1)) {
      const m = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(part);
      if (!m) continue;
      const method = m[1].toLowerCase() as keyof AuthResults;
      const result = m[2].toLowerCase();
      if (!RESULTS.has(result)) continue;
      // A message can carry several DKIM signatures; any passing one counts.
      if (method === 'dkim' && out.dkim === 'pass') continue;
      out[method] = result as AuthResult;
    }
    break; // the topmost trusted header is the one Cloudflare added on arrival
  }
  return out;
}

// Spam decision from authentication: DMARC fail, or SPF and DKIM both not passing when both
// were evaluated as failures.
export function authSpamReason(r: AuthResults): string | null {
  if (r.dmarc === 'fail') return 'DMARC check failed';
  const spfBad = r.spf === 'fail' || r.spf === 'softfail';
  const dkimBad = r.dkim === 'fail' || r.dkim === 'none' || r.dkim === null;
  if (spfBad && dkimBad && r.spf !== null) return 'SPF failed and no valid DKIM signature';
  return null;
}
