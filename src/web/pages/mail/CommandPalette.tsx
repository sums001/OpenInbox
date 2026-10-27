import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import {
  Activity,
  AlarmClock,
  Archive,
  ArrowDown,
  ArrowUp,
  AtSign,
  CalendarClock,
  CornerDownLeft,
  FileText,
  Globe,
  Inbox,
  LayoutGrid,
  Mails,
  OctagonAlert,
  Plug,
  Search,
  Send,
  Settings,
  SquarePen,
  Star,
  Trash2,
  UserRound,
  UsersRound,
  Waypoints,
} from 'lucide-react';
import { useIsAdmin } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Kbd } from '../../components/ui/misc';
import { useMailboxes } from './data';
import { labelDot } from './labels';

interface Item {
  id: string;
  label: string;
  group: string;
  icon: ReactNode;
  keys?: string[];
  run: () => void;
}

const FOLDER_ITEMS: [string, string, ReactNode, string[]?][] = [
  ['inbox', 'Inbox', <Inbox />, ['G', 'I']],
  ['starred', 'Starred', <Star />],
  ['snoozed', 'Snoozed', <AlarmClock />, ['G', 'Z']],
  ['sent', 'Sent', <Send />, ['G', 'S']],
  ['drafts', 'Drafts', <FileText />, ['G', 'D']],
  ['scheduled', 'Scheduled', <CalendarClock />],
  ['archive', 'Archive', <Archive />, ['G', 'A']],
  ['allmail', 'All mail', <Mails />],
  ['spam', 'Spam', <OctagonAlert />, ['G', 'P']],
  ['trash', 'Trash', <Trash2 />, ['G', 'T']],
];

