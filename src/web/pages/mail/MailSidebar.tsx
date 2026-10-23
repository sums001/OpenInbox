import { useState } from 'react';
import { NavLink } from 'react-router';
import { AlarmClock, Archive, CalendarClock, ChevronDown, FileText, Inbox, Send, Settings, ShieldAlert, SquarePen, Star, Trash, UserRound, Layers } from 'lucide-react';
import { cn, storageGet, storageSet } from '../../lib/utils';
import type { Mailbox } from '../../lib/types';
import { Button } from '../../components/ui/button';
import { LABEL_DOT } from './labels';

const FOLDERS = [
  { view: 'inbox', label: 'Inbox', Icon: Inbox },
  { view: 'starred', label: 'Starred', Icon: Star },
  { view: 'snoozed', label: 'Snoozed', Icon: AlarmClock },
  { view: 'sent', label: 'Sent', Icon: Send },
  { view: 'drafts', label: 'Drafts', Icon: FileText },
  { view: 'scheduled', label: 'Scheduled', Icon: CalendarClock },
  { view: 'archive', label: 'Archive', Icon: Archive },
  { view: 'spam', label: 'Spam', Icon: ShieldAlert },
  { view: 'trash', label: 'Trash', Icon: Trash },
];

function Count({ n, strong }: { n?: number; strong?: boolean }) {
  if (!n) return null;
  return <span className={cn('ml-auto text-xs tabular-nums', strong ? 'font-semibold text-fg' : 'text-muted')}>{n > 999 ? '999+' : n}</span>;
}

export function MailSidebar({ mailboxes, current, view, onCompose, onNavigate }: { mailboxes: Mailbox[]; current: string; view: string; onCompose: () => void; onNavigate?: () => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => storageGet('oi.sidebar', {}));
  const toggle = (k: string) => {
    const next = { ...collapsed, [k]: !collapsed[k] };
    setCollapsed(next);
    storageSet('oi.sidebar', next);
  };
  const totalUnread = mailboxes.reduce((n, m) => n + (m.unread.inbox ?? 0), 0);
  const totalDrafts = mailboxes.reduce((n, m) => n + (m.unread.drafts ?? 0), 0);
  const multi = mailboxes.length > 1;

  const item = (mailbox: string, v: string, label: string, Icon: typeof Inbox, count?: number, strong?: boolean) => (
    <NavLink
      key={`${mailbox}-${v}`}
      to={`/mail/${mailbox}/${v}`}
      onClick={onNavigate}
      className={() =>
        cn(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors',
          current === mailbox && view === v ? 'bg-primary-soft font-medium text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
      <Count n={count} strong={strong} />
    </NavLink>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <Button variant="primary" className="w-full justify-center" size="lg" icon={<SquarePen className="h-4 w-4" />} onClick={onCompose}>
          Compose
        </Button>
      </div>
      <nav className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-4">
        {multi && (
          <div className="space-y-0.5">
            <div className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">All inboxes</div>
            {item('all', 'inbox', 'Unified inbox', Layers, totalUnread, true)}
            {FOLDERS.slice(1).map((f) => item('all', f.view, f.label, f.Icon, f.view === 'drafts' ? totalDrafts : undefined))}
          </div>
        )}
        {mailboxes.map((m) => {
          const key = String(m.id);
          const open = !collapsed[key] || !multi;
          const base = multi ? key : 'all';
          return (
            <div key={m.id} className="space-y-0.5">
              {multi ? (
                <button type="button" onClick={() => toggle(key)} className="flex w-full items-center gap-1.5 px-2.5 pb-1 text-left">
                  <ChevronDown className={cn('h-3.5 w-3.5 text-faint transition-transform', !open && '-rotate-90')} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted" title={m.address}>
                    {m.address}
                  </span>
                  {!open && <Count n={m.unread.inbox} strong />}
                </button>
              ) : (
                <div className="truncate px-2.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{m.address}</div>
              )}
              {open && (
                <>
                  {FOLDERS.map((f) =>
                    item(base, f.view, f.label, f.Icon, f.view === 'inbox' ? m.unread.inbox : f.view === 'spam' ? m.unread.spam : f.view === 'drafts' ? m.unread.drafts : undefined, f.view === 'inbox'),
                  )}
                  {m.kind === 'shared' && item(base, 'assigned', 'Assigned to me', UserRound)}
                  {m.labels.length > 0 && (
                    <div className="pt-1">
                      {m.labels.map((l) => (
                        <NavLink
                          key={l.id}
                          to={`/mail/${base}/label-${l.id}`}
                          onClick={onNavigate}
                          className={() =>
                            cn(
                              'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors',
                              view === `label-${l.id}` ? 'bg-primary-soft font-medium text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg',
                            )
                          }
                        >
                          <span className={cn('ml-1 h-2.5 w-2.5 rounded-full', LABEL_DOT[l.color] ?? 'bg-faint')} />
                          <span className="truncate">{l.name}</span>
                        </NavLink>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
        {mailboxes.length === 0 && <div className="px-3 text-[13px] text-muted">You don't have access to any inbox yet. Ask an admin to add you to one.</div>}
      </nav>
      <div className="border-t border-border p-2">
        <NavLink to="/settings/mailboxes" onClick={onNavigate} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
          <Settings className="h-4 w-4" /> Signatures, filters & more
        </NavLink>
      </div>
    </div>
  );
}
