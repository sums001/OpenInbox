// Senders' logos (BIMI) in the thread view: looked up by the cron for domains whose mail passes
// DMARC, shown only on messages that passed DMARC, and only while the admin switch is on.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, setupInstance } from '../helpers/client';
import { refreshSenderLogos } from '../../src/worker/services/sender-logos';

const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"><title>Acme</title><circle cx="50" cy="50" r="40" fill="#e11d48"/></svg>';
const pass = (d: string) => `dkim=pass header.d=${d}; dmarc=pass header.from=${d}; spf=pass smtp.mailfrom=x@${d}`;

describe("senders' logos", () => {
  let fake: ReturnType<typeof useFakeApis>;
  let admin: Client;

  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    await setupInstance(admin);
    Object.assign(fake.state.publicTxt, {
      // acme.test publishes a logo and enforces DMARC.
      'default._bimi.acme.test': ['v=BIMI1; l=https://logos.test/acme.svg'],
      '_dmarc.acme.test': ['v=DMARC1; p=reject'],
      // mail.shop.test has its records at the organizational domain.
      'default._bimi.shop.test': ['v=BIMI1; l=https://logos.test/shop.svg'],
      '_dmarc.shop.test': ['v=DMARC1; p=quarantine'],
      // lax.test publishes a logo but doesn't enforce DMARC.
      'default._bimi.lax.test': ['v=BIMI1; l=https://logos.test/lax.svg'],
      '_dmarc.lax.test': ['v=DMARC1; p=none'],
      // bad.test serves a logo that isn't SVG Tiny PS.
      'default._bimi.bad.test': ['v=BIMI1; l=https://logos.test/bad.svg'],
      '_dmarc.bad.test': ['v=DMARC1; p=reject'],
    });
    Object.assign(fake.state.logos, { '/acme.svg': LOGO, '/shop.svg': LOGO, '/lax.svg': LOGO, '/bad.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
  });

  const threadBySubject = async (subject: string) => {
    const list = await admin.get('/api/threads?mailbox=all&view=inbox');
    return admin.get(`/api/threads/${list.threads.find((t: { subject: string }) => t.subject === subject).id}`);
  };

  it('shows the logo of a domain that passes and enforces DMARC', async () => {
    await admin.patch('/api/admin/settings', { senderLogos: 'on' });
    await deliver(email({ from: 'Maya <maya@acme.test>', subject: 'From Acme', auth: pass('acme.test') }), { from: 'maya@acme.test', to: 'admin@example.com' });
    await deliver(email({ from: 'Shop <news@mail.shop.test>', subject: 'From Shop', auth: pass('mail.shop.test') }), { from: 'news@mail.shop.test', to: 'admin@example.com' });
    await deliver(email({ from: 'Lax <a@lax.test>', subject: 'From Lax', auth: pass('lax.test') }), { from: 'a@lax.test', to: 'admin@example.com' });
    await deliver(email({ from: 'Bad <a@bad.test>', subject: 'From Bad', auth: pass('bad.test') }), { from: 'a@bad.test', to: 'admin@example.com' });
    // Not looked up before the cron runs.
    expect((await threadBySubject('From Acme')).messages[0].fromLogo).toBeNull();

    expect(await refreshSenderLogos(env)).toBe(4);
    const acme = (await threadBySubject('From Acme')).messages[0];
    expect(acme.fromLogo).toMatch(/^\/api\/sender-logos\/acme\.test\?v=\d+$/);
    expect((await threadBySubject('From Shop')).messages[0].fromLogo).toMatch(/^\/api\/sender-logos\/mail\.shop\.test\?v=/);
    expect((await threadBySubject('From Lax')).messages[0].fromLogo).toBeNull();
    expect((await threadBySubject('From Bad')).messages[0].fromLogo).toBeNull();

    const res = await admin.request('GET', acme.fromLogo);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(await res.text()).toBe(LOGO);
    // Signed-in users only.
    expect(await new Client().status('GET', acme.fromLogo)).toBe(401);

    // Checked once a day: a second run looks nothing up.
    const before = fake.state.requests.length;
    expect(await refreshSenderLogos(env)).toBe(0);
    expect(fake.state.requests.length).toBe(before);

    // Mail that doesn't pass DMARC never shows the logo, even from a domain that has one.
    await deliver(email({ from: 'Maya <maya@acme.test>', subject: 'Unverified', auth: 'dkim=none; dmarc=none header.from=acme.test; spf=neutral' }), { from: 'x@elsewhere.test', to: 'admin@example.com' });
    expect((await threadBySubject('Unverified')).messages[0].fromLogo).toBeNull();

    // Off: initials again, and the logo isn't served.
    await admin.patch('/api/admin/settings', { senderLogos: 'off' });
    expect((await threadBySubject('From Acme')).messages[0].fromLogo).toBeNull();
    expect(await admin.status('GET', acme.fromLogo)).toBe(404);
  });

  it('is off by default, and turning it on picks up recent senders', async () => {
    expect((await admin.get('/api/admin/settings')).senderLogos).toBe('off');
    await deliver(email({ from: 'Maya <maya@acme.test>', subject: 'Before', auth: pass('acme.test') }), { from: 'maya@acme.test', to: 'admin@example.com' });
    expect(await refreshSenderLogos(env)).toBe(0);
    expect(fake.state.requests.some((r) => r.url.startsWith('doh'))).toBe(false);

    await admin.patch('/api/admin/settings', { senderLogos: 'on' });
    expect(await refreshSenderLogos(env)).toBe(1);
    expect((await threadBySubject('Before')).messages[0].fromLogo).toMatch(/^\/api\/sender-logos\/acme\.test/);
  });
});
