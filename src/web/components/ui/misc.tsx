import { useState, type ReactNode } from 'react';
import { Check, CircleCheck, CircleX, Copy, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import { cn, copyText } from '../../lib/utils';
import { hue, initials } from '../../lib/format';

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn('h-4 w-4 animate-spin text-muted', className)} />;
}

export function PageSpinner() {
  return (
    <div className="flex h-full min-h-48 items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border border-border bg-surface shadow-card', className)}>{children}</div>;
}

export function CardHeader({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon && <div className="shrink-0 text-faint [&>svg]:h-4 [&>svg]:w-4">{icon}</div>}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {description && <p className="text-[12.5px] text-muted text-pretty">{description}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  primary: 'bg-primary-soft text-primary-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};
const dots: Record<Tone, string> = { neutral: 'bg-faint', primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' };

// Tag-shaped badge; `pill` makes it round, for statuses.
export function Badge({ tone = 'neutral', pill, children, className }: { tone?: Tone; pill?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-[22px] items-center gap-1.5 px-2 text-xs font-medium whitespace-nowrap [&>svg]:h-3 [&>svg]:w-3', pill ? 'rounded-full' : 'rounded-md', tones[tone], className)}>
      {children}
    </span>
  );
}

// Status pill with a dot: Connected, Verified, Pending.
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap', tones[tone])}>
      <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'neutral' ? 'bg-border-strong' : dots[tone])} />
      {children}
    </span>
  );
}

// A dot with a soft ring of the same tone.
export function StatusDot({ tone }: { tone: Tone }) {
  const ring = { neutral: 'ring-surface-2', primary: 'ring-primary-soft', success: 'ring-success-soft', warning: 'ring-warning-soft', danger: 'ring-danger-soft' }[tone];
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full ring-3', dots[tone], ring)} />;
}

export function Alert({ tone = 'neutral', title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'success' ? CircleCheck : tone === 'danger' ? CircleX : tone === 'warning' ? TriangleAlert : Info;
  const border = { neutral: 'border-border', primary: 'border-primary/20', success: 'border-success/20', warning: 'border-warning/25', danger: 'border-danger/25' }[tone];
  return (
    <div className={cn('flex gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-[13px]', tones[tone], border)}>
      <Icon className="mt-0.5 h-[15px] w-[15px] shrink-0" />
      <div className="min-w-0 flex-1 text-pretty">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && 'mt-0.5', tone !== 'neutral' && 'text-fg/80')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

// Rounded icon square used by empty states, dialogs and list rows.
export function IconTile({ tone = 'neutral', size = 46, children, className }: { tone?: Tone; size?: number; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn('grid shrink-0 place-items-center [&>svg]:h-[45%] [&>svg]:w-[45%]', tones[tone], className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      {children}
    </div>
  );
}

export function EmptyState({ icon, title, children, action, tone = 'neutral' }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-12 text-center">
      {icon && (
        <div className={cn('mb-3.5 grid h-12 w-12 place-items-center rounded-[14px] [&>svg]:h-[22px] [&>svg]:w-[22px]', tones[tone])}>
          {icon}
        </div>
      )}
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      {children && <div className="mt-1 max-w-xs text-[13px] text-muted text-pretty">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-b-2 border-border-strong bg-surface px-[5px] font-mono text-[11px] leading-none font-medium text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// Initials on a soft tint of a color derived from the address.
export function Avatar({ name, address, size = 32 }: { name: string; address: string; size?: number }) {
  const col = `oklch(0.66 0.14 ${hue(address || name)})`;
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.36)),
        background: `color-mix(in oklch, ${col} 22%, var(--surface))`,
        color: `color-mix(in oklch, ${col} 75%, var(--text))`,
      }}
      aria-hidden
    >
      {initials(name || address)}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] font-medium transition-colors',
        done ? 'bg-success-soft text-success' : 'text-muted hover:bg-surface-2 hover:text-fg',
        className,
      )}
      onClick={async () => {
        await copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? 'Copied' : label}
    </button>
  );
}

export function Meter({ value, max, tone, className }: { value: number; max: number; tone?: Tone; className?: string }) {
  const p = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const t = tone ?? (p >= 90 ? 'danger' : p >= 80 ? 'warning' : 'primary');
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}>
      <div className={cn('h-full rounded-full transition-[width] duration-500', dots[t])} style={{ width: `${Math.max(p, value > 0 ? 1.5 : 0)}%` }} />
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('animate-pulse rounded bg-surface-3', className)} style={style} />;
}

export function Tabs<T extends string>({ value, onChange, tabs, children }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number; tone?: Tone }[]; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={cn(
            'flex h-[38px] items-center gap-1.5 px-3 text-[13px] font-medium transition-colors',
            value === t.value ? 'text-fg shadow-[inset_0_-2px_0_var(--primary)]' : 'text-muted hover:text-fg',
          )}
        >
          {t.label}
          {!!t.count && <span className={cn('grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[11px] font-semibold', tones[t.tone ?? 'neutral'])}>{t.count}</span>}
        </button>
      ))}
      {children && <div className="ml-auto flex items-center gap-2 pb-1.5">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl leading-tight font-semibold tracking-[-0.025em] text-fg">{title}</h1>
        {description && <p className="mt-1.5 max-w-[680px] text-[13.5px] text-muted text-pretty">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
