// Connecting a phone (the OpenInbox mobile app) by QR code, without typing a password into it.
//
//   1. The signed-in web app creates a pairing: a code for the QR code, and a short code for
//      typing by hand. Both work once, for 5 minutes.
//   2. The phone claims the pairing with either code and its name ("Pixel 8"), and gets a secret
//      to poll with. It learns nothing about the account yet.
//   3. The web app shows "Pixel 8 wants to connect" and the person allows or denies it. A copy of
//      the QR code is useless without that click.
//   4. On allow, the phone's key is created: an Inbox API key of kind 'device', listed under
//      Settings > Devices. The phone collects it once, with its secret; then the pairing is gone.
import type { Env } from '../env';
import { all, first, run } from '../db/db';
import { decrypt, encrypt, randomBytes, randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { newId } from '../lib/ids';
import { conflict, notFound } from '../lib/errors';
import { MINUTE } from '../lib/time';
import { newApiKey } from '../auth/api-key';

const TTL = 5 * MINUTE;
export const MAX_DEVICES = 20;
// 32 letters and digits without the look-alikes 0/O and 1/I: 8 of them are 40 bits.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newShortCode(): string {
  const chars = [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

// "abcd efgh", "ABCD-EFGH" → "ABCD-EFGH"; null when it can't be a short code.
export function normalizeShortCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8 || [...c].some((ch) => !ALPHABET.includes(ch))) return null;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

interface PairingRow {
  id: number;
  user_id: number;
  claim_hash: string | null;
  status: 'waiting' | 'claimed' | 'approved' | 'denied';
  device_name: string | null;
  platform: string | null;
  token_enc: string | null;
  expires_at: number;
}

// A new pairing replaces the user's earlier ones still in progress (a closed dialog).
export async function createPairing(env: Env, userId: number, server: string) {
  const db = env.DB;
  const now = Date.now();
  await run(db, "DELETE FROM device_pairings WHERE expires_at < ? OR (user_id = ? AND status IN ('waiting', 'claimed'))", now, userId);
  const code = randomToken(32);
  const shortCode = newShortCode();
  const id = newId();
  await run(
    db,
    'INSERT INTO device_pairings (id, user_id, code_hash, short_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    userId,
    await sha256Hex(code),
    await sha256Hex(shortCode),
    now,
    now + TTL,
  );
  return { id, url: `openinbox://pair?${new URLSearchParams({ v: '1', server, code })}`, shortCode, expiresAt: now + TTL };
}

export type PairingStatus = 'waiting' | 'claimed' | 'approved' | 'denied' | 'expired';

const statusOf = (r: PairingRow, now = Date.now()): PairingStatus => (r.expires_at < now ? 'expired' : r.status);

export async function pairingStatus(db: D1Database, userId: number, id: number) {
  const r = await first<PairingRow>(db, 'SELECT * FROM device_pairings WHERE id = ? AND user_id = ?', id, userId);
  if (!r) return { status: 'expired' as PairingStatus, deviceName: null, platform: null, expiresAt: null };
  return { status: statusOf(r), deviceName: r.device_name, platform: r.platform, expiresAt: r.expires_at };
}

// The phone's side. Null when no pairing is waiting for that code.
export async function claimPairing(env: Env, input: { code?: string; shortCode?: string; name: string; platform: string }) {
  const now = Date.now();
  const short = input.shortCode ? normalizeShortCode(input.shortCode) : null;
  if (!input.code && !short) return null;
  const hash = await sha256Hex(input.code ?? short!);
  const column = input.code ? 'code_hash' : 'short_hash';
  const row = await first<PairingRow>(env.DB, `SELECT * FROM device_pairings WHERE ${column} = ?`, hash);
  if (!row || statusOf(row, now) !== 'waiting') return null;
  const secret = randomToken(32);
  const name = input.name.trim().slice(0, 60) || 'Phone';
  // Only the first phone to claim it gets it.
  const r = await run(
    env.DB,
    "UPDATE device_pairings SET status = 'claimed', claim_hash = ?, device_name = ?, platform = ?, expires_at = ? WHERE id = ? AND status = 'waiting'",
    await sha256Hex(secret),
    name,
    input.platform,
    now + TTL,
    row.id,
  );
  if (!r.meta.changes) return null;
  return { id: row.id, secret, expiresAt: now + TTL };
}

export async function decidePairing(env: Env, userId: number, id: number, allow: boolean): Promise<{ deviceId: number | null; name: string }> {
  const db = env.DB;
  const now = Date.now();
  const row = await first<PairingRow>(db, 'SELECT * FROM device_pairings WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw notFound('This connection request is gone. Start again.');
  if (statusOf(row, now) !== 'claimed') throw conflict('No phone is waiting for approval on this code any more. Start again.');
  const name = row.device_name ?? 'Phone';
  if (!allow) {
    await run(db, "UPDATE device_pairings SET status = 'denied', expires_at = ? WHERE id = ?", now + TTL, id);
    return { deviceId: null, name };
  }
  const count = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND kind = 'device'", userId);
  if ((count?.n ?? 0) >= MAX_DEVICES) throw conflict(`You can connect at most ${MAX_DEVICES} phones. Remove one you no longer use.`);
  const { key, prefix, hash } = await newApiKey();
  const deviceId = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, mailbox_ids, created_at, kind, platform) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'device', ?)",
      )
      .bind(deviceId, userId, name, prefix, hash, JSON.stringify(['read', 'send', 'modify']), now, row.platform),
    db.prepare("UPDATE device_pairings SET status = 'approved', token_enc = ?, expires_at = ? WHERE id = ?").bind(await encrypt(env, key), now + TTL, id),
  ]);
  return { deviceId, name };
}

// The phone polls with its secret until the person decides. The key is handed over once.
export async function collectPairing(env: Env, id: number, secret: string) {
  const db = env.DB;
  const row = await first<PairingRow & { email: string; name: string }>(
    db,
    'SELECT p.*, u.email, u.name FROM device_pairings p JOIN users u ON u.id = p.user_id WHERE p.id = ?',
    id,
  );
  if (!row?.claim_hash || !(await safeEqual(await sha256Hex(secret), row.claim_hash))) throw notFound('Unknown connection request.');
  const status = statusOf(row);
  if (status === 'claimed') return { status: 'waiting' as const, expiresAt: row.expires_at };
  await run(db, 'DELETE FROM device_pairings WHERE id = ?', id);
  if (status === 'approved' && row.token_enc) {
    return { status: 'approved' as const, token: await decrypt(env, row.token_enc), user: { email: row.email, name: row.name } };
  }
  return { status: status === 'denied' ? ('denied' as const) : ('expired' as const) };
}

export async function listDevices(db: D1Database, userId: number) {
  const rows = await all<{ id: number; name: string; platform: string | null; created_at: number; last_used_at: number | null; last_used_ip: string | null }>(
    db,
    "SELECT id, name, platform, created_at, last_used_at, last_used_ip FROM api_keys WHERE user_id = ? AND kind = 'device' ORDER BY created_at DESC",
    userId,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, createdAt: r.created_at, lastUsedAt: r.last_used_at, lastUsedIp: r.last_used_ip }));
}
