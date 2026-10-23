// In-memory fakes of the Cloudflare, Resend, Brevo, Mailjet and GitHub APIs, shared by the unit
// tests (through a fetch spy), the end-to-end tests and local development (test/mock/server.ts).
// Only erasable TypeScript syntax, so Node can run it directly.

export interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied?: boolean;
  ttl?: number;
}

export interface FakeRule {
  id: string;
  name: string;
  enabled: boolean;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
}

export interface FakeState {
  tokens: string[];
  // Paths the token lacks the permission for: Cloudflare answers 403, code 10000.
  denied: RegExp[];
  accounts: { id: string; name: string }[];
  subdomain: string;
  scripts: Record<string, { d1: string; secrets?: Record<string, string> }>;
  zones: { id: string; name: string; status: string }[];
  dns: Record<string, FakeRecord[]>;
  routing: Record<string, { enabled: boolean; status: string }>;
  catchAll: Record<string, FakeRule>;
  rules: Record<string, FakeRule[]>;
  destinations: { id: string; email: string; verified: string | null }[];
  customDomains: { id: string; hostname: string; service: string; zone_id: string }[];
  r2Enabled: boolean;
  buckets: string[];
  resend: { domains: { id: string; name: string; status: string; records: Record<string, unknown>[] }[]; emails: Record<string, unknown>[]; failNext: number; webhooks: string[] };
  brevo: { domains: Record<string, { id: number; authenticated: boolean }>; emails: Record<string, unknown>[]; credits: number };
  mailjet: { dns: Record<string, { id: number }>; emails: Record<string, unknown>[] };
  release: { tag_name: string; html_url: string; body: string } | null;
  requests: { method: string; url: string; body?: unknown }[];
  seq: number;
}

