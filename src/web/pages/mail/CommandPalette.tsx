import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Command, CornerDownLeft, Search } from 'lucide-react';
import { useIsAdmin } from '../../lib/session';
import { cn } from '../../lib/utils';
import type { Mailbox } from '../../lib/types';
import { Kbd } from '../../components/ui/misc';

interface Item {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ open, onClose, mailboxes, onCompose, onSearch }: { open: boolean; onClose: () => void; mailboxes: Mailbox[]; onCompose: () => void; onSearch: (q: string) => void }) {
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => navigate(to);
    const list: Item[] = [
      { id: 'compose', label: 'Compose a new message', group: 'Actions', hint: 'C', run: onCompose },
      ...['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'scheduled', 'archive', 'spam', 'trash'].map((v) => ({ id: `go-${v}`, label: `Go to ${v[0].toUpperCase()}${v.slice(1)}`, group: 'Navigate', run: go(`/mail/all/${v}`) })),
      ...mailboxes.map((m) => ({ id: `mb-${m.id}`, label: `Open ${m.address}`, group: 'Inboxes', run: go(`/mail/${mailboxes.length > 1 ? m.id : 'all'}/inbox`) })),
      ...mailboxes.flatMap((m) => m.labels.map((l) => ({ id: `lb-${l.id}`, label: `Label: ${l.name}`, group: 'Labels', hint: mailboxes.length > 1 ? m.address : undefined, run: go(`/mail/${mailboxes.length > 1 ? m.id : 'all'}/label-${l.id}`) }))),
      { id: 'settings-mail', label: 'Mail settings (signatures, filters, auto-reply)', group: 'Settings', run: go('/settings/mailboxes') },
      { id: 'settings-account', label: 'Account (password, two-factor, sessions)', group: 'Settings', run: go('/settings/account') },
    ];
    if (isAdmin) {
      for (const [path, label] of [
        ['', 'Admin dashboard'],
        ['/inboxes', 'Manage inboxes'],
        ['/users', 'Manage users'],
        ['/domains', 'Manage domains'],
        ['/integrations', 'Sending providers and integrations'],
        ['/mailflow', 'Mail flow log'],
        ['/settings', 'Instance settings'],
      ])
        list.push({ id: `admin${path}`, label, group: 'Admin', run: go(`/admin${path}`) });
    }
    return list;
  }, [mailboxes, isAdmin, navigate, onCompose]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const base = term ? items.filter((i) => i.label.toLowerCase().includes(term) || i.group.toLowerCase().includes(term)) : items;
    return term ? [{ id: 'search', label: `Search mail for “${q.trim()}”`, group: 'Search', run: () => onSearch(q.trim()) }, ...base] : base;
  }, [items, q, onSearch]);

  if (!open) return null;
  const choose = (i: Item) => {
    onClose();
    i.run();
  };
  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh] animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface shadow-pop animate-slide-up">
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 text-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && filtered[active]) choose(filtered[active]);
              else if (e.key === 'Escape') onClose();
            }}
            placeholder="Type a command or search…"
            className="h-12 flex-1 bg-transparent text-sm outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="scroll-thin max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.map((i, idx) => {
            const header = i.group !== lastGroup ? i.group : null;
            lastGroup = i.group;
            return (
              <div key={i.id}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{header}</div>}
                <button
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => choose(i)}
                  className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]', idx === active ? 'bg-primary-soft text-primary' : 'text-fg')}
                >
                  <span className="flex-1 truncate">{i.label}</span>
                  {i.hint && <span className="text-xs text-faint">{i.hint}</span>}
                  {idx === active && <CornerDownLeft className="h-3.5 w-3.5" />}
                </button>
              </div>
            );
          })}
          {!filtered.length && <div className="px-3 py-6 text-center text-[13px] text-muted">No matching commands.</div>}
        </div>
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-faint">
          <Command className="h-3 w-3" /> <span>Ctrl/⌘ K opens this anywhere in Mail</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const SHORTCUTS: [string, string][] = [
  ['c', 'Compose'],
  ['/', 'Search'],
  ['Ctrl/⌘ K', 'Command palette'],
  ['j / k', 'Next / previous conversation'],
  ['o or Enter', 'Open conversation'],
  ['u or Esc', 'Back to the list'],
  ['e', 'Archive'],
  ['#', 'Move to Trash'],
  ['!', 'Report spam'],
  ['s', 'Star / unstar'],
  ['x', 'Select'],
  ['Shift+I / Shift+U', 'Mark read / unread'],
  ['r / a / f', 'Reply / reply all / forward'],
  ['g then i, s, d, a, t', 'Go to Inbox, Sent, Drafts, Archive, Trash'],
  ['Ctrl/⌘ Enter', 'Send (in the composer)'],
  ['?', 'This help'],
];
