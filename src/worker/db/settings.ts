// Instance settings in the key/value `settings` table, with a short per-isolate cache so hot paths
// (every API request, every inbound message) don't re-read them.
import { DEFAULT_SETTINGS, type RemoteImagesPolicy, type SpamPolicy } from '../../shared/constants';
import { all, run } from './db';

export interface AppSettings {
  setupCompletedAt: number | null;
  instanceName: string;
  appUrl: string | null;
  cfAccountId: string | null;
  cfAccountName: string | null;
  cfWorkerName: string | null;
  cfWorkersSubdomain: string | null;
  cfD1Id: string | null;
  cfTokenEnc: string | null; // a token pasted in the UI, encrypted (used when the secret is unset)
  storageMode: 'text' | 'r2';
  r2Enc: string | null; // encrypted {accountId, bucket, accessKeyId, secretAccessKey}
  maxInboundMb: number;
  trashRetentionDays: number;
  spamRetentionDays: number;
  spamPolicy: SpamPolicy;
  remoteImages: RemoteImagesPolicy;
  keyCheck: string | null; // a known value encrypted at setup, to detect a changed ENCRYPTION_KEY
  keyGeneratedAt: number | null; // set when setup generated ENCRYPTION_KEY instead of the deployer
}

const KEYS: Record<keyof AppSettings, string> = {
  setupCompletedAt: 'setup.completed_at',
  instanceName: 'instance.name',
  appUrl: 'app.url',
  cfAccountId: 'cf.account_id',
  cfAccountName: 'cf.account_name',
  cfWorkerName: 'cf.worker_name',
  cfWorkersSubdomain: 'cf.workers_subdomain',
  cfD1Id: 'cf.d1_id',
  cfTokenEnc: 'cf.token',
  storageMode: 'storage.mode',
  r2Enc: 'storage.r2',
  maxInboundMb: 'mail.max_inbound_mb',
  trashRetentionDays: 'mail.trash_retention_days',
  spamRetentionDays: 'mail.spam_retention_days',
  spamPolicy: 'mail.spam_policy',
  remoteImages: 'mail.remote_images',
  keyCheck: 'crypto.key_check',
  keyGeneratedAt: 'crypto.key_generated_at',
};

const NUMERIC = new Set<keyof AppSettings>(['setupCompletedAt', 'keyGeneratedAt', 'maxInboundMb', 'trashRetentionDays', 'spamRetentionDays']);

const DEFAULTS: AppSettings = {
  setupCompletedAt: null,
  instanceName: 'OpenInbox',
  appUrl: null,
  cfAccountId: null,
  cfAccountName: null,
  cfWorkerName: null,
  cfWorkersSubdomain: null,
  cfD1Id: null,
  cfTokenEnc: null,
  storageMode: 'text',
  r2Enc: null,
  maxInboundMb: DEFAULT_SETTINGS.maxInboundMb,
  trashRetentionDays: DEFAULT_SETTINGS.trashRetentionDays,
  spamRetentionDays: DEFAULT_SETTINGS.spamRetentionDays,
  spamPolicy: DEFAULT_SETTINGS.spamPolicy,
  remoteImages: DEFAULT_SETTINGS.remoteImages,
  keyCheck: null,
  keyGeneratedAt: null,
};

const TTL = 10_000;
let cache: { at: number; value: AppSettings } | null = null;

export async function loadSettings(db: D1Database, fresh = false): Promise<AppSettings> {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.value;
  const rows = await all<{ key: string; value: string }>(db, 'SELECT key, value FROM settings');
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const value = { ...DEFAULTS } as Record<string, unknown>;
  for (const [field, key] of Object.entries(KEYS) as [keyof AppSettings, string][]) {
    const raw = byKey.get(key);
    if (raw === undefined) continue;
    value[field] = NUMERIC.has(field) ? Number(raw) : raw;
  }
  cache = { at: Date.now(), value: value as unknown as AppSettings };
  return cache.value;
}

export async function saveSettings(db: D1Database, patch: Partial<AppSettings>): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const [field, val] of Object.entries(patch) as [keyof AppSettings, unknown][]) {
    const key = KEYS[field];
    if (val === null || val === undefined) {
      stmts.push(db.prepare('DELETE FROM settings WHERE key = ?').bind(key));
    } else {
      stmts.push(
        db
          .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .bind(key, String(val), now),
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  cache = null;
}

export function clearSettingsCache(): void {
  cache = null;
}

export async function isSetupComplete(db: D1Database): Promise<boolean> {
  const s = await loadSettings(db);
  if (s.setupCompletedAt) return true;
  // Settled once: re-read without the cache before declaring the instance unclaimed.
  return !!(await loadSettings(db, true)).setupCompletedAt;
}

export async function rawSetting(db: D1Database, key: string): Promise<string | null> {
  const rows = await all<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key);
  return rows[0]?.value ?? null;
}

export async function setRawSetting(db: D1Database, key: string, value: string | null): Promise<void> {
  if (value === null) await run(db, 'DELETE FROM settings WHERE key = ?', key);
  else
    await run(
      db,
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      value,
      Date.now(),
    );
}