export function createFakeState(): FakeState {
  return {
    tokens: ['test-cf-token', 'dev-token', 'valid-token-0123456789abcdef'],
    denied: [],
    accounts: [{ id: 'acc_test', name: 'Test Account' }],
    subdomain: 'tester',
    scripts: { openinbox: { d1: 'db_test' } },
    zones: [
      { id: 'zone_example', name: 'example.com', status: 'active' },
      { id: 'zone_gmail', name: 'workspace.dev', status: 'active' },
    ],
    dns: {
      zone_example: [{ id: 'r1', type: 'A', name: 'example.com', content: '192.0.2.1' }],
      zone_gmail: [
        { id: 'r2', type: 'MX', name: 'workspace.dev', content: 'aspmx.l.google.com', priority: 1 },
        { id: 'r3', type: 'TXT', name: 'workspace.dev', content: '"v=spf1 include:_spf.google.com ~all"' },
      ],
    },
    routing: {},
    catchAll: {},
    rules: {},
    destinations: [],
    customDomains: [],
    r2Enabled: false,
    buckets: [],
    resend: { domains: [], emails: [], failNext: 0, webhooks: [] },
    brevo: { domains: {}, emails: [], credits: 300 },
    mailjet: { dns: {}, emails: [] },
    release: { tag_name: 'v1.0.0', html_url: 'https://github.com/example/openinbox/releases/tag/v1.0.0', body: 'First release.' },
    requests: [],
    seq: 1,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (result: unknown, info?: Record<string, unknown>) => json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
const fail = (status: number, code: number, message: string) => json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);

function page<T>(items: T[], url: URL) {
  const per = Number(url.searchParams.get('per_page') ?? 50);
  const p = Number(url.searchParams.get('page') ?? 1);
  const slice = items.slice((p - 1) * per, p * per);
  return ok(slice, { page: p, per_page: per, count: slice.length, total_count: items.length, total_pages: Math.max(1, Math.ceil(items.length / per)) });
}

const unq = (s: string) => (s.startsWith('"') ? [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('') : s);

function id(state: FakeState, prefix: string): string {
  return `${prefix}_${state.seq++}`;
}

async function readBody(req: Request): Promise<any> {
  const text = await req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Returns null when the request is not for a faked service.
export async function handleFake(state: FakeState, req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  let service: string;
  let path = url.pathname;
  const hostMap: Record<string, string> = { 'cf.test': 'cf', 'resend.test': 'resend', 'brevo.test': 'brevo', 'mailjet.test': 'mailjet', 'github.test': 'github' };
  if (hostMap[url.hostname]) {
    service = hostMap[url.hostname];
    path = path.replace(/^\/client\/v4/, '').replace(/^\/v3(?=\/)/, service === 'brevo' ? '' : '/v3');
  } else {
    const m = /^\/(cf|resend|brevo|mailjet|github)(\/.*)?$/.exec(path);
    if (!m) return null;
    service = m[1];
    path = m[2] ?? '/';
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  state.requests.push({ method: req.method, url: `${service}${path}${url.search}`, body });
  if (service === 'cf') return cloudflare(state, req, url, path, body);
  if (service === 'resend') return resend(state, req, path, body);
  if (service === 'brevo') return brevo(state, req, path, body);
  if (service === 'mailjet') return mailjet(state, req, path, body);
  if (service === 'github') return state.release && /\/releases\/latest$/.test(path) ? json(state.release) : json({ message: 'Not Found' }, 404);
  return null;
}

function cloudflare(state: FakeState, req: Request, url: URL, path: string, body: any): Response {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!state.tokens.includes(token)) return fail(401, 1000, 'Invalid API Token');
  if (state.denied.some((d) => d.test(path))) return fail(403, 10000, 'Authentication error');
  const m = req.method;
  let r: RegExpExecArray | null;

  if (path === '/user/tokens/verify' || /^\/accounts\/[^/]+\/tokens\/verify$/.test(path)) return ok({ id: 'tok', status: 'active' });
  if (path === '/accounts') return page(state.accounts, url);
  if ((r = /^\/accounts\/([^/]+)$/.exec(path))) {
    const a = state.accounts.find((x) => x.id === r![1]);
    return a ? ok(a) : fail(404, 7003, 'Could not route');
  }
  if (/^\/accounts\/[^/]+\/workers\/subdomain$/.test(path)) return ok({ subdomain: state.subdomain });
  if (/^\/accounts\/[^/]+\/workers\/scripts$/.test(path)) return ok(Object.keys(state.scripts).map((s) => ({ id: s })));
  if ((r = /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/secrets$/.exec(path)) && m === 'PUT') {
    const s = state.scripts[r[1]];
    if (!s) return fail(404, 10007, 'workers.api.error.script_not_found');
    (s.secrets ??= {})[body.name] = body.text;
    return ok({ name: body.name, type: body.type });
  }
  if ((r = /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/settings$/.exec(path))) {
    const s = state.scripts[r[1]];
    return s ? ok({ bindings: [{ type: 'd1', name: 'DB', id: s.d1 }] }) : fail(404, 10007, 'workers.api.error.script_not_found');
  }
  if (/^\/accounts\/[^/]+\/workers\/domains$/.test(path)) {
    if (m === 'PUT') {
      const d = { id: id(state, 'wd'), hostname: body.hostname, service: body.service, zone_id: body.zone_id };
      state.customDomains = state.customDomains.filter((x) => x.hostname !== d.hostname);
      state.customDomains.push(d);
      const zoneRecs = (state.dns[body.zone_id] ??= []);
      zoneRecs.push({ id: id(state, 'rec'), type: 'AAAA', name: body.hostname, content: '100::', proxied: true });
      return ok(d);
    }
    const host = url.searchParams.get('hostname');
    const service = url.searchParams.get('service');
    return ok(state.customDomains.filter((d) => (!host || d.hostname === host) && (!service || d.service === service)));
  }
  if ((r = /^\/accounts\/[^/]+\/workers\/domains\/([^/]+)$/.exec(path)) && m === 'DELETE') {
    state.customDomains = state.customDomains.filter((d) => d.id !== r![1]);
    return new Response('', { status: 200 });
  }
  if (/^\/accounts\/[^/]+\/email\/routing\/addresses$/.test(path)) {
    if (m === 'POST') {
      const existing = state.destinations.find((d) => d.email === body.email);
      if (existing) return fail(400, 2032, 'Destination address already exists');
      const d = { id: id(state, 'dest'), email: body.email, verified: null };
      state.destinations.push(d);
      return ok(d);
    }
    return page(state.destinations, url);
  }
  if ((r = /^\/accounts\/[^/]+\/email\/routing\/addresses\/([^/]+)$/.exec(path)) && m === 'DELETE') {
    state.destinations = state.destinations.filter((d) => d.id !== r![1]);
    return ok({});
  }
  if (/^\/accounts\/[^/]+\/r2\/buckets$/.test(path)) {
    if (!state.r2Enabled) return fail(403, 10042, 'Please enable R2 through the Cloudflare Dashboard.');
    if (m === 'POST') {
      state.buckets.push(body.name);
      return ok({ name: body.name });
    }
    return ok({ buckets: state.buckets.map((name) => ({ name })) });
  }
  if (path === '/zones') {
    return page(state.zones.map((z) => ({ ...z, account: state.accounts[0] })), url);
  }
  if ((r = /^\/zones\/([^/]+)$/.exec(path))) {
    const z = state.zones.find((x) => x.id === r![1]);
    return z ? ok({ ...z, account: state.accounts[0] }) : fail(404, 7003, 'Could not route to /zones');
  }
  if ((r = /^\/zones\/([^/]+)\/dns_records$/.exec(path))) {
    const recs = (state.dns[r[1]] ??= []);
    if (m === 'POST') {
      const rec: FakeRecord = { id: id(state, 'rec'), type: body.type, name: body.name, content: body.content, priority: body.priority, proxied: body.proxied };
      recs.push(rec);
      return ok(rec);
    }
    const type = url.searchParams.get('type');
    const name = url.searchParams.get('name');
    return page(recs.filter((x) => (!type || x.type === type) && (!name || x.name === name)), url);
  }
  if ((r = /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(path))) {
    const recs = (state.dns[r[1]] ??= []);
    const i = recs.findIndex((x) => x.id === r![2]);
    if (i < 0) return fail(404, 81044, 'Record does not exist.');
    if (m === 'DELETE') {
      recs.splice(i, 1);
      return ok({ id: r[2] });
    }
    recs[i] = { ...recs[i], type: body.type, name: body.name, content: body.content, priority: body.priority, proxied: body.proxied };
    return ok(recs[i]);
  }
  if ((r = /^\/zones\/([^/]+)\/email\/routing$/.exec(path))) return ok({ name: zoneName(state, r[1]), ...(state.routing[r[1]] ?? { enabled: false, status: 'unconfigured' }) });
  if ((r = /^\/zones\/([^/]+)\/email\/routing\/(dns|enable)$/.exec(path))) {
    const zid = r[1];
    if (m === 'GET') return ok({ errors: [], record: [] });
    const recs = (state.dns[zid] ??= []);
    const apex = zoneName(state, zid);
    if (recs.some((x) => x.type === 'MX' && x.name === apex && !/mx\.cloudflare\.net$/.test(x.content))) {
      return fail(400, 2017, 'Your zone has MX records that are not Cloudflare Email Routing records.');
    }
    for (const [host, prio] of [['route1.mx.cloudflare.net', 13], ['route2.mx.cloudflare.net', 86], ['route3.mx.cloudflare.net', 24]] as const) {
      if (!recs.some((x) => x.type === 'MX' && x.content === host)) recs.push({ id: id(state, 'rec'), type: 'MX', name: apex, content: host, priority: prio });
    }
    const spf = recs.find((x) => x.type === 'TXT' && x.name === apex && /^v=spf1/i.test(unq(x.content)));
    if (!spf) recs.push({ id: id(state, 'rec'), type: 'TXT', name: apex, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' });
    else if (!unq(spf.content).includes('_spf.mx.cloudflare.net')) spf.content = `"${unq(spf.content).replace(/\s+([~?+-]?all)$/, ' include:_spf.mx.cloudflare.net $1')}"`;
    if (!recs.some((x) => x.name === `cf2024-1._domainkey.${apex}`)) recs.push({ id: id(state, 'rec'), type: 'TXT', name: `cf2024-1._domainkey.${apex}`, content: '"v=DKIM1; h=sha256; k=rsa; p=MIIBfake"' });
    state.routing[zid] = { enabled: true, status: 'ready' };
    return ok({ name: apex, enabled: true, status: 'ready' });
  }
  if ((r = /^\/zones\/([^/]+)\/email\/routing\/rules\/catch_all$/.exec(path))) {
    if (m === 'PUT') {
      state.catchAll[r[1]] = { id: 'catch_all', ...body };
      return ok(state.catchAll[r[1]]);
    }
    return ok(state.catchAll[r[1]] ?? { id: 'catch_all', name: 'Catch-all', enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] });
  }
  if ((r = /^\/zones\/([^/]+)\/email\/routing\/rules$/.exec(path))) return page(state.rules[r[1]] ?? [], url);
  if ((r = /^\/zones\/([^/]+)\/email\/routing\/rules\/([^/]+)$/.exec(path)) && m === 'PUT') {
    const list = state.rules[r[1]] ?? [];
    const i = list.findIndex((x) => x.id === r![2]);
    if (i >= 0) list[i] = { ...list[i], ...body };
    return ok(list[i] ?? null);
  }
  if (/^\/zones\/[^/]+\/workers\/routes$/.test(path)) return ok([]);
  if (path === '/graphql') return graphql(body);
  return fail(404, 7000, `No route for ${m} ${path}`);
}

function zoneName(state: FakeState, zoneId: string): string {
  return state.zones.find((z) => z.id === zoneId)?.name ?? 'unknown.test';
}

function graphql(body: { query: string }): Response {
  const q = body?.query ?? '';
  const account: Record<string, unknown> = {};
  if (q.includes('workersInvocationsAdaptive')) account.workers = [{ sum: { requests: 1234, errors: 2 }, dimensions: { scriptName: 'openinbox' } }];
  if (q.includes('d1AnalyticsAdaptiveGroups')) account.d1 = [{ sum: { rowsRead: 45678, rowsWritten: 901 }, dimensions: { databaseId: 'db_test' } }];
  if (q.includes('d1StorageAdaptiveGroups')) account.d1Storage = [{ max: { databaseSizeBytes: 3_500_000 }, dimensions: { databaseId: 'db_test' } }];
  if (q.includes('r2StorageAdaptiveGroups')) {
    account.storage = [{ max: { payloadSize: 1_000_000, metadataSize: 1000, objectCount: 12 } }];
    account.ops = [{ sum: { requests: 30 }, dimensions: { actionType: 'PutObject' } }, { sum: { requests: 80 }, dimensions: { actionType: 'GetObject' } }];
  }
  if (q.includes('workersInvocationsAdaptive(limit: 1')) account.workersInvocationsAdaptive = [{ sum: { requests: 1 } }];
  const zones = q.includes('emailRoutingAdaptive')
    ? [{ emailRoutingAdaptive: [{ datetime: new Date().toISOString(), from: 'sender@example.org', to: 'admin@example.com', subject: 'Hello', status: 'delivered', action: 'worker', errorDetail: null, spf: 'pass', dkim: 'pass', dmarc: 'pass' }] }]
    : [];
  return json({ data: { viewer: { accounts: [account], zones } }, errors: null });
}

function resend(state: FakeState, req: Request, path: string, body: any): Response {
  if (!/^Bearer re_/.test(req.headers.get('authorization') ?? '')) return json({ statusCode: 401, name: 'validation_error', message: 'API key is invalid' }, 401);
  let r: RegExpExecArray | null;
  if (path === '/domains' && req.method === 'GET') return json({ data: state.resend.domains.map(({ records: _r, ...d }) => d) });
  if (path === '/domains' && req.method === 'POST') {
    const d = {
      id: `rd_${state.seq++}`,
      name: body.name,
      status: 'not_started',
      records: [
        { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
        { record: 'SPF', name: 'send', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'v=spf1 include:amazonses.com ~all' },
        { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'p=MIGfMA0GCSqfakeresendkey' },
      ],
    };
    state.resend.domains.push(d);
    return json(d);
  }
  if ((r = /^\/domains\/([^/]+)$/.exec(path))) {
    const d = state.resend.domains.find((x) => x.id === r![1]);
    return d ? json(d) : json({ message: 'Domain not found' }, 404);
  }
  if ((r = /^\/domains\/([^/]+)\/verify$/.exec(path))) {
    const d = state.resend.domains.find((x) => x.id === r![1]);
    if (!d) return json({ message: 'Domain not found' }, 404);
    const zone = state.zones.find((z) => z.name === d.name);
    const recs = zone ? (state.dns[zone.id] ?? []) : [];
    const hasDkim = recs.some((x) => x.name === `resend._domainkey.${d.name}` && unq(x.content).includes('fakeresendkey'));
    d.status = hasDkim ? 'verified' : 'pending';
    d.records = d.records.map((x) => ({ ...x, status: hasDkim ? 'verified' : 'pending' }));
    return json({ object: 'domain', id: d.id });
  }
  if (path === '/emails' && req.method === 'POST') {
    if (state.resend.failNext > 0) {
      state.resend.failNext--;
      return json({ statusCode: 500, name: 'internal_server_error', message: 'Temporary failure' }, 500);
    }
    const sent = { id: crypto.randomUUID(), ...body };
    state.resend.emails.push(sent);
    return json({ id: sent.id });
  }
  if (path === '/webhooks' && req.method === 'POST') {
    const id = `wh_${state.seq++}`;
    state.resend.webhooks.push(id);
    return json({ object: 'webhook', id, signing_secret: 'whsec_dGVzdC1zZWNyZXQtZm9yLXdlYmhvb2tz' });
  }
  const hook = path.match(/^\/webhooks\/([^/]+)$/);
  if (hook && req.method === 'DELETE') {
    if (!state.resend.webhooks.includes(hook[1])) return json({ statusCode: 404, name: 'not_found', message: 'Webhook not found' }, 404);
    state.resend.webhooks = state.resend.webhooks.filter((w) => w !== hook[1]);
    return json({ object: 'webhook', id: hook[1], deleted: true });
  }
  return json({ message: `No fake for ${req.method} ${path}` }, 404);
}

function brevo(state: FakeState, req: Request, path: string, body: any): Response {
  if (!req.headers.get('api-key')?.startsWith('xkeysib-')) return json({ code: 'unauthorized', message: 'Key not found' }, 401);
  let r: RegExpExecArray | null;
  if (path === '/account') return json({ email: 'owner@example.com', companyName: 'Example', plan: [{ type: 'free', credits: state.brevo.credits, creditsType: 'sendLimit' }] });
  if (path === '/senders/domains' && req.method === 'POST') {
    state.brevo.domains[body.name] = { id: state.seq++, authenticated: false };
    return json({ id: state.brevo.domains[body.name].id, domain_name: body.name, message: 'Domain added' });
  }
  if ((r = /^\/senders\/domains\/([^/]+)\/authenticate$/.exec(path))) {
    const d = state.brevo.domains[decodeURIComponent(r[1])];
    if (d) d.authenticated = true;
    return json({ domain_name: r[1], message: 'Domain authenticated' });
  }
  if ((r = /^\/senders\/domains\/([^/]+)$/.exec(path))) {
    const name = decodeURIComponent(r[1]);
    const d = state.brevo.domains[name];
    if (!d) return json({ code: 'document_not_found', message: 'Domain does not exist' }, 404);
    return json({
      domain: name,
      verified: d.authenticated,
      authenticated: d.authenticated,
      dns_records: {
        dkim_record: { type: 'TXT', value: 'k=rsa;p=MIGfMA0brevo', host_name: 'mail._domainkey', status: d.authenticated },
        brevo_code: { type: 'TXT', value: 'brevo-code:abc123', host_name: '@', status: d.authenticated },
        dmarc_record: { type: 'TXT', value: 'v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com', host_name: '_dmarc', status: true },
      },
    });
  }
  if (path === '/smtp/email' && req.method === 'POST') {
    state.brevo.emails.push(body);
    return json({ messageId: `<${crypto.randomUUID()}@smtp-relay.mailin.fr>` }, 201);
  }
  if (path === '/webhooks' && req.method === 'POST') return json({ id: state.seq++ }, 201);
  return json({ message: `No fake for ${req.method} ${path}` }, 404);
}

function mailjet(state: FakeState, req: Request, path: string, body: any): Response {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Basic ')) return json({ ErrorMessage: 'Unauthorized' }, 401);
  let r: RegExpExecArray | null;
  if (path === '/v3/REST/myprofile') return json({ Count: 1, Data: [{ Email: 'owner@example.com', CompanyName: 'Example' }] });
  if (path === '/v3/REST/sender' && req.method === 'POST') {
    const domain = String(body.Email).split('@')[1];
    state.mailjet.dns[domain] ??= { id: state.seq++ };
    return json({ Count: 1, Data: [{ ID: state.seq++, Email: body.Email, Status: 'Inactive' }] }, 201);
  }
  if (path.startsWith('/v3/REST/sender')) return json({ Count: 0, Data: [] });
  if (/^\/v3\/REST\/dns\/(\d+)\/check$/.test(path)) return json({ Count: 1, Data: [{ DKIMStatus: 'OK', SPFStatus: 'OK' }] });
  if ((r = /^\/v3\/REST\/dns\/([^/]+)$/.exec(path))) {
    const domain = decodeURIComponent(r[1]);
    const d = state.mailjet.dns[domain];
    if (!d) return json({ ErrorMessage: 'Object not found' }, 404);
    return json({
      Count: 1,
      Data: [
        {
          ID: d.id,
          Domain: domain,
          DKIMRecordName: `mailjet._domainkey.${domain}.`,
          DKIMRecordValue: 'k=rsa; p=MIGfMA0mailjet',
          DKIMStatus: 'Not checked',
          SPFRecordValue: 'v=spf1 include:spf.mailjet.com ~all',
          SPFStatus: 'Not checked',
          OwnerShipToken: 'mj-ownership-123',
          OwnerShipTokenRecordName: `mailjet._abc123.${domain}.`,
        },
      ],
    });
  }
  if (path === '/v3.1/send') {
    state.mailjet.emails.push(body);
    return json({ Messages: [{ Status: 'success', To: [{ Email: 'x', MessageUUID: crypto.randomUUID(), MessageID: state.seq++ }] }] });
  }
  if (path === '/v3/REST/eventcallbackurl') return json({ Count: 1, Data: [{ ID: state.seq++ }] }, 201);
  return json({ ErrorMessage: `No fake for ${req.method} ${path}` }, 404);
}
