import { beforeEach, describe, expect, it } from 'vitest';
import { useFakeApis } from '../helpers/fake';
import { Client, ENCRYPTION_KEY, setupInstance } from '../helpers/client';

describe('first-run setup', () => {
  let fake: ReturnType<typeof useFakeApis>;
  beforeEach(() => {
    fake = useFakeApis();
  });

  it('checks the deployment, then claims it with the ENCRYPTION_KEY', async () => {
    const c = new Client();
    await c.init();
    const session = await c.get('/api/auth/session');
    expect(session.setupComplete).toBe(false);
    expect(await c.status('GET', '/api/threads')).toBe(409);

    const status = await c.get('/api/setup/status');
    expect(status.checks.database.ok).toBe(true);
    expect(status.checks.encryptionKey.ok).toBe(true);
    expect(status.checks.cloudflare.ok).toBe(true);
    expect(status.checks.worker).toMatchObject({ ok: true, name: 'openinbox', subdomain: 'tester' });
    expect(status.zones.map((z: { name: string }) => z.name)).toEqual(['example.com', 'workspace.dev']);
    expect(status.permissions.find((p: { key: string }) => p.key === 'dns').ok).toBe(true);

    const gmail = await c.get('/api/setup/zones/zone_gmail');
    expect(gmail.mxState).toBe('other');

    const claim = { zoneId: 'zone_example', localPart: 'admin', displayName: 'Admin', password: 'correct horse battery' };
    expect(await c.status('POST', '/api/setup/claim', { ...claim, setupKey: 'wrong' })).toBe(403);
    // Taking over a domain that receives mail elsewhere needs confirmation.
    expect(await c.status('POST', '/api/setup/claim', { ...claim, zoneId: 'zone_gmail', setupKey: ENCRYPTION_KEY })).toBe(409);

    const r = await c.post('/api/setup/claim', { ...claim, setupKey: ENCRYPTION_KEY });
    expect(r.ok).toBe(true);
    const me = await c.get('/api/auth/session');
    expect(me.user).toMatchObject({ email: 'admin@example.com', role: 'owner' });
    // A second claim fails: setup endpoints close once an owner exists.
    expect(await new Client().status('GET', '/api/setup/status')).toBe(409);

    let state;
    for (let i = 0; i < 5; i++) {
      state = await c.post(`/api/admin/domains/${r.domainId}/setup`);
      if (state.done) break;
    }
    expect(state.done).toBe(true);
    expect(fake.state.routing.zone_example).toEqual({ enabled: true, status: 'ready' });
    expect(fake.state.catchAll.zone_example.actions).toEqual([{ type: 'worker', value: ['openinbox'] }]);
    const dmarc = fake.state.dns.zone_example.filter((x) => x.name === '_dmarc.example.com');
    expect(dmarc).toHaveLength(1);
    // Running the steps again changes nothing (idempotent).
    await c.post(`/api/admin/domains/${r.domainId}/setup?reset=1`);
    for (let i = 0; i < 5; i++) await c.post(`/api/admin/domains/${r.domainId}/setup`);
    expect(fake.state.dns.zone_example.filter((x) => x.name === '_dmarc.example.com')).toHaveLength(1);
    expect(fake.state.dns.zone_example.filter((x) => x.type === 'TXT' && x.name === 'example.com' && x.content.includes('v=spf1'))).toHaveLength(1);

    const overview = await c.get('/api/admin/overview');
    expect(overview.checklist.find((x: { id: string }) => x.id === 'domain').done).toBe(true);
    expect(overview.checklist.find((x: { id: string }) => x.id === 'provider').done).toBe(false);
  });

  it('generates the recovery key when the deploy set none, and claims with it', async () => {
    // A fresh deploy: no ENCRYPTION_KEY and no CF_API_TOKEN secret.
    const c = new Client({ ENCRYPTION_KEY: undefined, CF_API_TOKEN: undefined });
    await c.init();
    let status = await c.get('/api/setup/status');
    expect(status.checks.encryptionKey).toMatchObject({ ok: false, pending: true, state: 'missing' });
    expect(status.checks.cloudflare.ok).toBe(false);
    const claim = { zoneId: 'zone_example', localPart: 'admin', displayName: 'Admin', password: 'correct horse battery' };
    expect(await c.status('POST', '/api/setup/claim', { ...claim, setupKey: 'anything' })).toBe(409);

    // A token that can't see this Worker proves nothing, and sets no secret.
    expect(await c.status('POST', '/api/setup/token', { token: 'not-a-valid-token-at-all' })).toBe(400);
    fake.state.accounts = [{ id: 'acc_other', name: 'Someone else' }];
    fake.state.subdomain = 'someone-else';
    expect(await c.status('POST', '/api/setup/token', { token: 'valid-token-0123456789abcdef' })).toBe(400);
    expect(fake.state.scripts.openinbox.secrets).toBeUndefined();
    fake.reset();

    const { recoveryKey } = await c.post('/api/setup/token', { token: 'valid-token-0123456789abcdef' });
    expect(recoveryKey).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.state.scripts.openinbox.secrets).toEqual({ ENCRYPTION_KEY: recoveryKey });

    // Until the new version with the secret is live, setup waits for it.
    status = await c.get('/api/setup/status');
    expect(status.checks.encryptionKey).toMatchObject({ ok: false, state: 'activating' });
    expect(await c.status('POST', '/api/setup/claim', { ...claim, setupKey: recoveryKey })).toBe(409);

    // The Worker now runs with the secret.
    c.envOverride.ENCRYPTION_KEY = recoveryKey;
    status = await c.get('/api/setup/status');
    expect(status.checks.encryptionKey).toMatchObject({ ok: true, state: 'generated' });
    expect(status.checks.cloudflare).toMatchObject({ ok: true, source: 'stored' });
    expect(status.checks.worker).toMatchObject({ ok: true, name: 'openinbox' });

    // Changing the token keeps the key; asking for a new key replaces it.
    expect((await c.post('/api/setup/token', { token: 'valid-token-0123456789abcdef' })).recoveryKey).toBeNull();
    const second = (await c.post('/api/setup/token', { token: 'valid-token-0123456789abcdef', newKey: true })).recoveryKey;
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(recoveryKey);
    expect((await c.get('/api/setup/status')).checks.encryptionKey.state).toBe('activating');
    c.envOverride.ENCRYPTION_KEY = second;

    expect(await c.status('POST', '/api/setup/claim', { ...claim, setupKey: recoveryKey })).toBe(403);
    expect((await c.post('/api/setup/claim', { ...claim, setupKey: second })).ok).toBe(true);
    expect((await c.get('/api/auth/session')).user).toMatchObject({ email: 'admin@example.com', role: 'owner' });
    // The recovery key is the owner's way back in.
    await new Client({ ENCRYPTION_KEY: second, CF_API_TOKEN: undefined }).init();
    const other = new Client({ ENCRYPTION_KEY: second, CF_API_TOKEN: undefined });
    await other.init();
    await other.post('/api/auth/recover', { email: 'admin@example.com', setupKey: second, newPassword: 'another long password' });
  });

  it('names the permission a refused domain step needs', async () => {
    // A token without Zone Settings: Email Routing's settings endpoints are refused, its rules are not.
    fake.state.denied = [/\/email\/routing(\/dns|\/enable)?$/];
    const c = new Client();
    await c.init();
    const status = await c.get('/api/setup/status');
    const byKey = (k: string) => status.permissions.find((p: { key: string }) => p.key === k);
    expect(byKey('zone_settings').ok).toBe(false);
    expect(byKey('email_routing_rules').ok).toBe(true);

    const r = await c.post('/api/setup/claim', { zoneId: 'zone_example', localPart: 'admin', displayName: 'Admin', password: 'correct horse battery', setupKey: ENCRYPTION_KEY });
    const state = await c.post(`/api/admin/domains/${r.domainId}/setup`);
    const routing = state.steps.find((s: { id: string }) => s.id === 'routing');
    expect(routing.status).toBe('error');
    expect(routing.message).toContain('Zone → Zone Settings → Edit');
  });

  it('leaves zone permissions untested, not missing, when the account has no domains', async () => {
    fake.state.zones = [];
    const c = new Client();
    await c.init();
    const status = await c.get('/api/setup/status');
    expect(status.checks.zones).toMatchObject({ ok: false, count: 0 });
    const byKey = (k: string) => status.permissions.find((p: { key: string }) => p.key === k);
    expect(byKey('dns')).toMatchObject({ ok: false, untested: true });
    expect(byKey('zone_settings')).toMatchObject({ ok: false, untested: true });
    expect(byKey('email_routing_rules')).toMatchObject({ ok: false, untested: true });
    expect(byKey('workers_scripts').ok).toBe(true);
    expect(byKey('workers_scripts').untested).toBeUndefined();
  });

  it('replaces foreign MX records only after confirmation, merging SPF', async () => {
    const c = new Client();
    await c.init();
    await c.get('/api/setup/status');
    const r = await c.post('/api/setup/claim', {
      zoneId: 'zone_gmail',
      localPart: 'me',
      displayName: 'Me',
      password: 'correct horse battery',
      setupKey: ENCRYPTION_KEY,
      replaceMx: true,
    });
    for (let i = 0; i < 5; i++) await c.post(`/api/admin/domains/${r.domainId}/setup`);
    const recs = fake.state.dns.zone_gmail;
    expect(recs.some((x) => x.type === 'MX' && x.content === 'aspmx.l.google.com')).toBe(false);
    const spf = recs.filter((x) => x.type === 'TXT' && x.name === 'workspace.dev' && x.content.includes('v=spf1'));
    expect(spf).toHaveLength(1);
    expect(spf[0].content).toContain('include:_spf.mx.cloudflare.net');
  });

  it('signs in with rate limiting, CSRF and owner recovery', async () => {
    await setupInstance(new Client());
    const c = new Client();
    await c.init();
    expect(await c.status('POST', '/api/auth/login', { email: 'admin@example.com', password: 'wrong password!' })).toBe(401);
    // CSRF: a request without the header is refused.
    const noCsrf = await c.request('POST', '/api/auth/login', { email: 'admin@example.com', password: 'x' }, { 'X-CSRF-Token': 'nope' });
    expect(noCsrf.status).toBe(403);
    const ok = await c.post('/api/auth/login', { email: 'ADMIN@example.com', password: 'correct horse battery' });
    expect(ok.mfaRequired).toBe(false);
    expect((await c.get('/api/auth/session')).user.email).toBe('admin@example.com');
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/session')).user).toBeNull();

    for (let i = 0; i < 6; i++) await c.status('POST', '/api/auth/login', { email: 'admin@example.com', password: 'wrong password!' });
    expect(await c.status('POST', '/api/auth/login', { email: 'admin@example.com', password: 'correct horse battery' })).toBe(429);

    expect(await c.status('POST', '/api/auth/recover', { email: 'admin@example.com', setupKey: 'nope', newPassword: 'another long password' })).toBe(403);
    await c.post('/api/auth/recover', { email: 'admin@example.com', setupKey: ENCRYPTION_KEY, newPassword: 'another long password' });
  });
});
