import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { get } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { cn } from '../../lib/utils';
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

export function RecipientInput({ label, value, onChange, autoFocus }: { label: string; value: Address[]; onChange: (v: Address[]) => void; autoFocus?: boolean }) {
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

  return (
    <div className="relative flex items-start gap-2 border-b border-border px-3 py-1.5">
      <span className="w-10 shrink-0 pt-1 text-[13px] text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" onClick={() => input.current?.focus()}>
        {value.map((a) => (
          <span
            key={a.address}
            title={a.address}
            className={cn('inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs', VALID.test(a.address) ? 'border-border bg-surface-2' : 'border-danger bg-danger-soft text-danger')}
          >
            <span className="truncate">{a.name || a.address}</span>
            <button type="button" className="text-faint hover:text-fg" onClick={() => onChange(value.filter((v) => v.address !== a.address))} aria-label={`Remove ${a.address}`}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
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
          onBlur={() => setTimeout(() => {
            if (text.trim()) commit(parseAddresses(text));
            setOpen(false);
          }, 150)}
          className="h-7 min-w-32 flex-1 bg-transparent text-sm outline-none"
          aria-label={label}
        />
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute top-full left-12 z-30 mt-1 w-80 rounded-lg border border-border bg-surface p-1 shadow-pop">
          {suggestions.map((s, i) => (
            <button
              key={s.address}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commit([s]);
              }}
              className={cn('flex w-full flex-col rounded-md px-2.5 py-1.5 text-left', i === active ? 'bg-surface-2' : '')}
            >
              <span className="text-[13px]">{s.name || s.address}</span>
              {s.name && <span className="text-xs text-muted">{s.address}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
