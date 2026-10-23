// Shapes of API responses, as the web app uses them.
import type { ProviderType, Role } from '../../shared/constants';

export interface Address {
  name: string;
  address: string;
}

export interface Session {
  setupComplete: boolean;
  instanceName: string;
  version: string;
  storageMode: 'text' | 'r2';
  remoteImages: 'block' | 'allow';
  user: (SessionUser & { mfaPending: boolean }) | null;
}

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  preferences: Record<string, unknown>;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Mailbox {
  id: number;
  address: string;
  displayName: string;
  kind: 'personal' | 'shared';
  canSend: boolean;
  signature: string;
  state: number;
  addresses: { id: number; address: string; isPrimary: boolean; displayName: string | null }[];
  labels: Label[];
  unread: Record<string, number>;
}

export interface ThreadSummary {
  id: number;
  mailboxId: number;
  folder: string;
  subject: string;
  snippet: string;
  participants: Address[];
  messageCount: number;
  unreadCount: number;
  draftCount: number;
  hasAttachments: boolean;
  starred: boolean;
  lastMessageAt: number;
  lastSentAt: number | null;
  snoozedUntil: number | null;
  assignedTo: number | null;
  labels: number[];
}

export interface Attachment {
  id: number;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  contentId: string | null;
  stored: boolean;
}

export interface Message {
  id: number;
  direction: 'in' | 'out';
  status: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address | null;
  deliveredTo: string | null;
  subject: string;
  snippet: string;
  sentAt: number;
  isRead: boolean;
  text: string;
  html: string | null;
  htmlDeferred: boolean;
  truncated: boolean;
  rawAvailable: boolean;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  spamReason: string | null;
  listUnsubscribe: { url?: string; mailto?: string; oneClick: boolean } | null;
  error: string | null;
  sendAt: number | null;
  messageId: string | null;
  attachments: Attachment[];
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: Message[];
  notes: { id: number; userId: number | null; name: string; body: string; createdAt: number }[];
  canSend: boolean;
}

export interface DomainSetupStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  message?: string;
}

export interface HealthItem {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface DomainInfo {
  id: number;
  name: string;
  zoneId: string;
  status: 'pending' | 'active' | 'error' | 'disabled';
  catchAllMailboxId: number | null;
  providerId: number | null;
  appHostname: string | null;
  addresses: number;
  health: { items: HealthItem[]; conflicts: { address: string; action: string }[]; checkedAt: number } | null;
  healthCheckedAt: number | null;
  setup: { steps: DomainSetupStep[]; done: boolean };
  createdAt: number;
}

export interface ZoneInspection {
  zoneId: string;
  name: string;
  mx: { host: string; priority?: number }[];
  mxState: 'none' | 'cloudflare' | 'other';
  routing: { enabled: boolean; status: string } | null;
  catchAll: 'openinbox' | 'other' | 'none';
  conflicts: { address: string; action: string }[];
}

export interface ProviderInfo {
  id: number;
  type: ProviderType;
  name: string;
  status: 'unknown' | 'connected' | 'error';
  lastError: string | null;
  checkedAt: number | null;
  priority: number;
  isDefault: boolean;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  usedToday: number;
  usedMonth: number;
  webhook: boolean;
  config: Record<string, string | number>;
  domains: { domainId: number; name: string; status: 'pending' | 'verified' | 'failed'; records: DnsRecordInfo[]; lastError: string | null; checkedAt: number | null }[];
}

export interface DnsRecordInfo {
  type: string;
  name: string;
  content: string;
  priority?: number;
  purpose?: string;
  status?: string;
}

export interface UserSummary {
  id: number;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  totpEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  mailboxes: { id: number; address: string; canSend: boolean }[];
}

export interface MailboxAdmin {
  id: number;
  address: string;
  displayName: string;
  kind: 'personal' | 'shared';
  domainId: number;
  aliases: { id: number; address: string }[];
  members: { userId: number; name: string; email: string; canSend: boolean }[];
  threads: number;
  unread: number;
  isCatchAll: boolean;
  createdAt: number;
}

export interface PermissionCheck {
  key: string;
  name: string;
  scope: string;
  access: string;
  why: string;
  optional: boolean;
  ok: boolean;
  untested?: boolean;
  error?: string;
}

export interface Metric {
  used: number;
  limit: number;
  thisApp?: number;
}

export interface CloudflareUsage {
  available: boolean;
  reason?: string;
  workerRequests?: Metric & { errors: number };
  d1RowsRead?: Metric;
  d1RowsWritten?: Metric;
  d1Storage?: Metric;
  r2?: { storageBytes: number; objects: number; classA: number; classB: number; limitBytes: number } | null;
  fetchedAt: number;
}

export interface Overview {
  instanceName: string;
  stats: {
    today: Traffic;
    week: Traffic;
    month: Traffic;
    series: (Traffic & { day: string })[];
    unread: number;
    messages: number;
  };
  counts: { users: number; mailboxes: number; aliases: number; domains: number; providers: number };
  problems: { unparsed: number; failed: number; scheduled: number; domainErrors: number; providerErrors: number };
  domains: { id: number; name: string; status: string; sendingVerified: boolean; appHostname: string | null; catchAll: boolean; health: { key: string; status: string }[] }[];
  providers: { id: number; type: ProviderType; name: string; status: string; isDefault: boolean; lastError: string | null; dailyLimit: number | null; monthlyLimit: number | null; usedToday: number; usedMonth: number }[];
  checklist: { id: string; label: string; done: boolean; href: string; optional?: boolean }[];
  activity: { id: number; action: string; target: string | null; at: number; by: string | null }[];
  recentInbound: { id: number; at: number; from: string; to: string; subject: string; status: string }[];
  storageMode: 'text' | 'r2';
  storage: { d1Bytes: number | null; d1Limit: number; messages: number; rawBytesInD1: number; mode: 'text' | 'r2'; r2Connected: boolean; daysUntilFull: number | null };
  update: { current: string; latest: string | null; available: boolean; url: string | null; notes: string | null };
}

export interface Traffic {
  received: number;
  sent: number;
  spam: number;
  rejected: number;
}
