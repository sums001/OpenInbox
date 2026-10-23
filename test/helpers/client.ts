// Drives the Worker like a browser (cookies, CSRF header) and like Email Routing (email()).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import type { Env } from '../../src/worker/env';

export const ORIGIN = 'https://openinbox.tester.workers.dev';
export const ENCRYPTION_KEY = 'test-encryption-key-0123456789abcdef0123456789abcdef';

export class Client {
  cookies = new Map<string, string>();

  // Bindings that differ from the test defaults, e.g. a deployment without ENCRYPTION_KEY.
  constructor(public envOverride: Partial<Env> = {}) {}

  async request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const headers = new Headers({ Origin: ORIGIN, ...extraHeaders });
    if (body !== undefined && !(body instanceof Uint8Array)) headers.set('Content-Type', 'application/json');
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const csrf = this.cookies.get('oi_csrf');
    if (csrf && method !== 'GET' && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrf);
    const req = new Request(ORIGIN + path, {
      method,
      headers,
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, { ...env, ...this.envOverride }, ctx);
    await waitOnExecutionContext(ctx);
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [k, ...v] = pair.split('=');
      const value = v.join('=');
      if (/Max-Age=0/i.test(cookie) || value === '') this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), value);
    }
    return res;
  }

  async json<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  get = <T = any>(path: string) => this.json<T>('GET', path);
  post = <T = any>(path: string, body: unknown = {}) => this.json<T>('POST', path, body);
  patch = <T = any>(path: string, body: unknown = {}) => this.json<T>('PATCH', path, body);
  put = <T = any>(path: string, body: unknown = {}) => this.json<T>('PUT', path, body);
  del = <T = any>(path: string) => this.json<T>('DELETE', path);

  async status(method: string, path: string, body?: unknown): Promise<number> {
    const res = await this.request(method, path, body);
    await res.arrayBuffer();
    return res.status;
  }

  async init(): Promise<void> {
    await this.request('GET', '/api/auth/session');
  }
}

export interface Delivery {
  rejected: string | null;
  forwarded: string[];
}

export async function deliver(raw: string, envelope: { from: string; to: string }): Promise<Delivery> {
  const bytes = new TextEncoder().encode(raw.replace(/\r?\n/g, '\r\n'));
  const result: Delivery = { rejected: null, forwarded: [] };
  const message = {
    from: envelope.from,
    to: envelope.to,
    raw: new Response(bytes).body,
    rawSize: bytes.byteLength,
    headers: new Headers(),
    setReject(reason: string) {
      result.rejected = reason;
    },
    async forward(to: string) {
      result.forwarded.push(to);
    },
    async reply() {},
  } as unknown as ForwardableEmailMessage;
  const ctx = createExecutionContext();
  await worker.email!(message, env, ctx);
  await waitOnExecutionContext(ctx);
  return result;
}

let counter = 0;
export function email(opts: {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  auth?: string;
  extra?: string;
}): string {
  counter++;
  const lines = [
    `From: ${opts.from ?? 'Ann Sender <ann@sender.test>'}`,
    `To: ${opts.to ?? 'admin@example.com'}`,
    `Subject: ${opts.subject ?? `Message ${counter}`}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${opts.messageId ?? `m${counter}.${Date.now()}@sender.test`}>`,
  ];
  if (opts.inReplyTo) lines.push(`In-Reply-To: <${opts.inReplyTo}>`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push(`Authentication-Results: mx.cloudflare.net; ${opts.auth ?? 'dkim=pass header.d=sender.test; dmarc=pass header.from=sender.test; spf=pass smtp.mailfrom=ann@sender.test'}`);
  if (opts.extra) lines.push(opts.extra);
  lines.push('Content-Type: text/plain; charset=utf-8', '', opts.body ?? `Hello number ${counter}.`, '');
  return lines.join('\n');
}

// Claims a fresh instance as admin@example.com and finishes the domain steps.
export async function setupInstance(client: Client): Promise<{ domainId: number }> {
  await client.init();
  const status = await client.get('/api/setup/status');
  if (!status.checks.worker.ok) throw new Error(`worker check failed: ${JSON.stringify(status.checks)}`);
  const { domainId } = await client.post('/api/setup/claim', {
    zoneId: 'zone_example',
    localPart: 'admin',
    displayName: 'Admin Person',
    password: 'correct horse battery',
    setupKey: ENCRYPTION_KEY,
  });
  for (let i = 0; i < 5; i++) {
    const r = await client.post(`/api/admin/domains/${domainId}/setup`);
    if (r.done) break;
  }
  return { domainId };
}
