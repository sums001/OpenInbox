export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// UTC day key, the unit of Cloudflare's daily free-tier limits.
export function dayKey(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function monthKey(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export function startOfUtcDay(ms = Date.now()): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function daysAgoKey(days: number, ms = Date.now()): string {
  return dayKey(ms - days * DAY);
}
