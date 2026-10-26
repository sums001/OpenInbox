import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CircleAlert, CornerDownLeft, X } from 'lucide-react';
import { get } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { Avatar } from '../../components/ui/misc';
import type { Address } from '../../lib/types';

const VALID = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

export function parseAddresses(text: string): Address[] {
  const out: Address[] = [];
  for (const part of text.split(/[,;\n]+/)) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(.*)<([^>]+)>$/.exec(t);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim().toLowerCase() });
    else out.push({ name: '', address: t.toLowerCase() });
  }
  return out;
}

// `bare` drops the label and row border (the inline reply header has its own); `trailing` sits at
// the end of the row (the Cc Bcc toggle).
export function RecipientInput({
  label,
  value,
  onChange,
  autoFocus,
  bare,
  trailing,
}: {
  label: string;
  value: Address[];
  onChange: (v: Address[]) => void;
  autoFocus?: boolean;
  bare?: boolean;
  trailing?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [suggestions, setSuggestions] = useState<Address[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const q = useDebounced(text.trim(), 150);

  useEffect(() => {
    if (q.length < 1) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    get<{ address: string; name: string }[]>(`/contacts?q=${encodeURIComponent(q)}`)
      .then((r) => {
        if (!cancelled) {
          setSuggestions(r.filter((s) => !value.some((v) => v.address === s.address)));
          setActive(0);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [q, value]);

  const commit = (list: Address[]) => {
    const fresh = list.filter((a) => a.address && !value.some((v) => v.address === a.address));
    if (fresh.length) onChange([...value, ...fresh]);
    setText('');
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (open && suggestions[active] && e.key !== ',') {
        e.preventDefault();
        commit([suggestions[active]]);
        return;
      }
      if (text.trim()) {
        e.preventDefault();
        commit(parseAddresses(text));
      }
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
    if (e.key === 'Escape') setOpen(false);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const t = e.clipboardData.getData('text');
    if (/[,;\n]/.test(t)) {
      e.preventDefault();
      commit(parseAddresses(t));
    }
  };

  // Bold the part of a suggestion that matches what was typed.
  const mark = (s: string) => {
    const i = q ? s.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) return s;
    return (
      <>
        {s.slice(0, i)}
        <b className="font-bold">{s.slice(i, i + q.length)}</b>
        {s.slice(i + q.length)}
      </>
    );
  };

  return (
    <div className={cn('relative flex min-w-0 flex-1 items-start gap-2.5 text-[13px]', !bare && 'border-b border-border px-4')}>
      {!bare && <span className="w-11 shrink-0 pt-[11px] text-faint">{label}</span>}
      <div className="flex min-h-[42px] min-w-0 flex-1 flex-wrap items-center gap-1.5 py-[7px]" onClick={() => input.current?.focus()}>
        {value.map((a) =>
          VALID.test(a.address) ? (
            <span key={a.address} title={a.address} className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 pr-1.5 pl-[3px] text-[12.5px]">
              <Avatar name={a.name} address={a.address} size={18} />
              <span className="truncate">{a.name || a.address}</span>
              <button type="button" className="text-faint hover:text-fg" onClick={() => onChange(value.filter((v) => v.address !== a.address))} aria-label={`Remove ${a.address}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <span
              key={a.address}
              title="Not a valid address"
              className="inline-flex h-6 max-w-full items-center gap-[5px] rounded-full border border-dashed border-[color-mix(in_oklch,var(--danger)_55%,transparent)] bg-danger-soft pr-1.5 pl-[7px] text-[12.5px] text-danger"
            >
              <CircleAlert className="h-3 w-3 shrink-0" />
              <span className="truncate">{a.address}</span>
              <button type="button" className="opacity-70 hover:opacity-100" onClick={() => onChange(value.filter((v) => v.address !== a.address))} aria-label={`Remove ${a.address}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ),
        )}
        <input
          ref={input}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKey}
          onPaste={onPaste}
          onBlur={() =>
            setTimeout(() => {
              if (text.trim()) commit(parseAddresses(text));
              setOpen(false);
            }, 150)
          }
          className="h-6 min-w-28 flex-1 bg-transparent outline-none"
          aria-label={label}
        />
      </div>
      {trailing && <div className="pt-3">{trailing}</div>}
      {open && suggestions.length > 0 && (
        <div className={cn('absolute top-full z-30 -mt-0.5 w-[300px] max-w-[calc(100vw-2rem)] rounded-[10px] border border-border bg-surface p-[5px] shadow-pop', bare ? 'left-0' : 'left-[66px]')}>
          {suggestions.map((s, i) => (
            <button
              key={s.address}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commit([s]);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex h-[42px] w-full items-center gap-2.5 rounded-[7px] px-2 text-left', i === active && 'bg-surface-2')}
            >
              <Avatar name={s.name} address={s.address} size={26} />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate font-medium">{mark(s.name || s.address)}</span>
                {s.name && <span className="truncate text-xs text-faint">{mark(s.address)}</span>}
              </span>
              {i === active && <CornerDownLeft className="h-[13px] w-[13px] shrink-0 text-faint" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
