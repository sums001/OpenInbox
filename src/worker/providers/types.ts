// The sending provider interface. Everything provider-specific lives in an adapter; the send
// pipeline (services/send.ts) only talks to this interface, so adding a provider never touches it.
import { singleLine, type Address } from '../mail/address';
import type { DnsRecordSpec } from '../cloudflare/dns';
import type { ProviderType } from '../../shared/constants';

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
  inline?: boolean;
}

export interface OutgoingMessage {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo?: Address | null;
  subject: string;
  text: string;
  html?: string | null;
  messageId: string; // ours, without angle brackets
  inReplyTo?: string | null;
  references: string[]; // ends with our own Message-ID
  headers?: Record<string, string>;
  attachments: OutgoingAttachment[];
  raw: string; // the full RFC 5322 message, for adapters that send raw MIME (SMTP)
}

export interface SendResult {
  providerMessageId: string | null;
}

export type RecordStatus = 'pending' | 'verified' | 'failed' | 'unknown';

export interface DomainSetup {
  externalId: string | null;
  status: 'pending' | 'verified' | 'failed';
  records: (DnsRecordSpec & { status?: RecordStatus })[];
  message?: string;
}

export interface ProviderQuota {
  remainingToday?: number | null;
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  plan?: string | null;
}

export interface WebhookSetup {
  id: string;
  secret?: string;
}

export interface ProviderAdapter {
  readonly type: ProviderType;
  // A cheap authenticated call. Resolves with a short account description; throws ProviderError.
  validate(): Promise<{ account?: string; note?: string }>;
  // Registers the sending domain (or finds it) and returns the DNS records it needs.
  addDomain(domain: string): Promise<DomainSetup>;
  // Asks the provider to (re)check the domain and returns the current status.
  checkDomain(domain: string, externalId: string | null): Promise<DomainSetup>;
  send(message: OutgoingMessage): Promise<SendResult>;
  quota?(): Promise<ProviderQuota>;
  // Registers a delivery-event webhook; null when the provider has no API for it.
  setupWebhook?(url: string): Promise<WebhookSetup | null>;
  // Deletes a webhook created by setupWebhook. Throws ProviderError.
  removeWebhook?(id: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public status?: number,
    public code?: string,
  ) {
    super(message);
  }
}

// Turns an HTTP error response into a ProviderError: 429 and 5xx are worth retrying.
export async function httpError(provider: string, res: Response): Promise<ProviderError> {
  const text = await res.text().catch(() => '');
  let detail: string;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    detail = String(j.message ?? j.error ?? j.ErrorMessage ?? (j as { name?: string }).name ?? text);
  } catch {
    detail = text;
  }
  const retryable = res.status === 429 || res.status >= 500;
  return new ProviderError(`${provider}: ${detail.slice(0, 300) || `HTTP ${res.status}`}`, retryable, res.status);
}

export function formatFrom(a: Address): string {
  if (!a.name) return a.address;
  const plain = singleLine(a.name);
  const name = /[",<>@()[\]:;\\]/.test(plain) ? `"${plain.replace(/(["\\])/g, '\\$1')}"` : plain;
  return `${name} <${a.address}>`;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function threadingHeaders(m: OutgoingMessage): Record<string, string> {
  const h: Record<string, string> = { ...(m.headers ?? {}), 'Message-ID': `<${m.messageId}>` };
  if (m.inReplyTo) h['In-Reply-To'] = `<${m.inReplyTo}>`;
  if (m.references.length) h.References = m.references.map((r) => `<${r}>`).join(' ');
  return h;
}
