// Adds every domain the Cloudflare token can reach, in any account, and runs each one's setup
// steps in turn, showing progress. The server adds a few zones per call, so it is asked until none
// are left. Domains it leaves out (mail already handled elsewhere, no access, removed) are listed.
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleDashed, CircleX, LoaderCircle, Route } from 'lucide-react';
import { errorText, get, post } from '../lib/api';
import { runDomainSetup } from '../lib/domain-setup';
import type { DomainInfo } from '../lib/types';

interface Row {
  id: number;
  name: string;
  relayed: boolean;
  state: 'waiting' | 'working' | 'done' | 'error';
  detail?: string;
}

interface Skipped {
  zoneId: string;
  name: string;
  reason: 'mx_elsewhere' | 'no_access' | 'removed';
  detail: string;
}

export interface AutoAddSummary {
  done: number;
  failed: number;
  skipped: number;
}

export function AutoAddDomains({ onFinished }: { onFinished?: (s: AutoAddSummary) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [phase, setPhase] = useState<'finding' | 'setting-up' | 'finished'>('finding');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const update = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    (async () => {
      const found: Row[] = [];
      let left: Skipped[] = [];
      try {
        // Domains added earlier (by the hourly check, or a setup left half-way) are finished too.
        const existing = await get<DomainInfo[]>('/admin/domains');
        for (const d of existing) if (d.status === 'pending' && !d.setup.done) found.push({ id: d.id, name: d.name, relayed: d.relayed, state: 'waiting' });
        for (let i = 0; i < 20; i++) {
          const r = await post<{ added: { id: number; name: string; relayed: boolean }[]; skipped: Skipped[]; remaining: number }>('/admin/domains/auto');
          for (const a of r.added) found.push({ ...a, state: 'waiting' });
          left = r.skipped;
          setRows([...found]);
          setSkipped(left);
          if (!r.remaining) break;
        }
      } catch (e) {
        setError(errorText(e));
      }
      setRows([...found]);
      setPhase('setting-up');
      let done = 0;
      let failed = 0;
      for (const row of found) {
        update(row.id, { state: 'working' });
        try {
          const r = await runDomainSetup(row.id, () => undefined);
          if (r.done) {
            done++;
            update(row.id, { state: 'done', detail: undefined });
          } else {
            failed++;
            update(row.id, { state: 'error', detail: r.error ? `${r.step ? `${r.step}: ` : ''}${r.error}` : 'Not finished.' });
          }
        } catch (e) {
          failed++;
          update(row.id, { state: 'error', detail: errorText(e) });
        }
      }
      setPhase('finished');
      onFinished?.({ done, failed, skipped: left.length });
    })();
  }, [onFinished]);

  return (
    <div className="space-y-3">
      {phase === 'finding' && (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="h-4 w-4 animate-spin text-primary" /> Looking for domains in your Cloudflare accounts…
        </div>
      )}
      {phase !== 'finding' && !rows.length && !error && <div className="text-[13px] text-muted">Every domain the token can reach is already set up.</div>}
      {!!rows.length && (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex gap-2.5">
              <span className="mt-0.5">
                {r.state === 'done' ? (
                  <CircleCheck className="h-4 w-4 text-success" />
                ) : r.state === 'error' ? (
                  <CircleX className="h-4 w-4 text-danger" />
                ) : r.state === 'working' ? (
                  <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <CircleDashed className="h-4 w-4 text-faint" />
                )}
              </span>
              <span className="min-w-0 flex-1 text-[13px] leading-snug">
                <span className="font-medium">{r.name}</span>
                {r.relayed && (
                  <span className="ml-1.5 inline-flex items-center gap-1 text-xs text-muted" title="In another Cloudflare account: its mail comes through a relay Worker there.">
                    <Route className="h-3 w-3" /> relay
                  </span>
                )}
                {r.detail && <span className={`block text-xs ${r.state === 'error' ? 'text-danger' : 'text-muted'}`}>{r.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!!skipped.length && (
        <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-[12.5px]">
          <div className="mb-1 font-medium">Left for you to decide</div>
          <ul className="space-y-1 text-muted">
            {skipped.map((s) => (
              <li key={s.zoneId}>
                <span className="font-medium text-fg">{s.name}</span>: {s.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <div className="text-[13px] text-danger">{error}</div>}
    </div>
  );
}
