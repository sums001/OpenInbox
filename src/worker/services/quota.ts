// Sending quota per provider, counted per recipient per UTC day (conservative: some providers
// count per message). Monthly use is the sum of the month's days.
import { all, first } from '../db/db';
import { dayKey, monthKey } from '../lib/time';
import type { ProviderRow } from '../providers';

export interface QuotaUse {
  today: number;
  month: number;
  dailyLimit: number | null;
  monthlyLimit: number | null;
}

export async function quotaUse(db: D1Database, p: Pick<ProviderRow, 'id' | 'daily_limit' | 'monthly_limit'>): Promise<QuotaUse> {
  const today = dayKey();
  const row = await first<{ today: number | null; month: number | null }>(
    db,
    'SELECT SUM(CASE WHEN day = ? THEN count ELSE 0 END) AS today, SUM(count) AS month FROM quota_usage WHERE provider_id = ? AND day LIKE ?',
    today,
    p.id,
    `${monthKey()}-%`,
  );
  return { today: row?.today ?? 0, month: row?.month ?? 0, dailyLimit: p.daily_limit, monthlyLimit: p.monthly_limit };
}

// How many more recipients fit today, or null when there is no cap.
export function remaining(q: QuotaUse): number | null {
  const caps = [q.dailyLimit !== null ? q.dailyLimit - q.today : null, q.monthlyLimit !== null ? q.monthlyLimit - q.month : null].filter(
    (x): x is number => x !== null,
  );
  return caps.length ? Math.max(0, Math.min(...caps)) : null;
}

export function quotaStmt(db: D1Database, providerId: number, n: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO quota_usage (provider_id, day, count) VALUES (?, ?, ?) ON CONFLICT (provider_id, day) DO UPDATE SET count = count + excluded.count')
    .bind(providerId, dayKey(), n);
}

export async function allQuotaUse(db: D1Database): Promise<Map<number, { today: number; month: number }>> {
  const rows = await all<{ provider_id: number; today: number; month: number }>(
    db,
    'SELECT provider_id, SUM(CASE WHEN day = ? THEN count ELSE 0 END) AS today, SUM(count) AS month FROM quota_usage WHERE day LIKE ? GROUP BY provider_id',
    dayKey(),
    `${monthKey()}-%`,
  );
  return new Map(rows.map((r) => [r.provider_id, { today: r.today ?? 0, month: r.month ?? 0 }]));
}
