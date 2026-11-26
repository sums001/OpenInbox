// Authorization regression coverage: who may reach what, including path variants that router
// bugs have exploited (encoded line terminators, trailing and duplicate slashes, dot segments).
// Runs only against the in-memory test Worker with fictitious users and data.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, ORIGIN, setupInstance } from '../helpers/client';

const SECRET_SUBJECT = 'Confidential admin-only subject';
const PRIVATE_MARKERS = ['admin@example.com', SECRET_SUBJECT, 'Admin Person'];

interface World {
  admin: Client;
  bob: Client;
  anon: Client;
  fakes: ReturnType<typeof useFakeApis>;
  ids: { adminBox: number; bobBox: number; teamBox: number; adminThread: number; adminMsg: number; adminAtt: number; bobId: number; adminSession: string };
}

const rawWithAttachment = (to: string) =>
  [
    'From: Ann Sender <ann@sender.test>',
    `To: ${to}`,
    `Subject: ${SECRET_SUBJECT}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <att${Date.now()}@sender.test>`,
    'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=sender.test; dmarc=pass header.from=sender.test; spf=pass smtp.mailfrom=ann@sender.test',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Body with an attachment.',
    '--b1',
    'Content-Type: application/pdf; name="plan.pdf"',
    'Content-Disposition: attachment; filename="plan.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa('%PDF-1.4 fictitious attachment bytes'),
    '--b1--',
    '',
  ].join('\n');

async function member(admin: Client, name: string, local: string, domainId: number): Promise<{ client: Client; id: number }> {
  const created = await admin.post('/api/admin/users', { name, role: 'member', newMailbox: { localPart: local, domainId } });
  const client = new Client();
  await client.init();
  await client.post('/api/auth/login', { email: `${local}@example.com`, password: created.password });
  await client.post('/api/account/password', { next: `${local} new password 1` });
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(`${local}@example.com`).first<{ id: number }>();
  return { client, id: row!.id };
}

