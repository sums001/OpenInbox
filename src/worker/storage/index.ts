// One storage interface, two modes. Text-only (default): raw .eml up to 950 KB in D1. Attachments
// mode (opt-in): everything in R2 through its S3 API, with credentials stored encrypted in D1, so
// the setup survives redeploys (an R2 binding would be reset to wrangler.jsonc on every deploy).
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { decryptJson } from '../lib/crypto';
import { D1BlobStore } from './d1';
import { R2S3Store, type R2Config } from './r2';

export interface BlobStore {
  readonly kind: 'd1' | 'r2';
  readonly maxBytes: number;
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  getRange(key: string, offset: number, length: number): Promise<Uint8Array | null>;
  delete(keys: string[]): Promise<void>;
}

const r2Cache = new Map<string, R2S3Store>();

export async function r2Store(env: Env, settings: AppSettings): Promise<R2S3Store | null> {
  if (!settings.r2Enc) return null;
  let store = r2Cache.get(settings.r2Enc);
  if (!store) {
    store = new R2S3Store(await decryptJson<R2Config>(env, settings.r2Enc));
    r2Cache.set(settings.r2Enc, store);
  }
  return store;
}

// The store new data is written to.
export async function activeStore(env: Env, settings: AppSettings): Promise<BlobStore> {
  if (settings.storageMode === 'r2') {
    const r2 = await r2Store(env, settings);
    if (r2) return r2;
  }
  return new D1BlobStore(env.DB);
}

// The store an existing object lives in (messages remember where their raw .eml went).
export async function storeFor(env: Env, settings: AppSettings, kind: 'd1' | 'r2'): Promise<BlobStore | null> {
  return kind === 'r2' ? r2Store(env, settings) : new D1BlobStore(env.DB);
}

export { D1BlobStore, R2S3Store };
export type { R2Config };
