// R2 through its S3-compatible API (aws4fetch signs requests). Uploads use UNSIGNED-PAYLOAD so a
// 25 MB message isn't hashed on the free plan's CPU budget.
import { AwsClient } from 'aws4fetch';
import type { BlobStore } from './index';
import type { Cloudflare } from '../cloudflare/client';
import { sha256Hex } from '../lib/crypto';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // The keys are derived from OpenInbox's Cloudflare API token (r2KeysFromToken), and follow it
  // when the token is replaced.
  fromToken?: boolean;
  // Only for tests and S3-compatible mocks.
  endpoint?: string;
}

// R2's S3 API accepts a Cloudflare API token that has R2 permission: the token's id is the access
// key id and the SHA-256 of its value the secret access key. OpenInbox's own token has Workers R2
// Storage: Edit, so the person needn't create separate S3 keys.
export async function r2KeysFromToken(cf: Cloudflare, token: string, accountId: string): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  let id: string | undefined;
  try {
    id = (await cf.get<{ id: string }>('/user/tokens/verify')).id;
  } catch {
    // an account token verifies under its account
  }
  id ??= (await cf.get<{ id: string }>(`/accounts/${accountId}/tokens/verify`)).id;
  return { accessKeyId: id, secretAccessKey: await sha256Hex(token) };
}

export class R2S3Store implements BlobStore {
  readonly kind = 'r2' as const;
  readonly maxBytes = Number.POSITIVE_INFINITY;
  private client: AwsClient;
  private base: string;

  constructor(private config: R2Config) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    const endpoint = config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`;
    this.base = `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(config.bucket)}`;
  }

  private url(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, data: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    const res = await this.client.fetch(this.url(key), {
      method: 'PUT',
      body: data,
      headers: { 'Content-Type': contentType, 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' },
    });
    if (!res.ok) throw new Error(`R2 upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.client.fetch(this.url(key), { headers: { 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 read failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async getRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
    if (length <= 0) return new Uint8Array(0);
    const res = await this.client.fetch(this.url(key), {
      headers: { Range: `bytes=${offset}-${offset + length - 1}`, 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 read failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      const res = await this.client.fetch(this.url(key), { method: 'DELETE', headers: { 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' } });
      if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed (${res.status})`);
    }
  }

  // Put, read back and delete a test object: proves the credentials and bucket work.
  async selfTest(): Promise<void> {
    const key = `openinbox-selftest/${crypto.randomUUID()}`;
    const payload = new TextEncoder().encode(`openinbox ${new Date().toISOString()}`);
    await this.put(key, payload, 'text/plain');
    const back = await this.get(key);
    await this.delete([key]);
    if (!back || new TextDecoder().decode(back) !== new TextDecoder().decode(payload)) {
      throw new Error('R2 returned different data than was written.');
    }
  }
}
