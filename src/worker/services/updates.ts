// "Update available" notice: compares this build's version with the latest upstream release.
import type { Env } from '../env';
import { UPSTREAM_REPO } from '../../shared/constants';
import { cached } from './usage';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  notes: string | null;
  publishedAt: string | null;
  checkedAt: number;
}

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export async function checkForUpdate(env: Env, fresh = false): Promise<UpdateInfo> {
  const current = __APP_VERSION__;
  return cached(
    env.DB,
    'updates:latest',
    12 * 3_600_000,
    async () => {
      try {
        const res = await fetch(`${env.GITHUB_API_BASE || 'https://api.github.com'}/repos/${UPSTREAM_REPO}/releases/latest`, {
          headers: { 'User-Agent': 'OpenInbox', Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) return { current, latest: null, available: false, url: null, notes: null, publishedAt: null, checkedAt: Date.now() };
        const r = (await res.json()) as { tag_name: string; html_url: string; body?: string; published_at?: string };
        return {
          current,
          latest: r.tag_name,
          available: isNewer(r.tag_name, current),
          url: r.html_url,
          notes: r.body?.slice(0, 2000) ?? null,
          publishedAt: r.published_at ?? null,
          checkedAt: Date.now(),
        };
      } catch {
        return { current, latest: null, available: false, url: null, notes: null, publishedAt: null, checkedAt: Date.now() };
      }
    },
    fresh,
  );
}
