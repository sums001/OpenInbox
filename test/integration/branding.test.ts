// Custom logo and favicon URLs in Admin settings: saving other settings leaves them alone,
// each can be set and cleared, and only https: URLs or same-site paths are accepted.
import { beforeEach, describe, expect, it } from 'vitest';
import { useFakeApis } from '../helpers/fake';
import { Client, setupInstance } from '../helpers/client';

const LOGO = 'https://cdn.example.com/brand/logo.svg';
const FAVICON = '/brand/favicon.png';

describe('custom branding', () => {
  let admin: Client;

  beforeEach(async () => {
    useFakeApis();
    admin = new Client();
    await setupInstance(admin);
  });

  const branding = async () => {
    const s = await admin.get('/api/admin/settings');
    const session = await admin.get('/api/auth/session');
    expect({ logoUrl: session.logoUrl, faviconUrl: session.faviconUrl }).toEqual({ logoUrl: s.logoUrl, faviconUrl: s.faviconUrl });
    return { logoUrl: s.logoUrl, faviconUrl: s.faviconUrl };
  };

  it('keeps the logo and favicon when other settings are saved', async () => {
    await admin.patch('/api/admin/settings', { logoUrl: LOGO, faviconUrl: FAVICON });
    expect(await branding()).toEqual({ logoUrl: LOGO, faviconUrl: FAVICON });

    // The Domains page sends only appUrl.
    await admin.patch('/api/admin/settings', { appUrl: 'https://mail.example.com' });
    expect(await branding()).toEqual({ logoUrl: LOGO, faviconUrl: FAVICON });
    expect((await admin.get('/api/admin/settings')).appUrl).toBe('https://mail.example.com');

    await admin.patch('/api/admin/settings', { instanceName: 'Acme Mail' });
    expect(await branding()).toEqual({ logoUrl: LOGO, faviconUrl: FAVICON });
  });

  for (const field of ['logoUrl', 'faviconUrl'] as const) {
    const other = field === 'logoUrl' ? 'faviconUrl' : 'logoUrl';

    it(`sets and clears ${field}`, async () => {
      await admin.patch('/api/admin/settings', { [other]: '/other.svg' });

      await admin.patch('/api/admin/settings', { [field]: `  ${LOGO}  ` });
      expect((await branding())[field]).toBe(LOGO);

      await admin.patch('/api/admin/settings', { [field]: '' });
      expect((await branding())[field]).toBeNull();

      await admin.patch('/api/admin/settings', { [field]: '/brand/mark.svg' });
      expect((await branding())[field]).toBe('/brand/mark.svg');

      await admin.patch('/api/admin/settings', { [field]: null });
      expect((await branding())[field]).toBeNull();

      // Clearing one never touches the other.
      expect((await branding())[other]).toBe('/other.svg');
    });
  }

  it('accepts only https: URLs and paths on this site', async () => {
    await admin.patch('/api/admin/settings', { logoUrl: LOGO, faviconUrl: FAVICON });
    const rejected = [
      'javascript:alert(1)',
      'http://cdn.example.com/logo.svg',
      '//evil.test/logo.svg',
      '/\\evil.test/logo.svg',
      'data:image/svg+xml,<svg/>',
      'logo.svg',
    ];
    for (const url of rejected) {
      for (const field of ['logoUrl', 'faviconUrl']) {
        expect(await admin.status('PATCH', '/api/admin/settings', { [field]: url }), `${field}=${url}`).toBe(400);
      }
    }
    expect(await branding()).toEqual({ logoUrl: LOGO, faviconUrl: FAVICON });
  });
});
