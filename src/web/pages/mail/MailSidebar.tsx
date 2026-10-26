import { useState } from 'react';
import { NavLink } from 'react-router';
import { AlarmClock, Archive, CalendarClock, ChevronDown, ChevronRight, FileText, Inbox, Layers, OctagonAlert, Send, Settings, SquarePen, Star, Trash2, UserCheck, UsersRound, X } from 'lucide-react';
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
  { view: 'spam', label: 'Spam', Icon: OctagonAlert },
  { view: 'trash', label: 'Trash', Icon: Trash2 },
];

const row = 'flex h-11 items-center gap-2.5 rounded-md px-2 text-[14.5px] transition-colors md:h-7 md:text-[13px]';

function Count({ n, strong, active }: { n?: number; strong?: boolean; active?: boolean }) {
  if (!n) return null;
  return <span className={cn('ml-auto text-xs tabular-nums', active ? 'font-semibold text-primary-text' : strong ? 'font-semibold text-fg' : 'text-faint')}>{n > 999 ? '999+' : n}</span>;
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

  const item = (mailbox: string, v: string, label: string, Icon: typeof Inbox, opts: { count?: number; strong?: boolean; indent?: boolean } = {}) => {
    const active = current === mailbox && view === v;
    const strong = opts.strong && !!opts.count;
    return (
      <NavLink
        key={`${mailbox}-${v}`}
        to={`/mail/${mailbox}/${v}`}
        onClick={onNavigate}
        className={cn(
          row,
          opts.indent && 'pl-7',
          active ? 'bg-primary-soft font-semibold text-primary-text' : strong ? 'font-semibold text-fg hover:bg-surface-2' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )}
      >
        <Icon className={cn('h-[18px] w-[18px] shrink-0 md:h-[15px] md:w-[15px]', active ? 'text-primary-text' : 'text-faint')} />
        <span className="truncate">{label}</span>
        <Count n={opts.count} strong={opts.strong} active={active} />
      </NavLink>
    );
  };

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
      <nav className="scroll-thin flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pt-1 pb-2">
        {multi && (
          <>
            <div className="mt-1 flex h-7 items-center px-2 text-[11.5px] font-medium text-faint">All inboxes</div>
            {item('all', 'inbox', 'Unified inbox', Layers, { count: totalUnread, strong: true })}
            {FOLDERS.slice(1).map((f) => item('all', f.view, f.label, f.Icon, { count: f.view === 'drafts' ? totalDrafts : undefined }))}
            <div className="mx-2 my-2 h-px bg-border" />
          </>
        )}
        {mailboxes.map((m) => {
          const key = String(m.id);
          const open = !collapsed[key] || !multi;
          const base = multi ? key : 'all';
          return (
            <div key={m.id} className="flex flex-col gap-px">
              {multi ? (
                <button type="button" onClick={() => toggle(key)} className="flex h-9 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12.5px] font-medium text-muted hover:text-fg md:h-7">
                  {open ? <ChevronDown className="h-3.5 w-3.5 text-faint" /> : <ChevronRight className="h-3.5 w-3.5 text-faint" />}
                  <span className="min-w-0 flex-1 truncate" title={m.address}>
                    {m.address}
                  </span>
                  {m.kind === 'shared' && <UsersRound className="h-[13px] w-[13px] shrink-0 text-faint" aria-label="Shared inbox" />}
                  {!open && <Count n={m.unread.inbox} strong />}
                </button>
              ) : (
                <div className="mt-1 flex h-7 items-center gap-1.5 truncate px-2 text-[11.5px] font-medium text-faint">
                  <span className="truncate">{m.address}</span>
                  {m.kind === 'shared' && <UsersRound className="h-3 w-3 shrink-0" aria-label="Shared inbox" />}
                </div>
              )}
              {open && (
                <>
                  {FOLDERS.map((f) =>
                    item(base, f.view, f.label, f.Icon, {
                      count: f.view === 'inbox' ? m.unread.inbox : f.view === 'spam' ? m.unread.spam : f.view === 'drafts' ? m.unread.drafts : undefined,
                      strong: f.view === 'inbox',
                      indent: multi,
                    }),
                  )}
                  {m.kind === 'shared' && item(base, 'assigned', 'Assigned to me', UserCheck, { indent: multi })}
                  {m.labels.length > 0 && (
                    <>
                      <div className={cn('mt-1.5 flex h-[26px] items-center text-[11.5px] font-medium text-faint', multi ? 'pl-7' : 'px-2')}>Labels</div>
                      {m.labels.map((l) => (
                        <NavLink
                          key={l.id}
                          to={`/mail/${base}/label-${l.id}`}
                          onClick={onNavigate}
                          className={cn(
                            row,
                            multi && 'pl-7',
                            current === base && view === `label-${l.id}` ? 'bg-primary-soft font-semibold text-primary-text' : 'text-muted hover:bg-surface-2 hover:text-fg',
                          )}
                        >
                          <span className="grid w-[18px] shrink-0 place-items-center md:w-[15px]">
                            <span className="h-2 w-2 rounded-full" style={labelDot(l.color)} />
                          </span>
                          <span className="truncate">{l.name}</span>
                        </NavLink>
                      ))}
                    </>
                  )}
                  {multi && <div className="h-2" />}
                </>
              )}
            </div>
          );
        })}
        {mailboxes.length === 0 && <div className="px-3 text-[13px] text-muted">You don't have access to any inbox yet. Ask an admin to add you to one.</div>}
      </nav>
      <div className="hidden border-t border-border p-2 md:block">
        <NavLink to="/settings/mailboxes" onClick={onNavigate} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg">
          <Settings className="h-[15px] w-[15px] text-faint" /> Signatures, filters &amp; more
        </NavLink>
      </div>
      <div className="flex items-center gap-2.5 border-t border-border px-3 pt-2.5 pb-[max(env(safe-area-inset-bottom),12px)] md:hidden">
        <Avatar name={user?.name ?? ''} address={user?.email ?? ''} size={32} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13.5px] font-semibold">{user?.name}</div>
          <div className="truncate text-xs text-muted">{user?.email}</div>
        </div>
        <NavLink to="/settings/mailboxes" onClick={onNavigate} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2" aria-label="Mail settings">
          <Settings className="h-[18px] w-[18px]" />
        </NavLink>
      </div>
    </div>
  );
}
