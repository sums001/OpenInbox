// Values shared by the Worker and the web app.

export const APP_NAME = 'OpenInbox';

// The upstream repository, used for the in-app "update available" notice. Forks and Deploy
// button copies keep pointing here so they hear about new releases.
export const UPSTREAM_REPO = 'sums001/OpenInbox';

// Cloudflare free-plan limits the dashboard measures against. Daily limits reset at 00:00 UTC.
export const FREE_LIMITS = {
  workerRequestsPerDay: 100_000,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1DatabaseBytes: 500 * 1000 * 1000,
  d1AccountBytes: 5 * 1000 * 1000 * 1000,
  r2StorageBytes: 10 * 1000 * 1000 * 1000,
  r2ClassAPerMonth: 1_000_000,
  r2ClassBPerMonth: 10_000_000,
  emailRoutingMessageBytes: 25 * 1024 * 1024,
} as const;

// The raw .eml is kept in D1 (text-only mode) only up to this size: 950,000 latin1 bytes is at
// most 1.9 MB as UTF-8, under D1's 2 MB value limit.
export const RAW_D1_MAX_BYTES = 950_000;

export const DEFAULT_SETTINGS = {
  maxInboundMb: 25,
  trashRetentionDays: 30,
  spamRetentionDays: 30,
  spamPolicy: 'spam' as SpamPolicy,
  remoteImages: 'block' as RemoteImagesPolicy,
};

export type SpamPolicy = 'spam' | 'reject' | 'off';
export type RemoteImagesPolicy = 'block' | 'allow';

export const PROVIDER_TYPES = ['resend', 'brevo', 'mailjet', 'smtp'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

// Free-tier sending caps, used as defaults when a provider is connected. Users can change them.
export const PROVIDER_INFO: Record<ProviderType, {
  label: string;
  website: string;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  freeTier: string;
  hasDomainApi: boolean;
}> = {
  resend: {
    label: 'Resend',
    website: 'https://resend.com',
    dailyLimit: 100,
    monthlyLimit: 3000,
    freeTier: '3,000 emails/month, 100/day',
    hasDomainApi: true,
  },
  brevo: {
    label: 'Brevo',
    website: 'https://www.brevo.com',
    dailyLimit: 300,
    monthlyLimit: null,
    freeTier: '300 emails/day',
    hasDomainApi: true,
  },
  mailjet: {
    label: 'Mailjet',
    website: 'https://www.mailjet.com',
    dailyLimit: 200,
    monthlyLimit: 6000,
    freeTier: '6,000 emails/month, 200/day',
    hasDomainApi: true,
  },
  smtp: {
    label: 'SMTP',
    website: '',
    dailyLimit: null,
    monthlyLimit: null,
    freeTier: 'Depends on your provider',
    hasDomainApi: false,
  },
};

export const FOLDERS = ['inbox', 'sent', 'drafts', 'starred', 'snoozed', 'archive', 'spam', 'trash'] as const;
export type Folder = (typeof FOLDERS)[number];
// Folders a thread can physically be in. The others are views.
export const THREAD_FOLDERS = ['inbox', 'archive', 'spam', 'trash'] as const;
export type ThreadFolder = (typeof THREAD_FOLDERS)[number];

export const LABEL_COLORS = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

// Cloudflare API token permissions OpenInbox needs. `key` is the permission key used by the
// dashboard's pre-filled token links; `optional` ones unlock extra features.
export const TOKEN_PERMISSIONS = [
  { key: 'zone', type: 'read', scope: 'Zone', name: 'Zone', access: 'Read', why: 'List your domains', optional: false },
  { key: 'dns', type: 'edit', scope: 'Zone', name: 'DNS', access: 'Edit', why: 'Write MX, SPF, DKIM and DMARC records', optional: false },
  { key: 'email_routing_rules', type: 'edit', scope: 'Zone', name: 'Email Routing Rules', access: 'Edit', why: 'Enable Email Routing and route mail to OpenInbox', optional: false },
  { key: 'workers_routes', type: 'edit', scope: 'Zone', name: 'Workers Routes', access: 'Edit', why: 'Open the app on mail.yourdomain', optional: true },
  { key: 'analytics', type: 'read', scope: 'Zone', name: 'Analytics', access: 'Read', why: 'Show Email Routing delivery logs', optional: true },
  { key: 'workers_scripts', type: 'edit', scope: 'Account', name: 'Workers Scripts', access: 'Edit', why: 'Find this Worker and its database', optional: false },
  { key: 'email_routing_addresses', type: 'edit', scope: 'Account', name: 'Email Routing Addresses', access: 'Edit', why: 'Verify addresses for forwarding', optional: true },
  { key: 'account_analytics', type: 'read', scope: 'Account', name: 'Account Analytics', access: 'Read', why: 'Show free-tier usage on the dashboard', optional: true },
  { key: 'account_settings', type: 'read', scope: 'Account', name: 'Account Settings', access: 'Read', why: 'Show your account name (recommended)', optional: true },
  { key: 'workers_r2', type: 'edit', scope: 'Account', name: 'Workers R2 Storage', access: 'Edit', why: 'Create the attachments bucket (optional feature)', optional: true },
] as const;

export function tokenTemplateUrl(): string {
  const keys = TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type }));
  const params = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(keys),
    accountId: '*',
    zoneId: 'all',
    name: 'OpenInbox',
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${params}`;
}
