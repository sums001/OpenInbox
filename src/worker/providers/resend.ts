// Resend (https://resend.com). Sends through Amazon SES, which replaces our Message-ID; the send
// pipeline appends our ID to References so replies still thread (Phase 0).
import type { DnsRecordSpec } from '../cloudflare/dns';
import {
  formatFrom,
  httpError,
  ProviderError,
  threadingHeaders,
  toBase64,
  type DomainSetup,
  type OutgoingMessage,
  type ProviderAdapter,
  type RecordStatus,
  type SendResult,
  type WebhookSetup,
} from './types';

export interface ResendConfig {
  apiKey: string;
}

interface ResendRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
  status?: string;
}

interface ResendDomain {
  id: string;
  name: string;
  status: string;
  records?: ResendRecord[];
}

function recordStatus(s?: string): RecordStatus {
  if (s === 'verified') return 'verified';
  if (s === 'failed' || s === 'temporary_failure') return 'failed';
  return s ? 'pending' : 'unknown';
}

function domainStatus(s: string): DomainSetup['status'] {
  if (s === 'verified') return 'verified';
  if (s === 'failed') return 'failed';
  return 'pending';
}

function toSpecs(records: ResendRecord[] = []): (DnsRecordSpec & { status?: RecordStatus })[] {
  return records
    .filter((r) => !/receiv/i.test(r.record)) // inbound MX belongs to Email Routing, not Resend
    .filter((r) => r.type === 'TXT' || r.type === 'CNAME' || r.type === 'MX')
    .map((r) => ({
      type: r.type as 'TXT' | 'CNAME' | 'MX',
      name: r.name,
      content: r.value,
      priority: r.priority,
      purpose: r.record === 'SPF' && r.type === 'TXT' ? 'spf' : r.record === 'DKIM' ? 'dkim' : r.type === 'MX' ? 'return-path' : r.record === 'SPF' ? 'return-path' : 'other',
      status: recordStatus(r.status),
    }));
}

export class ResendAdapter implements ProviderAdapter {
  readonly type = 'resend' as const;

  constructor(
    private config: ResendConfig,
    private base = 'https://api.resend.com',
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await httpError('Resend', res);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async validate() {
    try {
      const r = await this.call<{ data: ResendDomain[] }>('GET', '/domains');
      return { account: `${r.data?.length ?? 0} domain(s)` };
    } catch (e) {
      // Sending-only keys can't list domains but can send.
      if (e instanceof ProviderError && e.status === 401 && /restricted/i.test(e.message)) {
        return { note: 'This is a sending-only key. Domains must be verified in the Resend dashboard.' };
      }
      throw e;
    }
  }

  private async findDomain(domain: string): Promise<ResendDomain | null> {
    const list = await this.call<{ data: ResendDomain[] }>('GET', '/domains');
    const hit = list.data?.find((d) => d.name.toLowerCase() === domain.toLowerCase());
    return hit ? this.call<ResendDomain>('GET', `/domains/${hit.id}`) : null;
  }

  async addDomain(domain: string): Promise<DomainSetup> {
    const d = (await this.findDomain(domain)) ?? (await this.call<ResendDomain>('POST', '/domains', { name: domain }));
    return { externalId: d.id, status: domainStatus(d.status), records: toSpecs(d.records) };
  }

  async checkDomain(domain: string, externalId: string | null): Promise<DomainSetup> {
    const id = externalId ?? (await this.findDomain(domain))?.id;
    if (!id) throw new ProviderError(`${domain} is not registered with Resend.`);
    let d = await this.call<ResendDomain>('GET', `/domains/${id}`);
    if (d.status !== 'verified') {
      await this.call('POST', `/domains/${id}/verify`).catch(() => undefined);
      d = await this.call<ResendDomain>('GET', `/domains/${id}`);
    }
    return { externalId: id, status: domainStatus(d.status), records: toSpecs(d.records) };
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    const r = await this.call<{ id: string }>('POST', '/emails', {
      from: formatFrom(m.from),
      to: m.to.map(formatFrom),
      cc: m.cc.length ? m.cc.map(formatFrom) : undefined,
      bcc: m.bcc.length ? m.bcc.map(formatFrom) : undefined,
      reply_to: m.replyTo ? [formatFrom(m.replyTo)] : undefined,
      subject: m.subject,
      text: m.text,
      html: m.html ?? undefined,
      headers: threadingHeaders(m),
      attachments: m.attachments.length
        ? m.attachments.map((a) => ({
            filename: a.filename,
            content: toBase64(a.content),
            content_type: a.contentType,
            ...(a.inline && a.contentId ? { content_id: a.contentId } : {}),
          }))
        : undefined,
    });
    return { providerMessageId: r.id ?? null };
  }

  async setupWebhook(url: string): Promise<WebhookSetup | null> {
    try {
      const r = await this.call<{ id: string; signing_secret?: string; secret?: string }>('POST', '/webhooks', {
        endpoint: url,
        events: ['email.delivered', 'email.bounced', 'email.complained', 'email.delivery_delayed', 'email.failed'],
      });
      return { id: r.id, secret: r.signing_secret ?? r.secret };
    } catch {
      return null;
    }
  }

  async removeWebhook(id: string): Promise<void> {
    await this.call('DELETE', `/webhooks/${encodeURIComponent(id)}`);
  }
}
