import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router';
import { AlarmClock, Archive, AtSign, CalendarClock, ChevronDown, FileText, Inbox, Layers, Mails, OctagonAlert, Send, Settings, SquarePen, Star, Trash2, UserCheck, UsersRound, X } from 'lucide-react';
import { cn, storageGet, storageSet } from '../../lib/utils';
import { useSession } from '../../lib/session';
import type { Mailbox } from '../../lib/types';
import { LogoMark } from '../../components/Logo';
import { Avatar } from '../../components/ui/misc';
import { labelDot } from './labels';

const FOLDERS = [
  { view: 'inbox', label: 'Inbox', Icon: Inbox },
  { view: 'starred', label: 'Starred', Icon: Star },
  { view: 'snoozed', label: 'Snoozed', Icon: AlarmClock },
  { view: 'sent', label: 'Sent', Icon: Send },
  { view: 'drafts', label: 'Drafts', Icon: FileText },
  { view: 'scheduled', label: 'Scheduled', Icon: CalendarClock },
  { view: 'archive', label: 'Archive', Icon: Archive },
  { view: 'allmail', label: 'All mail', Icon: Mails },
  { view: 'spam', label: 'Spam', Icon: OctagonAlert },
  { view: 'trash', label: 'Trash', Icon: Trash2 },
];

// shrink-0: the nav scrolls, and flex items would otherwise squash to their text height.
const row = 'flex h-11 shrink-0 items-center gap-2.5 rounded-md px-2 text-[14.5px] transition-colors md:h-7 md:text-[13px]';

function Count({ n, strong, active }: { n?: number; strong?: boolean; active?: boolean }) {
  if (!n) return null;
  return <span className={cn('ml-auto text-xs tabular-nums', active ? 'font-semibold text-primary-text' : strong ? 'font-semibold text-fg' : 'text-faint')}>{n > 999 ? '999+' : n}</span>;
}

