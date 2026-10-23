// Brevo (https://www.brevo.com), transactional email API v3.
import type { DnsRecordSpec } from '../cloudflare/dns';
import { singleLine } from '../mail/address';
import {
  httpError,
  ProviderError,
  threadingHeaders,
  toBase64,
  type DomainSetup,
  type OutgoingMessage,
  type ProviderAdapter,
  type ProviderQuota,
  type RecordStatus,
  type SendResult,
  type WebhookSetup,
} from './types';

export interface BrevoConfig {
  apiKey: string;
}

interface BrevoRecord {
  type?: string;
  value?: string;
  host_name?: string;
  status?: boolean;
}

interface BrevoDomain {
  id?: number;
  domain_name?: string;
  verified?: boolean;
  authenticated?: boolean;
  dns_records?: Record<string, BrevoRecord>;
}

function toSpecs(domain: string, records: Record<string, BrevoRecord> = {}): (DnsRecordSpec & { status?: RecordStatus })[] {
  const out: (DnsRecordSpec & { status?: RecordStatus })[] = [];
  for (const [key, r] of Object.entries(records)) {
    if (!r?.value || !r.type) continue;
    const type = r.type.toUpperCase();
    if (type !== 'TXT' && type !== 'CNAME' && type !== 'MX') continue;
    const host = (r.host_name ?? '@').replace(/\.$/, '');
    out.push({
      type: type as 'TXT' | 'CNAME' | 'MX',
      name: host === domain ? '@' : host,
      content: r.value,
      purpose: /dkim/i.test(key) ? 'dkim' : /dmarc/i.test(key) ? 'dmarc' : /spf/i.test(key) ? 'spf' : 'verification',
      status: r.status === true ? 'verified' : r.status === false ? 'pending' : 'unknown',
    });
  }
  return out;
}

export class BrevoAdapter implements ProviderAdapter {
  readonly type = 'brevo' as const;

  constructor(
    private config: BrevoConfig,
    private base = 'https://api.brevo.com/v3',
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'api-key': this.config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await httpError('Brevo', res);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async validate() {
    const a = await this.call<{ email?: string; companyName?: string }>('GET', '/account');
    return { account: a.companyName || a.email };
  }

  async quota(): Promise<ProviderQuota> {
    const a = await this.call<{ plan?: { type: string; credits?: number; creditsType?: string }[] }>('GET', '/account');
    const plan = a.plan?.find((p) => p.creditsType === 'sendLimit') ?? a.plan?.[0];
    return { remainingToday: plan?.credits ?? null, plan: plan?.type ?? null };
  }

  private async getDomain(domain: string): Promise<BrevoDomain | null> {
    try {
      return await this.call<BrevoDomain>('GET', `/senders/domains/${encodeURIComponent(domain)}`);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  async addDomain(domain: string): Promise<DomainSetup> {
    let d = await this.getDomain(domain);
    if (!d) {
      await this.call('POST', '/senders/domains', { name: domain });
      d = await this.getDomain(domain);
    }
    return this.toSetup(domain, d);
  }

  private toSetup(domain: string, d: BrevoDomain | null): DomainSetup {
    if (!d) return { externalId: null, status: 'pending', records: [], message: 'Brevo did not return the domain.' };
    return {
      externalId: d.id ? String(d.id) : domain,
      status: d.authenticated ? 'verified' : 'pending',
      records: toSpecs(domain, d.dns_records),
    };
  }

  async checkDomain(domain: string): Promise<DomainSetup> {
    await this.call('PUT', `/senders/domains/${encodeURIComponent(domain)}/authenticate`).catch(() => undefined);
    return this.toSetup(domain, await this.getDomain(domain));
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    const person = (a: { name: string; address: string }) => (a.name ? { email: a.address, name: singleLine(a.name) } : { email: a.address });
    const r = await this.call<{ messageId?: string }>('POST', '/smtp/email', {
      sender: person(m.from),
      to: m.to.map(person),
      cc: m.cc.length ? m.cc.map(person) : undefined,
      bcc: m.bcc.length ? m.bcc.map(person) : undefined,
      replyTo: m.replyTo ? person(m.replyTo) : undefined,
      subject: m.subject,
      textContent: m.text || ' ',
      htmlContent: m.html ?? undefined,
      headers: threadingHeaders(m),
      attachment: m.attachments.length ? m.attachments.map((a) => ({ name: a.filename, content: toBase64(a.content) })) : undefined,
    });
    return { providerMessageId: r.messageId?.replace(/^<|>$/g, '') ?? null };
  }

  async setupWebhook(url: string): Promise<WebhookSetup | null> {
    try {
      const r = await this.call<{ id: number }>('POST', '/webhooks', {
        url,
        description: 'OpenInbox delivery events',
        events: ['delivered', 'hardBounce', 'softBounce', 'spam', 'blocked', 'invalid', 'unsubscribed'],
        type: 'transactional',
      });
      return { id: String(r.id) };
    } catch {
      return null;
    }
  }

  async removeWebhook(id: string): Promise<void> {
    await this.call('DELETE', `/webhooks/${encodeURIComponent(id)}`);
  }
}
