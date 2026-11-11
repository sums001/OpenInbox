// Mailjet (https://www.mailjet.com): Send API v3.1, sender and DNS APIs v3.
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
  type RecordStatus,
  type SendResult,
  type WebhookSetup,
} from './types';

export interface MailjetConfig {
  apiKey: string;
  apiSecret: string;
}

interface MailjetDns {
  ID: number;
  Domain: string;
  DKIMRecordName?: string;
  DKIMRecordValue?: string;
  DKIMStatus?: string;
  SPFRecordValue?: string;
  SPFStatus?: string;
  OwnerShipToken?: string;
  OwnerShipTokenRecordName?: string;
}

// Headers that have a dedicated property or that Mailjet sets itself. Send API v3.1 refuses them in
// Headers with send-0011 (https://dev.mailjet.com/docs/email-api/send-api-v31/add-email-headers).
// Our Message-ID is one of them: Mailjet uses its own, and replies still thread on ours because it
// is also the last entry of References, as with Resend.
const RESERVED_HEADERS = new Set([
  'from', 'sender', 'subject', 'to', 'cc', 'bcc', 'reply-to', 'return-path', 'delivered-to', 'date', 'message-id', 'list-id',
  'dkim-signature', 'domainkey-status', 'received-spf', 'authentication-results', 'received', 'user-agent', 'x-mailer',
  'x-feedback-id', 'x-csa-complaints', 'x-mailjet-prio', 'x-mailjet-debug', 'x-mailjet-trackopen', 'x-mailjet-trackclick',
  'x-mailjet-segmentation', 'x-mailjet-campaign', 'x-mj-customid', 'x-mj-eventpayload', 'x-mj-vars', 'x-mj-templateerrordeliver',
  'x-mj-templateerrorreporting', 'x-mj-templatelanguage', 'x-mj-templateid', 'x-mj-workflowid', 'x-mj-mid', 'x-mj-errormessage',
  'x-mj-statisticscontactslistid',
]);

interface MailjetSendError {
  ErrorMessage?: string;
  ErrorRelatedTo?: string[];
}

// "Header cannot be customized ... (Headers["Message-ID"])": the field matters, and the raw JSON
// response is too long to show it.
const describeError = (e?: MailjetSendError) => (e?.ErrorMessage ? e.ErrorMessage + (e.ErrorRelatedTo?.length ? ` (${e.ErrorRelatedTo.join(', ')})` : '') : null);

// Send API v3.1 reports errors per message; other APIs answer with ErrorMessage.
export async function mailjetError(res: Response): Promise<ProviderError> {
  try {
    const body = (await res.clone().json()) as { Messages?: { Errors?: MailjetSendError[] }[] };
    const detail = describeError(body.Messages?.flatMap((m) => m.Errors ?? [])[0]);
    if (detail) return new ProviderError(`Mailjet: ${detail.slice(0, 500)}`, res.status === 429 || res.status >= 500, res.status);
  } catch {
    // not JSON
  }
  return httpError('Mailjet', res);
}

const okStatus = (s?: string): RecordStatus => (s === 'OK' ? 'verified' : s === 'Error' ? 'failed' : s ? 'pending' : 'unknown');

function relative(name: string, domain: string): string {
  const n = name.replace(/\.$/, '');
  return n === domain ? '@' : n.endsWith(`.${domain}`) ? n.slice(0, -domain.length - 1) : n;
}

function toSpecs(d: MailjetDns): (DnsRecordSpec & { status?: RecordStatus })[] {
  const out: (DnsRecordSpec & { status?: RecordStatus })[] = [];
  if (d.OwnerShipTokenRecordName && d.OwnerShipToken) {
    out.push({ type: 'TXT', name: relative(d.OwnerShipTokenRecordName, d.Domain), content: d.OwnerShipToken, purpose: 'verification' });
  }
  if (d.DKIMRecordName && d.DKIMRecordValue) {
    out.push({ type: 'TXT', name: relative(d.DKIMRecordName, d.Domain), content: d.DKIMRecordValue, purpose: 'dkim', status: okStatus(d.DKIMStatus) });
  }
  out.push({
    type: 'TXT',
    name: '@',
    content: d.SPFRecordValue && /include:/i.test(d.SPFRecordValue) ? d.SPFRecordValue : 'v=spf1 include:spf.mailjet.com ~all',
    purpose: 'spf',
    status: okStatus(d.SPFStatus),
  });
  return out;
}

export class MailjetAdapter implements ProviderAdapter {
  readonly type = 'mailjet' as const;

