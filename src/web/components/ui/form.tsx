import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Check, Eye, EyeOff, Minus } from 'lucide-react';
import { cn } from '../../lib/utils';

const control =
  'w-full rounded-lg border border-border bg-surface px-3 text-[13px] text-fg placeholder:text-faint transition-colors focus:border-primary focus:outline-none focus:ring-3 focus:ring-[var(--ring)] disabled:opacity-60 disabled:bg-surface-2';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(control, 'h-9', className)} {...rest} />;
});

export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function PasswordInput({ className, ...rest }, ref) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input ref={ref} type={show ? 'text' : 'password'} className={cn(control, 'h-9 pr-9', className)} {...rest} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-faint hover:text-fg"
        aria-label={show ? 'Hide' : 'Show'}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-24 py-2', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(control, 'select-chevron h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({
  label,
  hint,
  error,
  children,
  className,
  id,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={id} className="block text-[12.5px] font-medium text-fg">
          {label}
        </label>
      )}
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-muted text-pretty">{hint}</p> : null}
    </div>
  );
}

// A local part with its domain picker attached: support @ acme.com.
export function AddressInput({
  id,
  local,
  onLocal,
  domainId,
  onDomain,
  domains,
  placeholder,
  autoFocus,
}: {
  id?: string;
  local: string;
  onLocal: (v: string) => void;
  domainId: number | undefined;
  onDomain: (id: number) => void;
  domains: { id: number; name: string }[];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex h-9 overflow-hidden rounded-lg border border-border bg-surface text-[13px] transition-colors focus-within:border-primary focus-within:ring-3 focus-within:ring-[var(--ring)]">
      <input id={id} value={local} onChange={(e) => onLocal(e.target.value.trim())} placeholder={placeholder} autoFocus={autoFocus} className="min-w-0 flex-1 bg-transparent px-3 outline-none placeholder:text-faint" />
      <select
        value={domainId ?? ''}
        onChange={(e) => onDomain(Number(e.target.value))}
        aria-label="Domain"
        className="select-chevron max-w-[55%] border-l border-border bg-surface-2 pr-8 pl-2.5 text-muted outline-none"
      >
        {domains.map((d) => (
          <option key={d.id} value={d.id}>
            @{d.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// One of a few options, as selectable cards with a radio dot.
export function ChoiceCards<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: ReactNode }[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn('flex gap-2.5 rounded-[10px] border px-3.5 py-3 text-left transition-colors', on ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2')}
          >
            <span className={cn('mt-0.5 h-4 w-4 shrink-0 rounded-full', on ? 'border-[5px] border-primary' : 'border-[1.5px] border-border-strong')} />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{o.label}</span>
              {o.hint && <span className="block text-xs text-muted text-pretty">{o.hint}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Compact checkbox for lists and tables (selection, membership).
export function Tick({
  checked,
  indeterminate,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (v: boolean) => void;
  label: string;
  className?: string;
}) {
  const on = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        'grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[4px] border-[1.5px] text-primary-fg transition-colors',
        on ? 'border-primary bg-primary' : 'border-border-strong bg-surface hover:border-faint',
        className,
      )}
    >
      {indeterminate ? <Minus className="h-[11px] w-[11px]" strokeWidth={3} /> : checked ? <Check className="h-[11px] w-[11px]" strokeWidth={3} /> : null}
    </button>
  );
}

export function Checkbox({ label, hint, checked, onChange, disabled }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('flex items-start gap-2.5 cursor-pointer select-none', disabled && 'opacity-60 cursor-not-allowed')}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-border-strong accent-[var(--primary)]"
      />
      <span className="text-sm">
        <span className="text-fg">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-surface-3 border border-border',
      )}
    >
      <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}

// `count` shows as a small number after the label, as in filter tabs.
export function SegmentedControl<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex shrink-0 items-center rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors',
              on ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
            )}
          >
            {o.label}
            {o.count !== undefined && <span className={cn('text-xs tabular-nums', on ? 'text-muted' : 'text-faint')}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
