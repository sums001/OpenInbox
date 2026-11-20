// Sender logos (BIMI, issue #10): upload, the default._bimi record, the public files, removal.
import { beforeEach, describe, expect, it } from 'vitest';
import { useFakeApis } from '../helpers/fake';
import { Client, ORIGIN, setupInstance } from '../helpers/client';
import { unquoteTxt } from '../../src/worker/cloudflare/spf';

const LOGO =
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"><title>Example</title><circle cx="50" cy="50" r="40" fill="#0b5fff"/></svg>';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----\n';

describe('sender logo', () => {
  let fake: ReturnType<typeof useFakeApis>;
  let admin: Client;
  let domainId: number;
  const bimiRecords = () => fake.state.dns.zone_example.filter((r) => r.name === 'default._bimi.example.com');

  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    ({ domainId } = await setupInstance(admin));
  });

  it('publishes the logo and points default._bimi at it', async () => {
    const before = await admin.get(`/api/admin/domains/${domainId}/logo`);
    expect(before).toMatchObject({ logo: null, https: true, record: { name: 'default._bimi.example.com', expected: null, current: null } });
    // Setup adds p=none, which mail apps don't show logos for.
    expect(before.dmarc).toEqual({ record: 'v=DMARC1; p=none', enforced: false, fix: 'v=DMARC1; p=quarantine' });

    const res = await admin.request('PUT', `/api/admin/domains/${domainId}/logo`, { svg: LOGO.replace('baseProfile="tiny-ps" ', '') });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('invalid_logo');

    const r = await admin.put(`/api/admin/domains/${domainId}/logo`, { svg: LOGO });
    expect(r.logo.url).toMatch(new RegExp(`^${ORIGIN}/api/bimi/example\\.com/logo-\\d+\\.svg$`));
    expect(r.record.current).toBe(`v=BIMI1; l=${r.logo.url}`);
    expect(r.record.expected).toBe(r.record.current);
    expect(bimiRecords()).toHaveLength(1);
    expect((await admin.get('/api/admin/domains')).find((d: { id: number }) => d.id === domainId).logoUpdatedAt).toBe(r.logo.updatedAt);

    // Public, without a session, and sandboxed.
    const file = await new Client().request('GET', new URL(r.logo.url).pathname);
    expect(file.status).toBe(200);
    expect(file.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(file.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(await file.text()).toBe(LOGO);
    expect(await new Client().status('GET', '/api/bimi/example.com/logo.svg')).toBe(200);
    expect(await new Client().status('GET', '/api/bimi/example.com/certificate.pem')).toBe(404);
    expect(await new Client().status('GET', '/api/bimi/other.test/logo.svg')).toBe(404);
    expect(await new Client().status('GET', '/api/bimi/example.com/secrets.txt')).toBe(404);

    // Adding a certificate keeps the logo and replaces the record rather than adding one.
    const withCert = await admin.put(`/api/admin/domains/${domainId}/logo`, { certificate: PEM });
    expect(withCert.record.current).toBe(`v=BIMI1; l=${withCert.logo.url}; a=${withCert.logo.certificateUrl}`);
    expect(bimiRecords()).toHaveLength(1);
    const pem = await new Client().request('GET', new URL(withCert.logo.certificateUrl).pathname);
    expect(new TextDecoder().decode(await pem.arrayBuffer())).toBe(PEM.trim());
    expect((await admin.request('PUT', `/api/admin/domains/${domainId}/logo`, { certificate: 'not a certificate' })).status).toBe(400);

    await admin.del(`/api/admin/domains/${domainId}/logo`);
    expect(bimiRecords()).toHaveLength(0);
    expect(await new Client().status('GET', new URL(r.logo.url).pathname)).toBe(404);
    expect((await admin.get(`/api/admin/domains/${domainId}/logo`)).logo).toBeNull();
  });

  it('enforces DMARC in one click, keeping the record\'s other tags', async () => {
    const dmarc = () => fake.state.dns.zone_example.filter((r) => r.name === '_dmarc.example.com');
    expect(dmarc()).toHaveLength(1);
    // Setup added p=none; the fix keeps any reports the record asks for.
    dmarc()[0].content = '"v=DMARC1; p=none; rua=mailto:rua@reports.test"';
    const before = await admin.get(`/api/admin/domains/${domainId}/logo`);
    expect(before.dmarc).toEqual({ record: 'v=DMARC1; p=none; rua=mailto:rua@reports.test', enforced: false, fix: 'v=DMARC1; p=quarantine; rua=mailto:rua@reports.test' });

    expect(await admin.post(`/api/admin/domains/${domainId}/dmarc/enforce`, {})).toEqual({ record: 'v=DMARC1; p=quarantine; rua=mailto:rua@reports.test', enforced: true, fix: null });
    expect(dmarc()).toHaveLength(1);
    expect(unquoteTxt(dmarc()[0].content)).toBe('v=DMARC1; p=quarantine; rua=mailto:rua@reports.test');
    expect((await admin.get(`/api/admin/domains/${domainId}/logo`)).dmarc).toMatchObject({ enforced: true, fix: null });

    // Without a record it adds one; with two (which receivers ignore) it leaves them to the admin.
    fake.state.dns.zone_example = fake.state.dns.zone_example.filter((r) => r.name !== '_dmarc.example.com');
    expect((await admin.post(`/api/admin/domains/${domainId}/dmarc/enforce`, {})).record).toBe('v=DMARC1; p=quarantine');
    fake.state.dns.zone_example.push({ id: 'dup', type: 'TXT', name: '_dmarc.example.com', content: '"v=DMARC1; p=none"' });
    const dup = await admin.request('POST', `/api/admin/domains/${domainId}/dmarc/enforce`, {});
    expect(dup.status).toBe(400);
    expect((await dup.json<{ error: { code: string } }>()).error.code).toBe('dmarc_duplicate');
  });

  it('loads a logo from an address, checked like a file', async () => {
    Object.assign(fake.state.logos, {
      '/acme.svg': LOGO,
      '/plain.svg': LOGO.replace('baseProfile="tiny-ps" ', ''),
      '/big.svg': LOGO.replace('</svg>', `<desc>${'x'.repeat(40_000)}</desc></svg>`),
    });
    expect(await admin.post(`/api/admin/domains/${domainId}/logo/fetch`, { url: 'https://logos.test/acme.svg' })).toEqual({ svg: LOGO });
    const refused = async (url: string) => {
      const res = await admin.request('POST', `/api/admin/domains/${domainId}/logo/fetch`, { url });
      expect(res.status).toBe(400);
      return (await res.json<{ error: { code: string; message: string } }>()).error;
    };
    expect((await refused('http://logos.test/acme.svg')).message).toMatch(/https/);
    expect((await refused('https://logos.test/missing.svg')).code).toBe('logo_unreachable');
    expect((await refused('https://logos.test/plain.svg')).message).toMatch(/SVG Tiny PS/);
    expect((await refused('https://logos.test/big.svg')).message).toMatch(/32 KB/);
    // Only checked: nothing is stored until the dialog saves it.
    expect((await admin.get(`/api/admin/domains/${domainId}/logo`)).logo).toBeNull();
  });

  it('is for admins only', async () => {
    const boxes = await admin.get('/api/admin/mailboxes');
    const created = await admin.post('/api/admin/users', { name: 'Bob', role: 'member', newMailbox: { localPart: 'bob', domainId: boxes[0].domainId } });
    const bob = new Client();
    await bob.init();
    await bob.post('/api/auth/login', { email: 'bob@example.com', password: created.password });
    await bob.post('/api/account/password', { next: 'bobs new password 1' });
    expect(await bob.status('PUT', `/api/admin/domains/${domainId}/logo`, { svg: LOGO })).toBe(403);
    expect(await bob.status('POST', `/api/admin/domains/${domainId}/dmarc/enforce`, {})).toBe(403);
    expect(await bob.status('POST', `/api/admin/domains/${domainId}/logo/fetch`, { url: 'https://logos.test/acme.svg' })).toBe(403);
    expect(await new Client().status('GET', `/api/admin/domains/${domainId}/logo`)).toBe(401);
  });
});
