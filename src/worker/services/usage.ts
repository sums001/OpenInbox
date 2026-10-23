// Free-tier usage for the dashboard, from Cloudflare's GraphQL analytics (cached 10 minutes),
// plus the D1 size reported with every query.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { databaseSize, first, run } from '../db/db';
import { cfFromEnv } from '../cloudflare/client';
import { errorMessage } from '../lib/errors';
import { dayKey, startOfUtcDay } from '../lib/time';
import { FREE_LIMITS } from '../../shared/constants';
import { r2Store } from '../storage';
import { decryptJson } from '../lib/crypto';
import type { R2Config } from '../storage/r2';

export async function cached<T>(db: D1Database, key: string, ttlMs: number, load: () => Promise<T>, fresh = false): Promise<T> {
  if (!fresh) {
    const row = await first<{ value: string; expires_at: number }>(db, 'SELECT value, expires_at FROM cache WHERE key = ?', key);
    if (row && row.expires_at > Date.now()) return JSON.parse(row.value) as T;
  }
  const value = await load();
  await run(
    db,
    'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
    key,
    JSON.stringify(value),
    Date.now() + ttlMs,
  );
  return value;
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

interface AccountData<T> {
  viewer: { accounts: T[] };
}

// One query per dataset, so a dataset the token can't read (or that the account lacks) doesn't
// hide the others.
const WORKERS_QUERY = `query($account: string!, $since: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $since }) { sum { requests errors } dimensions { scriptName } }
  } }
}`;
const D1_QUERY = `query($account: string!, $day: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: $day }) { sum { rowsRead rowsWritten } dimensions { databaseId } }
  } }
}`;
const D1_STORAGE_QUERY = `query($account: string!, $day: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: d1StorageAdaptiveGroups(limit: 100, filter: { date_geq: $day }) { max { databaseSizeBytes } dimensions { databaseId } }
  } }
}`;

const R2_QUERY = `query($account: string!, $since: Time!, $bucket: string!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      storage: r2StorageAdaptiveGroups(limit: 1, filter: { datetime_geq: $since, bucketName: $bucket }, orderBy: [datetime_DESC]) {
        max { payloadSize metadataSize objectCount }
      }
      ops: r2OperationsAdaptiveGroups(limit: 50, filter: { datetime_geq: $since, bucketName: $bucket }) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

const CLASS_A = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'UploadPart', 'UploadPartCopy', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration', 'ListMultipartUploads', 'LifecycleStorageTierTransition']);

// This Worker's requests. Analytics reports a freshly created Worker as "__unknown__" for a while;
// until its name shows up the share is unknown rather than zero.
export function workerShare(rows: { sum: { requests: number }; dimensions: { scriptName: string } }[], name: string | null | undefined): number | undefined {
  const mine = rows.filter((w) => w.dimensions.scriptName === name);
  if (!name || (!mine.length && rows.some((w) => w.dimensions.scriptName === '__unknown__'))) return undefined;
  return mine.reduce((n, w) => n + w.sum.requests, 0);
}

export async function cloudflareUsage(env: Env, settings: AppSettings, fresh = false): Promise<CloudflareUsage> {
  return cached(
    env.DB,
    'usage:cloudflare',
    10 * 60_000,
    async () => {
      const cf = await cfFromEnv(env, settings).catch(() => null);
      if (!cf || !settings.cfAccountId) return { available: false, reason: 'Connect a Cloudflare token to see usage.', fetchedAt: Date.now() };
      const since = new Date(startOfUtcDay()).toISOString();
      const account = settings.cfAccountId;
      const errors: string[] = [];
      const run = async <T,>(query: string, vars: Record<string, unknown>): Promise<T[] | null> => {
        try {
          return (await cf.graphql<AccountData<{ rows: T[] }>>(query, { account, ...vars })).viewer.accounts[0]?.rows ?? [];
        } catch (e) {
          errors.push(errorMessage(e));
          return null;
        }
      };
      const [workers, d1, d1Storage] = await Promise.all([
        run<{ sum: { requests: number; errors: number }; dimensions: { scriptName: string } }>(WORKERS_QUERY, { since }),
        run<{ sum: { rowsRead: number; rowsWritten: number }; dimensions: { databaseId: string } }>(D1_QUERY, { day: dayKey() }),
        run<{ max: { databaseSizeBytes: number }; dimensions: { databaseId: string } }>(D1_STORAGE_QUERY, { day: dayKey() }),
      ]);
      if (!workers && !d1 && !d1Storage) {
        return {
          available: false,
          reason: errors.some((e) => /authoriz|permission|access/i.test(e))
            ? 'The Cloudflare token needs Account Analytics: Read to show usage.'
            : `Usage unavailable: ${errors[0] ?? 'no data'}`,
          fetchedAt: Date.now(),
        };
      }
      const myD1 = d1?.filter((d) => d.dimensions.databaseId === settings.cfD1Id);
      {
        const usage: CloudflareUsage = {
          available: true,
          workerRequests: workers
            ? {
                used: workers.reduce((n, w) => n + w.sum.requests, 0),
                limit: FREE_LIMITS.workerRequestsPerDay,
                thisApp: workerShare(workers, settings.cfWorkerName),
                errors: workers.reduce((n, w) => n + w.sum.errors, 0),
              }
            : undefined,
          d1RowsRead: d1 ? { used: d1.reduce((n, d) => n + d.sum.rowsRead, 0), limit: FREE_LIMITS.d1RowsReadPerDay, thisApp: myD1?.reduce((n, d) => n + d.sum.rowsRead, 0) } : undefined,
          d1RowsWritten: d1 ? { used: d1.reduce((n, d) => n + d.sum.rowsWritten, 0), limit: FREE_LIMITS.d1RowsWrittenPerDay, thisApp: myD1?.reduce((n, d) => n + d.sum.rowsWritten, 0) } : undefined,
          d1Storage: d1Storage ? { used: d1Storage.reduce((n, d) => n + d.max.databaseSizeBytes, 0), limit: FREE_LIMITS.d1AccountBytes } : undefined,
          r2: null,
          fetchedAt: Date.now(),
        };
        if (settings.storageMode === 'r2' && settings.r2Enc) {
          try {
            const r2 = await decryptJson<R2Config>(env, settings.r2Enc);
            const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
            const rd = await cf.graphql<{ viewer: { accounts: { storage: { max: { payloadSize: number; metadataSize: number; objectCount: number } }[]; ops: { sum: { requests: number }; dimensions: { actionType: string } }[] }[] } }>(
              R2_QUERY,
              { account: settings.cfAccountId, since: monthStart, bucket: r2.bucket },
            );
            const acc = rd.viewer.accounts[0];
            const s = acc?.storage[0]?.max;
            let classA = 0;
            let classB = 0;
            for (const o of acc?.ops ?? []) {
              if (CLASS_A.has(o.dimensions.actionType)) classA += o.sum.requests;
              else classB += o.sum.requests;
            }
            usage.r2 = { storageBytes: (s?.payloadSize ?? 0) + (s?.metadataSize ?? 0), objects: s?.objectCount ?? 0, classA, classB, limitBytes: FREE_LIMITS.r2StorageBytes };
          } catch {
            usage.r2 = null;
          }
        }
        return usage;
      }
    },
    fresh,
  );
}

export async function storageSummary(env: Env, settings: AppSettings) {
  const size = await databaseSize(env.DB);
  const counters = await first<{ messages: number | null; raw: number | null }>(
    env.DB,
    "SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT value FROM counters WHERE key = 'raw_d1_bytes') AS raw",
  );
  const r2 = settings.storageMode === 'r2' ? !!(await r2Store(env, settings).catch(() => null)) : false;
  return {
    d1Bytes: size,
    d1Limit: FREE_LIMITS.d1DatabaseBytes,
    messages: counters?.messages ?? 0,
    rawBytesInD1: counters?.raw ?? 0,
    mode: settings.storageMode,
    r2Connected: r2,
  };
}

// Days until the database is full, from the last 14 days of growth (stored with daily snapshots).
export async function growthEstimate(db: D1Database, currentBytes: number | null): Promise<number | null> {
  if (currentBytes === null) return null;
  const today = dayKey();
  await run(db, 'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING', `dbsize:${today}`, String(currentBytes), Date.now() + 20 * 86_400_000);
  const old = await first<{ key: string; value: string }>(db, "SELECT key, value FROM cache WHERE key LIKE 'dbsize:%' ORDER BY key LIMIT 1");
  if (!old) return null;
  const days = (Date.parse(today) - Date.parse(old.key.slice(7))) / 86_400_000;
  const grown = currentBytes - Number(old.value);
  if (days < 1 || grown <= 0) return null;
  return Math.max(0, Math.round((FREE_LIMITS.d1DatabaseBytes - currentBytes) / (grown / days)));
}
