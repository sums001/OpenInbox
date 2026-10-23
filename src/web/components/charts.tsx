// Small dependency-free SVG charts for the dashboard.
import { useState } from 'react';
import { cn } from '../lib/utils';

export function Sparkline({ values, className, color = 'var(--primary)' }: { values: number[]; className?: string; color?: string }) {
  const max = Math.max(1, ...values);
  const w = 100;
  const h = 28;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(h - (v / max) * (h - 2) - 1).toFixed(2)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn('h-7 w-full', className)} aria-hidden>
      <polyline points={`0,${h} ${points} ${w},${h}`} fill={color} fillOpacity={0.12} stroke="none" />
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export interface BarSeries {
  key: string;
  label: string;
  color: string;
}

// Stacked bars with a hover tooltip. Each datum: { label, [series.key]: number }.
export function BarChart({ data, series, height = 180 }: { data: (Record<string, number | string> & { label: string })[]; series: BarSeries[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = data.map((d) => series.reduce((n, s) => n + (Number(d[s.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  return (
    <div className="relative">
      <div className="flex gap-3">
        <div className="flex flex-col justify-between py-0.5 text-right text-[10px] text-faint" style={{ height }}>
          {[...ticks].reverse().map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="relative flex-1" style={{ height }}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-dashed border-border" style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {data.map((d, i) => (
              <div
                key={d.label}
                className="relative flex h-full flex-1 cursor-default flex-col justify-end"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <div className={cn('flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] transition-opacity', hover !== null && hover !== i && 'opacity-50')} style={{ height: `${(totals[i] / top) * 100}%` }}>
                  {series.map((s) => (
                    <div key={s.key} style={{ flexGrow: Number(d[s.key]) || 0, background: s.color }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {hover !== null && (
            <div
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-pop"
              style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}
            >
              <div className="mb-1 font-medium text-fg">{data[hover].label}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-2 text-muted">
                  <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                  <span className="flex-1">{s.label}</span>
                  <span className="font-medium text-fg">{Number(data[hover][s.key]) || 0}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-between pl-8 text-[10px] text-faint">
        <span>{data[0]?.label}</span>
        <span>{data[Math.floor(data.length / 2)]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function niceTicks(max: number): number[] {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

// Radial gauge for "used of limit".
export function Gauge({ value, max, size = 92, label, sub }: { value: number; max: number; size?: number; label: string; sub?: string }) {
  const p = max > 0 ? Math.min(1, value / max) : 0;
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75;
  const color = p >= 0.9 ? 'var(--danger)' : p >= 0.75 ? 'var(--warning)' : 'var(--primary)';
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-[225deg]">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={8} strokeDasharray={`${arc} ${c}`} strokeLinecap="round" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeDasharray={`${arc * p} ${c}`}
          strokeLinecap="round"
          className="transition-[stroke-dasharray] duration-700"
        />
      </svg>
      <div className="-mt-[58px] mb-6 text-center">
        <div className="text-lg font-semibold text-fg">{p > 0 && p < 0.01 ? '<1' : Math.round(p * 100)}%</div>
      </div>
      <div className="text-center text-[13px] font-medium text-fg">{label}</div>
      {sub && <div className="text-center text-xs text-muted">{sub}</div>}
    </div>
  );
}
