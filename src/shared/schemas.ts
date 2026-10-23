// Request validation shared by the Worker (enforced) and the web app (form hints).
import { z } from 'zod';
import { LABEL_COLORS, PROVIDER_TYPES } from './constants';

export const address = z.object({ name: z.string().max(200).default(''), address: z.string().trim().min(3).max(254) });
const id = z.coerce.number().int().positive();

export const setupTokenSchema = z.object({
  token: z.string().trim().min(20, 'That does not look like a Cloudflare API token.').max(200),
  newKey: z.boolean().default(false),
});

export const claimSchema = z.object({
  zoneId: z.string().min(10).max(64),
  localPart: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1, 'Enter your name.').max(100),
  password: z.string().min(10, 'Use at least 10 characters.').max(256),
  setupKey: z.string().min(1, 'Paste your recovery key.').max(500),
  replaceMx: z.boolean().default(false),
});

export const loginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});

export const totpSchema = z.object({ code: z.string().trim().min(6).max(20) });

export const recoverSchema = z.object({
  email: z.string().trim().min(3).max(254),
  setupKey: z.string().min(1).max(500),
  newPassword: z.string().min(10).max(256),
});

export const passwordChangeSchema = z.object({ current: z.string().max(256).default(''), next: z.string().min(10).max(256) });

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

export const createUserSchema = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'member']),
  email: z.string().trim().max(254).optional(),
  newMailbox: z.object({ localPart: z.string().trim().min(1).max(64), domainId: id }).nullable().optional(),
  mailboxIds: z.array(id).max(100).optional(),
  password: z.string().max(256).optional(),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  email: z.string().trim().min(3).max(254).optional(),
});

export const memberSchema = z.object({ userId: id, canSend: z.boolean().default(true) });

export const createMailboxSchema = z.object({
  localPart: z.string().trim().min(1).max(64),
  domainId: id,
  displayName: z.string().trim().max(100).default(''),
  kind: z.enum(['personal', 'shared']).default('personal'),
  members: z.array(memberSchema).max(200).default([]),
});

export const autoReplySchema = z.object({
  enabled: z.boolean(),
  subject: z.string().max(300).default(''),
  body: z.string().max(10_000).default(''),
  startAt: z.number().int().nullable().optional(),
  endAt: z.number().int().nullable().optional(),
});

export const updateMailboxSchema = z.object({
  displayName: z.string().trim().max(100).optional(),
  kind: z.enum(['personal', 'shared']).optional(),
  signature: z.string().max(20_000).optional(),
  autoReply: autoReplySchema.nullable().optional(),
  forwardTo: z.array(z.string().trim().max(254)).max(5).optional(),
});

export const aliasSchema = z.object({ localPart: z.string().trim().min(1).max(64), domainId: id });
export const membersSchema = z.object({ members: z.array(memberSchema).max(200) });

export const addDomainSchema = z.object({ zoneId: z.string().min(10).max(64), replaceMx: z.boolean().default(false) });
export const domainPatchSchema = z.object({
  catchAllMailboxId: id.nullable().optional(),
  providerId: id.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export const appDomainSchema = z.object({ subdomain: z.string().trim().min(1).max(63).default('mail') });

export const providerSchema = z.object({
  type: z.enum(PROVIDER_TYPES),
  name: z.string().trim().max(60).optional(),
  config: z.record(z.string(), z.unknown()),
  dailyLimit: z.number().int().min(0).nullable().optional(),
  monthlyLimit: z.number().int().min(0).nullable().optional(),
});

export const providerPatchSchema = z.object({
  name: z.string().trim().max(60).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  dailyLimit: z.number().int().min(0).nullable().optional(),
  monthlyLimit: z.number().int().min(0).nullable().optional(),
  isDefault: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
});

export const r2Schema = z.object({
  bucket: z.string().trim().min(3).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Bucket names use lowercase letters, digits and dashes.'),
  accessKeyId: z.string().trim().min(10).max(200),
  secretAccessKey: z.string().trim().min(10).max(200),
});

export const settingsSchema = z.object({
  instanceName: z.string().trim().min(1).max(60).optional(),
  maxInboundMb: z.number().int().min(1).max(25).optional(),
  trashRetentionDays: z.number().int().min(1).max(3650).optional(),
  spamRetentionDays: z.number().int().min(1).max(3650).optional(),
  spamPolicy: z.enum(['spam', 'reject', 'off']).optional(),
  remoteImages: z.enum(['block', 'allow']).optional(),
  appUrl: z.string().trim().url().max(200).optional(),
});

export const composeSchema = z.object({
  mailboxId: id,
  from: z.string().trim().min(3).max(254),
  to: z.array(address).max(100).default([]),
  cc: z.array(address).max(100).default([]),
  bcc: z.array(address).max(100).default([]),
  subject: z.string().max(998).default(''),
  html: z.string().max(1_500_000).default(''),
  text: z.string().max(1_500_000).optional(),
  replyToMessageId: id.nullable().optional(),
  attachmentIds: z.array(id).max(50).optional(),
  uploadIds: z.array(z.string().max(64)).max(50).optional(),
});

export const sendSchema = z.object({ sendAt: z.number().int().nullable().optional() });

export const threadActionSchema = z.object({
  threadIds: z.array(id).min(1).max(500),
  action: z.enum(['read', 'unread', 'star', 'unstar', 'archive', 'inbox', 'spam', 'notspam', 'trash', 'delete', 'snooze', 'unsnooze', 'label', 'unlabel', 'assign']),
  labelId: id.optional(),
  until: z.number().int().optional(),
  userId: id.nullable().optional(),
});

export const labelSchema = z.object({ name: z.string().trim().min(1).max(60), color: z.enum(LABEL_COLORS).default('slate') });

export const filterSchema = z.object({
  name: z.string().trim().max(80).default(''),
  conditions: z.object({
    match: z.enum(['all', 'any']).default('all'),
    from: z.string().max(200).optional(),
    to: z.string().max(200).optional(),
    subject: z.string().max(200).optional(),
    body: z.string().max(200).optional(),
    hasAttachment: z.boolean().optional(),
    isList: z.boolean().optional(),
  }),
  actions: z.object({
    labelIds: z.array(id).max(20).optional(),
    folder: z.enum(['inbox', 'archive', 'spam', 'trash']).optional(),
    markRead: z.boolean().optional(),
    star: z.boolean().optional(),
    forwardTo: z.string().max(254).optional(),
    neverSpam: z.boolean().optional(),
  }),
  enabled: z.boolean().default(true),
});

export const noteSchema = z.object({ body: z.string().trim().min(1).max(5000) });
export const blockSchema = z.object({ pattern: z.string().trim().min(3).max(254), mailboxId: id.nullable().optional() });
export const destinationSchema = z.object({ email: z.string().trim().email().max(254) });
export const trustedSenderSchema = z.object({ pattern: z.string().trim().min(3).max(254) });
