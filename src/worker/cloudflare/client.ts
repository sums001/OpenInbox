// Minimal Cloudflare API client (REST v4 + GraphQL analytics) with typed errors.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { decrypt } from '../lib/crypto';

export interface CfMessage {
  code: number;
  message: string;
}

export class CfError extends Error {
  constructor(
    public status: number,
    public errors: CfMessage[],
    public path: string,
  ) {
    super(errors.map((e) => `${e.message} (${e.code})`).join('; ') || `Cloudflare API error ${status}`);
  }

  has(code: number): boolean {
    return this.errors.some((e) => e.code === code);
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403 || this.has(10000) || this.has(9109) || this.has(1000);
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: CfMessage[];
  messages?: CfMessage[];
  result: T;
  result_info?: { page: number; per_page: number; total_pages?: number; count: number; total_count?: number; cursor?: string };
}

export const DEFAULT_CF_API = 'https://api.cloudflare.com/client/v4';

export class Cloudflare {
  constructor(
    private token: string,
    private base = DEFAULT_CF_API,
  ) {}

  async envelope<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Envelope<T>;
    try {
      // Some endpoints (custom domain DELETE) return an empty body on success.
      json = text ? (JSON.parse(text) as Envelope<T>) : ({ success: res.ok, result: null as T } as Envelope<T>);
    } catch {
      throw new CfError(res.status, [{ code: res.status, message: `Unexpected response from Cloudflare (${res.status})` }], path);
    }
    if (!res.ok || json.success === false) throw new CfError(res.status, json.errors?.length ? json.errors : [], path);
    return json;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.envelope<T>(method, path, body)).result;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  // Follows page-based pagination, up to maxPages.
  async paginate<T>(path: string, perPage = 50, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const env = await this.envelope<T[]>('GET', `${path}${sep}page=${page}&per_page=${perPage}`);
      out.push(...(env.result ?? []));
      const info = env.result_info;
      if (!info || (info.total_pages !== undefined ? page >= info.total_pages : (env.result?.length ?? 0) < perPage)) break;
    }
    return out;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.base + '/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] | null };
    if (!res.ok || json.errors?.length) {
      throw new CfError(res.status, (json.errors ?? []).map((e) => ({ code: 0, message: e.message })), '/graphql');
    }
    return json.data as T;
  }
}

// The token comes from the CF_API_TOKEN secret, or from one pasted on the setup page (stored
// encrypted). Returns null when neither exists.
export async function cfFromEnv(env: Env, settings: AppSettings): Promise<Cloudflare | null> {
  const token = await cfToken(env, settings);
  return token ? new Cloudflare(token, env.CF_API_BASE || DEFAULT_CF_API) : null;
}

export async function cfToken(env: Env, settings: AppSettings): Promise<string | null> {
  if (env.CF_API_TOKEN) return env.CF_API_TOKEN;
  if (settings.cfTokenEnc) return decrypt(env, settings.cfTokenEnc);
  return null;
}