// Ctrl/⌘ K anywhere in the app. Mail actions are handed to the mail page through window events,
// or open the mail page when it isn't showing.
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = useIsAdmin();
  const { data: mailboxes = [] } = useMailboxes();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const inMail = location.pathname.startsWith('/mail');
  const currentBox = /^\/mail\/([^/]+)/.exec(location.pathname)?.[1] ?? 'all';

  useEffect(() => {
    setTimeout(() => input.current?.focus(), 0);
  }, []);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => navigate(to);
    const mailEvent = (name: string, fallback: string) => () => (inMail ? window.dispatchEvent(new CustomEvent(name)) : navigate(fallback));
    const multi = mailboxes.length > 1;
    const out: Item[] = [
      { id: 'compose', label: 'Compose', group: 'Actions', icon: <SquarePen />, keys: ['C'], run: mailEvent('oi:compose', '/mail/all/inbox?compose') },
      { id: 'search', label: 'Search mail', group: 'Actions', icon: <Search />, keys: ['/'], run: mailEvent('oi:search', '/mail/all/inbox') },
      ...FOLDER_ITEMS.map(([v, label, icon, keys]) => ({ id: `go-${v}`, label, group: 'Go to', icon, keys, run: go(`/mail/${inMail ? currentBox : 'all'}/${v}`) })),
      ...(multi ? mailboxes.map((m) => ({ id: `mb-${m.id}`, label: m.address, group: 'Switch inbox', icon: m.kind === 'shared' ? <UsersRound /> : <AtSign />, run: go(`/mail/${m.id}/inbox`) })) : []),
      ...mailboxes.flatMap((m) =>
        m.labels.map((l) => ({
          id: `lb-${l.id}`,
          label: multi ? `${l.name} · ${m.address}` : l.name,
          group: 'Labels',
          icon: <span className="mx-[3px] block h-2 w-2 rounded-full" style={labelDot(l.color)} />,
          run: go(`/mail/${multi ? m.id : 'all'}/label-${l.id}`),
        })),
      ),
      { id: 'settings-mail', label: 'Mail settings', group: 'Settings', icon: <Settings />, run: go('/settings/signature') },
      { id: 'settings-account', label: 'Account', group: 'Settings', icon: <UserRound />, run: go('/settings/profile') },
    ];
    if (isAdmin) {
      const admin: [string, string, ReactNode][] = [
        ['', 'Admin dashboard', <LayoutGrid />],
        ['/inboxes', 'Manage inboxes', <Inbox />],
        ['/users', 'Manage users', <UsersRound />],
        ['/domains', 'Manage domains', <Globe />],
        ['/integrations', 'Sending providers and integrations', <Plug />],
        ['/mailflow', 'Mail flow log', <Waypoints />],
        ['/activity', 'Activity log', <Activity />],
        ['/settings', 'Instance settings', <Settings />],
      ];
      for (const [path, label, icon] of admin) out.push({ id: `admin${path}`, label, group: 'Admin', icon, run: go(`/admin${path}`) });
    }
    return out;
  }, [mailboxes, isAdmin, navigate, inMail, currentBox]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    const base = items.filter((i) => i.label.toLowerCase().includes(term) || i.group.toLowerCase().includes(term));
    const search: Item = { id: 'search-q', label: `Search mail for “${q.trim()}”`, group: 'Search', icon: <Search />, run: () => navigate(`/mail/${inMail ? currentBox : 'all'}/search?q=${encodeURIComponent(q.trim())}`) };
    return [search, ...base];
  }, [items, q, navigate, inMail, currentBox]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (i: Item) => {
    onClose();
    i.run();
  };
  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim p-4 pt-[12vh] animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-[620px] overflow-hidden rounded-[14px] border border-border bg-surface shadow-pop animate-pop-in">
        <div className="flex h-[54px] items-center gap-3 border-b border-border px-[18px]">
          <Search className="h-[17px] w-[17px] text-faint" />
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
            className="h-full flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={list} className="scroll-thin max-h-[52vh] overflow-y-auto px-2 pt-1.5 pb-2">
          {filtered.map((i, idx) => {
            const header = i.group !== lastGroup ? i.group : null;
            lastGroup = i.group;
            const on = idx === active;
            return (
              <Fragment key={i.id}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-faint">{header}</div>}
                <button
                  type="button"
                  data-index={idx}
                  onMouseMove={() => setActive(idx)}
                  onClick={() => choose(i)}
                  className={cn('flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13.5px]', on ? 'bg-primary-soft text-primary-text' : 'text-fg')}
                >
                  <span className={cn('flex [&>svg]:h-4 [&>svg]:w-4', on ? 'text-primary-text' : 'text-faint')}>{i.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{i.label}</span>
                  {i.keys && (
                    <span className="flex gap-1">
                      {i.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
          {!filtered.length && <div className="px-3 py-6 text-center text-[13px] text-muted">No matching commands.</div>}
        </div>
        <div className="flex h-10 items-center gap-4 border-t border-border bg-surface-2 px-[18px] text-xs text-faint">
          <span className="flex items-center gap-1">
            <ArrowUp className="h-3 w-3" />
            <ArrowDown className="h-3 w-3" />
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <CornerDownLeft className="h-3 w-3" />
            Select
          </span>
          <span className="ml-auto hidden sm:inline">Ctrl/⌘ K opens this anywhere</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Keys, with "or", "then" and "/" shown as words between them.
export const SHORTCUTS: [string[], string][] = [
  [['c'], 'Compose'],
  [['/'], 'Search'],
  [['Ctrl/⌘ K'], 'Command palette'],
  [['j', '/', 'k'], 'Next / previous conversation'],
  [['o', 'or', 'Enter'], 'Open conversation'],
  [['u', 'or', 'Esc'], 'Back to the list'],
  [['e'], 'Archive'],
  [['#'], 'Move to Trash'],
  [['!'], 'Report spam'],
  [['s'], 'Star / unstar'],
  [['x'], 'Select'],
  [['Shift+I', '/', 'Shift+U'], 'Mark read / unread'],
  [['r', '/', 'a', '/', 'f'], 'Reply / reply all / forward'],
  [['g', 'then', 'i', 's', 'd', 'a', 't'], 'Go to Inbox, Sent, Drafts, Archive, Trash'],
  [['Ctrl/⌘ Enter'], 'Send (in the composer)'],
  [['?'], 'This help'],
];

export function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k, i) =>
        keys.length > 1 && (k === 'or' || k === 'then' || k === '/') ? (
          <span key={i} className="px-px text-[11.5px] text-faint">
            {k}
          </span>
        ) : (
          <Kbd key={i} className="h-5 min-w-5 rounded-[5px] px-1.5 text-[11.5px] text-fg">
            {k}
          </Kbd>
        ),
      )}
    </span>
  );
}
