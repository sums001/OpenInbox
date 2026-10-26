// Small dependency-free SVG charts for the dashboard.
import { useState } from 'react';
import { cn } from '../lib/utils';

export function Sparkline({ values, className, color = 'var(--primary)' }: { values: number[]; className?: string; color?: string }) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const w = 88;
  const h = 30;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / (max - min || 1)) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('h-[30px] w-[88px] shrink-0 overflow-visible', className)} aria-hidden>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export interface BarSeries {
  key: string;
  label: string;
  color: string;
}

// Stacked bars with a hover tooltip. Each datum: { label, [series.key]: number }.
export function BarChart({ data, series, height = 190 }: { data: (Record<string, number | string> & { label: string })[]; series: BarSeries[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = data.map((d) => series.reduce((n, s) => n + (Number(d[s.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  return (
    <div className="relative">
      <div className="flex gap-2.5">
        <div className="flex w-6 flex-col justify-between text-right text-[11px] text-faint tabular-nums" style={{ height }}>
          {[...ticks].reverse().map((t) => (
            <span key={t} className="-my-1.5 leading-3">
              {t}
            </span>
          ))}
        </div>
        <div className="relative flex-1" style={{ height }}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-border" style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[3px] sm:gap-[5px]">
            {data.map((d, i) => (
              <div key={d.label} className="relative flex h-full flex-1 cursor-default flex-col justify-end" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <div
                  className={cn('flex w-full flex-col-reverse gap-px overflow-hidden rounded-t-[3px] transition-opacity', hover !== null && hover !== i && 'opacity-50', hover === i && 'ring-2 ring-[var(--ring)]')}
                  style={{ height: `${(totals[i] / top) * 100}%` }}
                >
                  {series.map((s) => (
                    <div key={s.key} style={{ flexGrow: Number(d[s.key]) || 0, background: s.color }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {hover !== null && (
            <div
              className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-lg bg-fg px-2.5 py-1.5 text-[11.5px] leading-normal whitespace-nowrap text-bg shadow-pop"
              style={hover > data.length / 2 ? { right: `${((data.length - hover - 0.5) / data.length) * 100}%` } : { left: `${((hover + 0.5) / data.length) * 100}%` }}
            >
              <b className="font-semibold">{data[hover].label}</b>
              {series.map((s) => (
                <span key={s.key}>
                  {' '}
                  · {Number(data[hover][s.key]) || 0} {s.label.toLowerCase()}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-between pl-[34px] text-[11px] text-faint">
        <span>{data[0]?.label}</span>
        <span>{data[Math.floor(data.length / 2)]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function niceTicks(max: number): number[] {
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

// Half-circle gauge for "used of limit", with the percentage in the middle.
export function Gauge({ value, max, label }: { value: number; max: number; label: string }) {
  const p = max > 0 ? Math.min(1, value / max) : 0;
  const arc = Math.PI * 75;
  const color = p >= 0.9 ? 'var(--danger)' : p >= 0.8 ? 'var(--warning)' : 'var(--primary)';
  return (
    <div className="flex flex-col items-center">
      <svg width={180} height={100} viewBox="0 0 180 100" aria-hidden>
        <path d="M15 90 A75 75 0 0 1 165 90" fill="none" stroke="var(--surface-3)" strokeWidth={12} strokeLinecap="round" />
        {p > 0 && (
          <path
            d="M15 90 A75 75 0 0 1 165 90"
            fill="none"
            stroke={color}
            strokeWidth={12}
            strokeLinecap="round"
            strokeDasharray={`${Math.max(arc * p, 1)} 400`}
            className="transition-[stroke-dasharray] duration-700"
          />
        )}
      </svg>
      <div className="-mt-[46px] text-center">
        <div className="text-2xl font-semibold tracking-[-0.02em] tabular-nums">{p > 0 && p < 0.01 ? '<1' : Math.round(p * 100)}%</div>
        <div className="text-xs text-muted">{label}</div>
      </div>
    </div>
  );
}