// A collapsible section: one per inbox, plus "All inboxes" when there are several.
function Group({
  title,
  icon,
  tone = 'neutral',
  open,
  onToggle,
  unread,
  badge,
  children,
}: {
  title: string;
  icon: ReactNode;
  tone?: 'primary' | 'neutral';
  open: boolean;
  onToggle: () => void;
  unread?: number;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={title}
        className="group flex h-10 w-full shrink-0 items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-surface-2 md:h-8"
      >
        <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-[6px] [&>svg]:h-3 [&>svg]:w-3', tone === 'primary' ? 'bg-primary-soft text-primary-text' : 'bg-surface-3 text-muted')}>{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg md:text-[12.5px]">{title}</span>
        {badge}
        {!open && !!unread && (
          <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary-soft px-[5px] text-[11px] font-semibold text-primary-text tabular-nums">{unread > 999 ? '999+' : unread}</span>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform group-hover:text-muted', !open && '-rotate-90')} />
      </button>
      {open && <div className="mt-px mb-1.5 ml-[15px] flex flex-col gap-px border-l border-border pl-1.5">{children}</div>}
    </div>
  );
}

export function MailSidebar({
  mailboxes,
  current,
  view,
  onCompose,
  onNavigate,
  onClose,
}: {
  mailboxes: Mailbox[];
  current: string;
  view: string;
  onCompose: () => void;
  onNavigate?: () => void;
  onClose?: () => void;
}) {
  const { data: session } = useSession();
  const user = session?.user;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => storageGet('oi.sidebar', {}));
  const toggle = (k: string) => {
    const next = { ...collapsed, [k]: !collapsed[k] };
    setCollapsed(next);
    storageSet('oi.sidebar', next);
  };
  const totalUnread = mailboxes.reduce((n, m) => n + (m.unread.inbox ?? 0), 0);
  const totalDrafts = mailboxes.reduce((n, m) => n + (m.unread.drafts ?? 0), 0);
  const multi = mailboxes.length > 1;

  const item = (mailbox: string, v: string, label: string, Icon: typeof Inbox, opts: { count?: number; strong?: boolean } = {}) => {
    const active = current === mailbox && view === v;
    const strong = opts.strong && !!opts.count;
    return (
      <NavLink
        key={`${mailbox}-${v}`}
        to={`/mail/${mailbox}/${v}`}
        onClick={onNavigate}
        className={cn(row, active ? 'bg-primary-soft font-semibold text-primary-text' : strong ? 'font-semibold text-fg hover:bg-surface-2' : 'text-muted hover:bg-surface-2 hover:text-fg')}
      >
        <Icon className={cn('h-[18px] w-[18px] shrink-0 md:h-[15px] md:w-[15px]', active ? 'text-primary-text' : 'text-faint')} />
        <span className="truncate">{label}</span>
        <Count n={opts.count} strong={opts.strong} active={active} />
      </NavLink>
    );
  };

  // One inbox's folders and labels; `base` is its id in the URL ("all" when it's the only one).
  const folders = (m: Mailbox, base: string) => (
    <>
      {FOLDERS.map((f) =>
        item(base, f.view, f.label, f.Icon, {
          count: f.view === 'inbox' ? m.unread.inbox : f.view === 'spam' ? m.unread.spam : f.view === 'drafts' ? m.unread.drafts : undefined,
          strong: f.view === 'inbox',
        }),
      )}
      {m.kind === 'shared' && item(base, 'assigned', 'Assigned to me', UserCheck)}
      {m.labels.length > 0 && (
        <>
          <div className="mt-1.5 flex h-[26px] shrink-0 items-center px-2 text-[11.5px] font-medium text-faint">Labels</div>
          {m.labels.map((l) => (
            <NavLink
              key={l.id}
              to={`/mail/${base}/label-${l.id}`}
              onClick={onNavigate}
              className={cn(row, current === base && view === `label-${l.id}` ? 'bg-primary-soft font-semibold text-primary-text' : 'text-muted hover:bg-surface-2 hover:text-fg')}
            >
              <span className="grid w-[18px] shrink-0 place-items-center md:w-[15px]">
                <span className="h-2 w-2 rounded-full" style={labelDot(l.color)} />
              </span>
              <span className="truncate">{l.name}</span>
            </NavLink>
          ))}
        </>
      )}
    </>
  );

  return (
    <div className="flex h-full flex-col">
      {onClose && (
        <div className="flex items-center gap-2.5 px-4 pt-3 pb-2 md:hidden">
          <LogoMark size={24} />
          <span className="flex-1 truncate text-[15px] font-semibold">{session?.instanceName ?? 'OpenInbox'}</span>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2" aria-label="Close menu">
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
      )}
      <div className="px-3 pt-3 pb-1.5 max-md:pt-1.5">
        <button
          type="button"
          onClick={onCompose}
          className="flex h-11 w-full items-center gap-[9px] rounded-[10px] bg-primary pr-2.5 pl-3 text-[15px] font-medium text-primary-fg shadow-[var(--shadow),inset_0_1px_0_rgb(255_255_255/0.12)] transition-colors hover:bg-primary-hover md:h-[38px] md:rounded-[9px] md:text-sm"
        >
          <SquarePen className="h-4 w-4" />
          <span className="flex-1 text-left">Compose</span>
          <span className="hidden h-[18px] w-[18px] place-items-center rounded bg-white/15 font-mono text-[11px] leading-none font-medium md:grid">C</span>
        </button>
      </div>
      <nav className="scroll-thin flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pt-1 pb-2">
        {multi ? (
          <>
            <Group title="All inboxes" icon={<Layers />} tone="primary" open={!collapsed.all} onToggle={() => toggle('all')} unread={totalUnread}>
              {item('all', 'inbox', 'Unified inbox', Inbox, { count: totalUnread, strong: true })}
              {FOLDERS.slice(1).map((f) => item('all', f.view, f.label, f.Icon, { count: f.view === 'drafts' ? totalDrafts : undefined }))}
            </Group>
            {mailboxes.map((m) => {
              const key = String(m.id);
              return (
                <Group
                  key={m.id}
                  title={m.address}
                  icon={m.kind === 'shared' ? <UsersRound /> : <AtSign />}
                  open={!collapsed[key]}
                  onToggle={() => toggle(key)}
                  unread={m.unread.inbox}
                  badge={m.kind === 'shared' ? <span className="shrink-0 rounded-[5px] bg-surface-2 px-1.5 py-px text-[10.5px] font-medium text-faint">Shared</span> : undefined}
                >
                  {folders(m, key)}
                </Group>
              );
            })}
          </>
        ) : (
          mailboxes.map((m) => (
            <div key={m.id} className="flex shrink-0 flex-col gap-px">
              <div className="mt-1 flex h-7 shrink-0 items-center gap-1.5 truncate px-2 text-[11.5px] font-medium text-faint">
                <span className="truncate">{m.address}</span>
                {m.kind === 'shared' && <UsersRound className="h-3 w-3 shrink-0" aria-label="Shared inbox" />}
              </div>
              {folders(m, 'all')}
            </div>
          ))
        )}
        {mailboxes.length === 0 && <div className="px-3 text-[13px] text-muted">You don't have access to any inbox yet. Ask an admin to add you to one.</div>}
      </nav>
      <div className="hidden border-t border-border p-2 md:block">
        <NavLink to="/settings" onClick={onNavigate} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
          <Settings className="h-[15px] w-[15px] text-faint" /> Settings
        </NavLink>
      </div>
      <div className="flex items-center gap-2.5 border-t border-border px-3 pt-2.5 pb-[max(env(safe-area-inset-bottom),12px)] md:hidden">
        <Avatar name={user?.name ?? ''} address={user?.email ?? ''} size={32} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13.5px] font-semibold">{user?.name}</div>
          <div className="truncate text-xs text-muted">{user?.email}</div>
        </div>
        <NavLink to="/settings" onClick={onNavigate} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2" aria-label="Settings">
          <Settings className="h-[18px] w-[18px]" />
        </NavLink>
      </div>
    </div>
  );
}
