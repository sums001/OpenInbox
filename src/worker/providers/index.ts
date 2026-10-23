// Builds the adapter for a stored provider. Credentials are decrypted only here, per use.
import type { Env } from '../env';
import { decryptJson } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import type { ProviderType } from '../../shared/constants';
import { BrevoAdapter, type BrevoConfig } from './brevo';
import { MailjetAdapter, type MailjetConfig } from './mailjet';
import { ResendAdapter, type ResendConfig } from './resend';
import { SmtpAdapter, type SmtpConfig } from './smtp';
import type { ProviderAdapter } from './types';

export type ProviderConfig = ResendConfig | BrevoConfig | MailjetConfig | SmtpConfig;

export interface ProviderRow {
  id: number;
  type: ProviderType;
  name: string;
  config: string;
  status: 'unknown' | 'connected' | 'error';
  last_error: string | null;
  checked_at: number | null;
  priority: number;
  is_default: number;
  daily_limit: number | null;
  monthly_limit: number | null;
  webhook_secret: string | null;
  webhook_id: string | null;
  created_at: number;
}

export function createAdapter(env: Env, type: ProviderType, config: ProviderConfig): ProviderAdapter {
  switch (type) {
    case 'resend':
      return new ResendAdapter(config as ResendConfig, env.RESEND_API_BASE || undefined);
    case 'brevo':
      return new BrevoAdapter(config as BrevoConfig, env.BREVO_API_BASE || undefined);
    case 'mailjet':
      return new MailjetAdapter(config as MailjetConfig, env.MAILJET_API_BASE || undefined);
    case 'smtp':
      return new SmtpAdapter(config as SmtpConfig);
    default:
      throw badRequest(`Unknown provider type ${String(type)}`);
  }
}

export async function adapterFor(env: Env, row: ProviderRow): Promise<ProviderAdapter> {
  return createAdapter(env, row.type, await decryptJson<ProviderConfig>(env, row.config));
}

// Checks the shape of credentials submitted in the UI, per provider type.
export function parseProviderConfig(type: ProviderType, input: Record<string, unknown>): ProviderConfig {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
  if (type === 'resend' || type === 'brevo') {
    if (!str('apiKey')) throw badRequest('Enter the API key.');
    return { apiKey: str('apiKey') };
  }
  if (type === 'mailjet') {
    if (!str('apiKey') || !str('apiSecret')) throw badRequest('Enter the API key and secret key.');
    return { apiKey: str('apiKey'), apiSecret: str('apiSecret') };
  }
  const port = Number(input.port);
  if (!str('host')) throw badRequest('Enter the SMTP server.');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw badRequest('Enter a valid port.');
  if (port === 25) throw badRequest('Port 25 is blocked on Cloudflare Workers. Use 587 (STARTTLS) or 465 (TLS).');
  const security = input.security === 'starttls' || input.security === 'tls' ? input.security : port === 465 ? 'tls' : 'starttls';
  return { host: str('host'), port, security, username: str('username'), password: typeof input.password === 'string' ? input.password : '' };
}

// The credentials with secrets masked, for showing in the UI.
export function maskedConfig(type: ProviderType, config: ProviderConfig): Record<string, string | number> {
  const mask = (s: string) => (s.length <= 8 ? '••••' : `${s.slice(0, 4)}••••${s.slice(-4)}`);
  if (type === 'smtp') {
    const c = config as SmtpConfig;
    return { host: c.host, port: c.port, security: c.security, username: c.username, password: c.password ? '••••••••' : '' };
  }
  if (type === 'mailjet') {
    const c = config as MailjetConfig;
    return { apiKey: mask(c.apiKey), apiSecret: '••••••••' };
  }
  return { apiKey: mask((config as ResendConfig).apiKey) };
}