async function buildWorld(): Promise<World> {
  const fakes = useFakeApis();
  const admin = new Client();
  await setupInstance(admin);
  const boxes = await admin.get('/api/admin/mailboxes');
  const domainId = boxes[0].domainId as number;
  const bob = await member(admin, 'Bob', 'bob', domainId);
  // A shared mailbox where the admin may send and Bob may read but not send.
  const adminRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind('admin@example.com').first<{ id: number }>();
  await admin.post('/api/admin/mailboxes', {
    localPart: 'team',
    domainId,
    kind: 'shared',
    members: [
      { userId: adminRow!.id, canSend: true },
      { userId: bob.id, canSend: false },
    ],
  });

  await deliver(rawWithAttachment('admin@example.com'), { from: 'ann@sender.test', to: 'admin@example.com' });
  await deliver(email({ subject: 'For Bob' }), { from: 'ann@sender.test', to: 'bob@example.com' });

  const one = async <T>(sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<T>())!;
  const adminBox = (await one<{ id: number }>('SELECT id FROM mailboxes WHERE address = ?', 'admin@example.com')).id;
  const bobBox = (await one<{ id: number }>('SELECT id FROM mailboxes WHERE address = ?', 'bob@example.com')).id;
  const teamBox = (await one<{ id: number }>('SELECT id FROM mailboxes WHERE address = ?', 'team@example.com')).id;
  const adminMsg = (await one<{ id: number; thread_id: number }>('SELECT id, thread_id FROM messages WHERE mailbox_id = ? LIMIT 1', adminBox));
  const adminAtt = (await one<{ id: number }>('SELECT id FROM attachments WHERE message_id = ? LIMIT 1', adminMsg.id)).id;
  const adminUser = await one<{ id: number }>('SELECT id FROM users WHERE email = ?', 'admin@example.com');
  const adminSession = (await one<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? LIMIT 1', adminUser.id)).id;
  const anon = new Client();
  await anon.init();
  return { admin, bob: bob.client, anon, fakes, ids: { adminBox, bobBox, teamBox, adminThread: adminMsg.thread_id, adminMsg: adminMsg.id, adminAtt, bobId: bob.id, adminSession } };
}

const fill = (path: string, ids: World['ids']) =>
  path
    .replace('{tid}', String(ids.adminThread))
    .replace('{mid}', String(ids.adminMsg))
    .replace('{aid}', String(ids.adminAtt))
    .replace('{bid}', String(ids.adminBox))
    .replace('{uid}', String(ids.bobId));

// Private endpoints that need a signed-in user. {…} placeholders point at the admin's data.
const USER_READS = [
  '/api/mailboxes',
  '/api/sync',
  '/api/threads',
  '/api/threads/count',
  '/api/threads/{tid}',
  '/api/messages/{mid}/body',
  '/api/messages/{mid}/raw',
  '/api/attachments/{aid}',
  '/api/attachments/{aid}?inline=1',
  '/api/search?q=confidential',
  '/api/contacts',
  '/api/mailboxes/{bid}/filters',
  '/api/mailboxes/{bid}/members',
  '/api/mailboxes/{bid}/settings',
  '/api/mailboxes/{bid}/export',
  '/api/account/sessions',
  '/api/account/trusted-senders',
];
const ADMIN_READS = [
  '/api/admin/overview',
  '/api/admin/usage',
  '/api/admin/updates',
  '/api/admin/users',
  '/api/admin/mailboxes',
  '/api/admin/mailboxes/{bid}',
  '/api/admin/domains',
  '/api/admin/zones',
  '/api/admin/providers',
  '/api/admin/cloudflare',
  '/api/admin/storage',
  '/api/admin/settings',
  '/api/admin/audit',
  '/api/admin/mailflow',
  '/api/admin/failures',
  '/api/admin/suppressions',
  '/api/admin/blocked',
  '/api/admin/forwarding',
];
const WRITES: [string, string, unknown][] = [
  ['POST', '/api/admin/users', { name: 'Mallory', role: 'admin' }],
  ['PATCH', '/api/admin/users/{uid}', { role: 'admin' }],
  ['DELETE', '/api/admin/users/{uid}', undefined],
  ['POST', '/api/admin/users/{uid}/reset-password', {}],
  ['PATCH', '/api/admin/settings', {}],
  ['POST', '/api/admin/mailboxes', { localPart: 'evil', domainId: 1 }],
  ['DELETE', '/api/admin/mailboxes/{bid}', undefined],
  ['PUT', '/api/admin/mailboxes/{bid}/members', { members: [] }],
  ['POST', '/api/admin/providers', { type: 'resend', config: { apiKey: 're_fake_key_123' } }],
  ['POST', '/api/admin/blocked', { pattern: 'x@y.test' }],
  ['POST', '/api/threads/actions', { threadIds: [1], action: 'trash' }],
  ['POST', '/api/drafts', { mailboxId: 1, from: 'admin@example.com', to: [{ name: '', address: 'x@dest.test' }], subject: 's', html: '<p>x</p>' }],
  ['PATCH', '/api/mailboxes/{bid}/settings', { signature: 'pwned' }],
  ['POST', '/api/mailboxes/{bid}/labels', { name: 'x' }],
  ['POST', '/api/mailboxes/{bid}/filters', {}],
  ['PATCH', '/api/account', { name: 'x' }],
  ['POST', '/api/account/sessions/revoke-others', {}],
];

// Path forms that routers and proxies treat differently: the point is that none of them lets a
// request skip authentication or authorization.
function variants(path: string): string[] {
  const [p, q = ''] = path.split('?');
  const qs = q ? `?${q}` : '';
  const out = new Set<string>([path]);
  out.add(`${p}/${qs}`);
  out.add(p.replace('/api/', '/api//') + qs);
  out.add(p.replace('/api/', '/api/./') + qs);
  out.add(p.replace('/api/', '/api/x/../') + qs);
  out.add(p.replace('/api/', '/API/') + qs);
  out.add(p.replace(/^\/api\/(.)/, (_m, c: string) => `/api/%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`) + qs);
  out.add(p.replace(/\/([^/]+)$/, '%2F$1') + qs);
  out.add(`${p};x=1${qs}`);
  for (const term of ['%0A', '%0D', '%E2%80%A8', '%E2%80%A9']) {
    out.add(`${p}${term}${qs}`);
    out.add(`${p}/${term}${qs}`);
    out.add(p.replace('/api/', `/api/${term}`) + qs);
    out.add(p.replace(/^\/api\/([^/]+)/, `/api/$1${term}`) + qs);
  }
  return [...out];
}

const leaks = (text: string) => PRIVATE_MARKERS.filter((m) => text.includes(m));

describe('authorization regression', () => {
  let w: World;
  beforeEach(async () => {
    w = await buildWorld();
  });

  it('keeps public endpoints public and everything else behind a session', async () => {
    expect(await w.anon.status('GET', '/api/health')).toBe(200);
    const session = await w.anon.get('/api/auth/session');
    expect(session.user ?? null).toBeNull();
    for (const path of [...USER_READS, ...ADMIN_READS]) {
      const res = await w.anon.request('GET', fill(path, w.ids));
      const text = await res.text();
      expect([path, res.status], 'anonymous GET').toEqual([path, 401]);
      expect(leaks(text), path).toEqual([]);
    }
    for (const [method, path, body] of WRITES) {
      const status = await w.anon.status(method, fill(path, w.ids), body);
      expect([method, path, status].join(' ')).toMatch(/ (401|403)$/);
    }
  });

  it('does not let path variants skip authentication', async () => {
    for (const path of [...USER_READS, ...ADMIN_READS]) {
      for (const v of variants(fill(path, w.ids))) {
        const res = await w.anon.request('GET', v);
        const text = await res.text();
        expect(res.status, `anonymous GET ${v}`).toBeGreaterThanOrEqual(400);
        expect(leaks(text), `anonymous GET ${v}`).toEqual([]);
      }
    }
    for (const [method, path, body] of WRITES) {
      for (const v of variants(fill(path, w.ids))) {
        const res = await w.anon.request(method, v, body);
        await res.arrayBuffer();
        expect(res.status, `anonymous ${method} ${v}`).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it('applies the global gate and security headers to paths with encoded line terminators', async () => {
    for (const term of ['%0A', '%0D', '%E2%80%A8', '%E2%80%A9']) {
      for (const path of [`/api/does-not-exist${term}`, `/api/admin/users${term}`, `/api/threads/1${term}`, `/api/${term}`]) {
        const res = await w.anon.request('GET', path);
        await res.arrayBuffer();
        expect(res.status, `anonymous ${path}`).toBe(401);
        expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
        expect(res.headers.get('cache-control'), path).toBe('no-store');
      }
    }
  });

  it('returns a generic error, not private data, for unknown routes', async () => {
    for (const client of [w.anon, w.bob, w.admin]) {
      for (const path of ['/api/nothing-here', '/api/admin/nothing-here', '/api/threads/999999', '/api/messages/999999/body', '/api/attachments/999999']) {
        const res = await client.request('GET', path);
        const text = await res.text();
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(leaks(text), path).toEqual([]);
      }
    }
  });

  it('keeps regular members out of every admin endpoint, with or without path variants', async () => {
    expect(await w.bob.status('GET', '/api/mailboxes')).toBe(200);
    for (const path of ADMIN_READS) {
      for (const v of variants(fill(path, w.ids))) {
        const res = await w.bob.request('GET', v);
        const text = await res.text();
        expect(res.status, `member GET ${v}`).toBeGreaterThanOrEqual(400);
        expect(leaks(text), `member GET ${v}`).toEqual([]);
      }
    }
    const before = await w.admin.get('/api/admin/users');
    for (const [method, path, body] of WRITES.filter(([, p]) => p.startsWith('/api/admin/'))) {
      for (const v of variants(fill(path, w.ids))) {
        const res = await w.bob.request(method, v, body);
        await res.arrayBuffer();
        expect(res.status, `member ${method} ${v}`).toBeGreaterThanOrEqual(400);
      }
    }
    // Nothing changed: same users, Bob still a member, settings untouched.
    expect(await w.admin.get('/api/admin/users')).toEqual(before);
    expect((await w.bob.get('/api/mailboxes')).length).toBeGreaterThan(0);
  });

  it("keeps a member away from other people's messages, attachments, settings and sessions", async () => {
    const { adminBox, adminMsg, adminAtt, adminThread, adminSession } = w.ids;
    for (const path of [
      `/api/threads/${adminThread}`,
      `/api/messages/${adminMsg}/body`,
      `/api/messages/${adminMsg}/raw`,
      `/api/attachments/${adminAtt}`,
      `/api/attachments/${adminAtt}?inline=1`,
      `/api/mailboxes/${adminBox}/filters`,
      `/api/mailboxes/${adminBox}/members`,
      `/api/mailboxes/${adminBox}/settings`,
      `/api/mailboxes/${adminBox}/export`,
      `/api/threads?mailbox=${adminBox}`,
    ]) {
      for (const v of variants(path)) {
        const res = await w.bob.request('GET', v);
        const text = await res.text();
        expect(res.status, `member GET ${v}`).toBeGreaterThanOrEqual(400);
        expect(leaks(text), `member GET ${v}`).toEqual([]);
      }
    }
    const before = JSON.stringify(await w.admin.get(`/api/mailboxes/${adminBox}/settings`));
    for (const [method, path, body] of [
      ['PATCH', `/api/mailboxes/${adminBox}/settings`, { signature: 'pwned' }],
      ['POST', `/api/mailboxes/${adminBox}/labels`, { name: 'x' }],
      ['POST', `/api/mailboxes/${adminBox}/filters`, {}],
      ['POST', `/api/mailboxes/${adminBox}/import`, {}],
      ['DELETE', `/api/account/sessions/${adminSession}`, undefined],
    ] as [string, string, unknown][]) {
      expect(await w.bob.status(method, path, body), `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    expect(JSON.stringify(await w.admin.get(`/api/mailboxes/${adminBox}/settings`))).toBe(before);
    // The admin session is still alive.
    expect(await w.admin.status('GET', '/api/mailboxes')).toBe(200);
    // A message-level action on someone else's thread changes nothing for the owner.
    await w.bob.status('POST', '/api/threads/actions', { threadIds: [adminThread], action: 'trash' });
    expect((await w.admin.get(`/api/threads/${adminThread}`)).thread.folder).toBe('inbox');
  });

  it('lets a read-only member read a shared mailbox but not send from it', async () => {
    const { teamBox } = w.ids;
    expect(await w.bob.status('GET', `/api/threads?mailbox=${teamBox}`)).toBe(200);
    const draft = { mailboxId: teamBox, from: 'team@example.com', to: [{ name: '', address: 'x@dest.test' }], subject: 'Should not leave', html: '<p>no</p>' };
    expect(await w.bob.status('POST', '/api/drafts', draft)).toBe(403);
    // A draft the admin made in that mailbox cannot be sent, retried or edited by the read-only member.
    const adminDraft = await w.admin.post('/api/drafts', draft);
    expect(await w.bob.status('POST', `/api/drafts/${adminDraft.id}/send`, {})).toBeGreaterThanOrEqual(400);
    expect(await w.bob.status('PUT', `/api/drafts/${adminDraft.id}`, { ...draft, subject: 'edited' })).toBeGreaterThanOrEqual(400);
    const state = w.fakes.state;
    expect([...state.resend.emails, ...state.brevo.emails, ...state.mailjet.emails, ...state.cfSending.emails]).toHaveLength(0);
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND status NOT IN ('draft')").first<{ n: number }>();
    expect(sent!.n).toBe(0);
  });

  it('keeps CSRF protection on state-changing requests', async () => {
    const before = await w.admin.get('/api/admin/users');
    const body = { name: 'Mallory', role: 'admin' };
    const attempts: [string, Record<string, string>][] = [
      ['wrong token', { 'X-CSRF-Token': 'not-the-token' }],
      ['cross-origin', { Origin: 'https://evil.example' }],
      ['cross-site fetch metadata without Origin', { Origin: '', 'Sec-Fetch-Site': 'cross-site' }],
      ['same-site fetch metadata without Origin', { Origin: '', 'Sec-Fetch-Site': 'same-site' }],
    ];
    for (const [label, headers] of attempts) {
      for (const [method, path, payload] of [
        ['POST', '/api/admin/users', body],
        ['PATCH', `/api/admin/users/${w.ids.bobId}`, { role: 'admin' }],
        ['DELETE', `/api/admin/users/${w.ids.bobId}`, undefined],
        ['PUT', `/api/admin/mailboxes/${w.ids.adminBox}/members`, { members: [] }],
        ['PATCH', '/api/account', { name: 'x' }],
        ['POST', '/api/threads/actions', { threadIds: [w.ids.adminThread], action: 'trash' }],
      ] as [string, string, unknown][]) {
        const res = await w.admin.request(method, path, payload, headers);
        const json = await res.json<{ error?: { code?: string } }>().catch(() => ({}) as { error?: { code?: string } });
        expect([label, method, path, res.status, json.error?.code]).toEqual([label, method, path, 403, 'csrf']);
      }
    }
    // Without the CSRF cookie nothing works either.
    const noCookie = new Client();
    noCookie.cookies = new Map([...w.admin.cookies].filter(([k]) => k !== 'oi_csrf'));
    expect(await noCookie.status('POST', '/api/admin/users', body)).toBe(403);
    expect(await w.admin.get('/api/admin/users')).toEqual(before);
    expect(ORIGIN).toMatch(/^https:/);
  });
});