  constructor(
    private config: MailjetConfig,
    private base = 'https://api.mailjet.com',
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`${this.config.apiKey}:${this.config.apiSecret}`)}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await mailjetError(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async validate() {
    const r = await this.call<{ Data: { Email?: string; CompanyName?: string }[] }>('GET', '/v3/REST/myprofile');
    return { account: r.Data?.[0]?.CompanyName || r.Data?.[0]?.Email };
  }

  private async dns(domain: string): Promise<MailjetDns | null> {
    try {
      const r = await this.call<{ Data: MailjetDns[] }>('GET', `/v3/REST/dns/${encodeURIComponent(domain)}`);
      return r.Data?.[0] ?? null;
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  async addDomain(domain: string): Promise<DomainSetup> {
    // A wildcard sender registers the whole domain.
    await this.call('POST', '/v3/REST/sender', { Email: `*@${domain}`, EmailType: 'transactional' }).catch((e) => {
      if (!(e instanceof ProviderError) || e.status !== 400) throw e; // 400: already exists
    });
    const d = await this.dns(domain);
    if (!d) return { externalId: null, status: 'pending', records: [], message: 'Mailjet has not created the DNS settings yet. Check again in a minute.' };
    return { externalId: String(d.ID), status: d.DKIMStatus === 'OK' && d.SPFStatus === 'OK' ? 'verified' : 'pending', records: toSpecs(d) };
  }

  async checkDomain(domain: string, externalId: string | null): Promise<DomainSetup> {
    const id = externalId ?? String((await this.dns(domain))?.ID ?? '');
    if (!id) throw new ProviderError(`${domain} is not registered with Mailjet.`);
    await this.call('POST', `/v3/REST/dns/${id}/check`).catch(() => undefined);
    // Validate the wildcard sender too; it needs the ownership record.
    try {
      const senders = await this.call<{ Data: { ID: number; Email: string; Status: string }[] }>('GET', `/v3/REST/sender?Email=*@${encodeURIComponent(domain)}`);
      const s = senders.Data?.[0];
      if (s && s.Status !== 'Active') await this.call('POST', `/v3/REST/sender/${s.ID}/validate`).catch(() => undefined);
    } catch {
      // the DNS status below is what decides
    }
    const d = await this.dns(domain);
    if (!d) return { externalId: id, status: 'pending', records: [] };
    return { externalId: id, status: d.DKIMStatus === 'OK' && d.SPFStatus === 'OK' ? 'verified' : 'pending', records: toSpecs(d) };
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    const person = (a: { name: string; address: string }) => (a.name ? { Email: a.address, Name: singleLine(a.name) } : { Email: a.address });
    const inline = m.attachments.filter((a) => a.inline && a.contentId);
    const files = m.attachments.filter((a) => !(a.inline && a.contentId));
    const r = await this.call<{ Messages: { Status: string; To?: { MessageID: number; MessageUUID: string }[]; Errors?: MailjetSendError[] }[] }>(
      'POST',
      '/v3.1/send',
      {
        Messages: [
          {
            From: person(m.from),
            To: m.to.map(person),
            Cc: m.cc.length ? m.cc.map(person) : undefined,
            Bcc: m.bcc.length ? m.bcc.map(person) : undefined,
            ReplyTo: m.replyTo ? person(m.replyTo) : undefined,
            Subject: m.subject,
            TextPart: m.text,
            HTMLPart: m.html ?? undefined,
            Headers: Object.fromEntries(Object.entries(threadingHeaders(m)).filter(([name]) => !RESERVED_HEADERS.has(name.toLowerCase()))),
            Attachments: files.length ? files.map((a) => ({ ContentType: a.contentType, Filename: a.filename, Base64Content: toBase64(a.content) })) : undefined,
            InlinedAttachments: inline.length
              ? inline.map((a) => ({ ContentType: a.contentType, Filename: a.filename, ContentID: a.contentId, Base64Content: toBase64(a.content) }))
              : undefined,
          },
        ],
      },
    );
    const msg = r.Messages?.[0];
    if (!msg || msg.Status !== 'success') throw new ProviderError(`Mailjet: ${describeError(msg?.Errors?.[0]) ?? 'send failed'}`);
    return { providerMessageId: msg.To?.[0] ? String(msg.To[0].MessageID) : null };
  }

  async setupWebhook(url: string): Promise<WebhookSetup | null> {
    const ids: string[] = [];
    for (const EventType of ['sent', 'bounce', 'spam', 'blocked']) {
      try {
        const r = await this.call<{ Data: { ID: number }[] }>('POST', '/v3/REST/eventcallbackurl', { EventType, Url: url, Version: 2 });
        if (r.Data?.[0]) ids.push(String(r.Data[0].ID));
      } catch {
        // an existing callback for this event type; keep going
      }
    }
    return ids.length ? { id: ids.join(',') } : null;
  }

  // setupWebhook stores one callback ID per event type, comma-separated.
  async removeWebhook(id: string): Promise<void> {
    for (const one of id.split(',').filter(Boolean)) {
      await this.call('DELETE', `/v3/REST/eventcallbackurl/${encodeURIComponent(one)}`);
    }
  }
}
