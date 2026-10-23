import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlarmClock,
  Archive,
  CircleCheck,
  Inbox,
  MailOpen,
  Mail,
  Menu as MenuIcon,
  Paperclip,
  RefreshCw,
  Search,
  ShieldAlert,
  SquarePen,
  Star,
  Trash,
  X,
} from 'lucide-react';
import { listDate } from '../../lib/format';
import { ownAddresses, participantLabel, snoozePresets, VIEW_LABELS } from '../../lib/mail';
import { cn } from '../../lib/utils';
import type { Mailbox, ThreadSummary } from '../../lib/types';
import { IconButton } from '../../components/ui/button';
import { EmptyState, Skeleton } from '../../components/ui/misc';
import { Menu, MenuItem, MenuLabel, useToast } from '../../components/ui/overlay';
import { LABEL_CHIP } from './labels';
import { useThreadActions, useThreads, type Action } from './data';

export function ThreadList({
  mailbox,
  view,
  query,
  mailboxes,
  activeId,
  focusIndex,
  setFocusIndex,
  selected,
  setSelected,
  onOpen,
  onSearch,
  onMenu,
  onCompose,
  searchRef,
}: {
  mailbox: string;
  view: string;
  query: string;
  mailboxes: Mailbox[];
  activeId: number | null;
  focusIndex: number;
  setFocusIndex: (i: number) => void;
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  onOpen: (t: ThreadSummary) => void;
  onSearch: (q: string) => void;
  onMenu: () => void;
  onCompose: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const q = useThreads(mailbox, view, query);
  const act = useThreadActions();
  const toast = useToast();
  const [search, setSearch] = useState(query);
  const list = useMemo(() => q.data?.pages.flatMap((p) => p.threads) ?? [], [q.data]);
  const own = useMemo(() => ownAddresses(mailboxes), [mailboxes]);
  const labelsById = useMemo(() => new Map(mailboxes.flatMap((m) => m.labels.map((l) => [l.id, l] as const))), [mailboxes]);
  const sentinel = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => setSearch(query), [query]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [q]);

  // Keep the keyboard focus visible.
  useEffect(() => {
    container.current?.querySelector(`[data-index="${focusIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex]);

  const ids = [...selected];
  const bulk = (action: Action, opts: Parameters<typeof act>[2] = {}, label?: string) => {
    if (!ids.length) return;
    act(ids, action, opts)
      .then(() => label && toast.success(label))
      .catch(() => toast.error('Something went wrong.'));
    setSelected(new Set());
  };
  const allSelected = list.length > 0 && list.every((t) => selected.has(t.id));
  const title = view.startsWith('label-') ? (labelsById.get(Number(view.slice(6)))?.name ?? 'Label') : VIEW_LABELS[view] ?? view;
  const mailboxName = mailbox === 'all' ? (mailboxes.length > 1 ? 'All inboxes' : '') : (mailboxes.find((m) => String(m.id) === mailbox)?.address ?? '');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border bg-surface px-3 pt-2.5 pb-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSearch(search);
          }}
          className="flex items-center gap-2"
        >
          <IconButton label="Menu" className="md:hidden" onClick={onMenu} icon={<MenuIcon className="h-4 w-4" />} />
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search mail"
              title="Search. Try from:ann, subject:invoice, has:attachment, is:unread, in:anywhere, before:2026-01-31"
              className="h-9 w-full rounded-lg border border-border bg-surface-2 pr-8 pl-8 text-sm outline-none focus:border-primary focus:bg-surface"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearch('');
                  (e.target as HTMLInputElement).blur();
                  if (query) onSearch('');
                }
              }}
            />
            {search && (
              <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-fg" onClick={() => { setSearch(''); onSearch(''); }} aria-label="Clear search">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <IconButton label="Compose (c)" className="md:hidden" onClick={onCompose} icon={<SquarePen className="h-4 w-4" />} />
        </form>
        <div className="mt-2 flex min-h-8 items-center gap-1">
          <input
            type="checkbox"
            aria-label="Select all"
            checked={allSelected}
            onChange={(e) => setSelected(e.target.checked ? new Set(list.map((t) => t.id)) : new Set())}
            className="mx-1.5 h-4 w-4 accent-[var(--primary)]"
          />
          {ids.length ? (
            <>
              <span className="mr-1 text-xs text-muted">{ids.length} selected</span>
              <IconButton label="Archive" onClick={() => bulk('archive', {}, 'Archived')} icon={<Archive className="h-4 w-4" />} />
              <IconButton label="Delete" onClick={() => bulk(view === 'trash' ? 'delete' : 'trash', {}, view === 'trash' ? 'Deleted forever' : 'Moved to Trash')} icon={<Trash className="h-4 w-4" />} />
              <IconButton label="Spam" onClick={() => bulk('spam', {}, 'Marked as spam')} icon={<ShieldAlert className="h-4 w-4" />} />
              <IconButton label="Mark read" onClick={() => bulk('read')} icon={<MailOpen className="h-4 w-4" />} />
              <IconButton label="Mark unread" onClick={() => bulk('unread')} icon={<Mail className="h-4 w-4" />} />
              {view !== 'inbox' && <IconButton label="Move to Inbox" onClick={() => bulk('inbox', {}, 'Moved to Inbox')} icon={<Inbox className="h-4 w-4" />} />}
              <Menu align="start" trigger={({ onClick }) => <IconButton label="Snooze" onClick={onClick} icon={<AlarmClock className="h-4 w-4" />} />}>
                <MenuLabel>Snooze until…</MenuLabel>
                {snoozePresets().map((p) => (
                  <MenuItem key={p.label} onClick={() => bulk('snooze', { until: p.at }, 'Snoozed')}>
                    {p.label}
                  </MenuItem>
                ))}
              </Menu>
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1 truncate text-[13px]">
                <span className="font-semibold">{view === 'search' ? `Results for “${query}”` : title}</span>
                {mailboxName && <span className="ml-1.5 text-muted">· {mailboxName}</span>}
              </div>
              <IconButton label="Refresh" onClick={() => q.refetch()} icon={<RefreshCw className={cn('h-4 w-4', q.isFetching && 'animate-spin')} />} />
              {view === 'spam' || view === 'trash' ? (
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-danger"
                  onClick={() => list.length && window.confirm(`Delete all ${list.length} conversations here forever?`) && act(list.map((t) => t.id), 'delete').then(() => toast.success('Emptied'))}
                >
                  Empty {view}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div ref={container} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {q.isLoading ? (
          <div className="space-y-px">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="space-y-2 px-4 py-3">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={view === 'inbox' ? <CircleCheck className="h-5 w-5" /> : <Inbox className="h-5 w-5" />} title={view === 'search' ? 'No results' : view === 'inbox' ? 'Inbox zero' : 'Nothing here'}>
            {view === 'search' ? 'Try fewer words, or operators like from:, to:, subject:, has:attachment, in:anywhere.' : view === 'inbox' ? 'New mail shows up here automatically.' : undefined}
          </EmptyState>
        ) : (
          <ul>
            {list.map((t, i) => {
              const unread = t.unreadCount > 0;
              const showParticipants = view === 'sent' || view === 'drafts' ? participantLabel(t.participants, new Set()) : participantLabel(t.participants, own);
              return (
                <li
                  key={t.id}
                  data-index={i}
                  onClick={() => {
                    setFocusIndex(i);
                    onOpen(t);
                  }}
                  className={cn(
                    'group relative flex cursor-pointer gap-3 border-b border-border px-3 py-2.5 transition-colors',
                    activeId === t.id ? 'bg-primary-soft' : unread ? 'bg-surface hover:bg-surface-2' : 'bg-bg hover:bg-surface-2',
                    focusIndex === i && activeId !== t.id && 'ring-2 ring-[var(--ring)] ring-inset',
                  )}
                >
                  {unread && <span className="absolute top-0 left-0 h-full w-0.5 bg-primary" />}
                  <div className="flex flex-col items-center gap-1.5 pt-0.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label="Select"
                      checked={selected.has(t.id)}
                      onChange={(e) => {
                        const n = new Set(selected);
                        if (e.target.checked) n.add(t.id);
                        else n.delete(t.id);
                        setSelected(n);
                      }}
                      className="h-4 w-4 accent-[var(--primary)]"
                    />
                    <button type="button" aria-label={t.starred ? 'Unstar' : 'Star'} onClick={() => act([t.id], t.starred ? 'unstar' : 'star')}>
                      <Star className={cn('h-4 w-4', t.starred ? 'fill-amber-400 text-amber-400' : 'text-faint opacity-0 group-hover:opacity-100')} />
                    </button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className={cn('min-w-0 flex-1 truncate text-[13px]', unread ? 'font-semibold text-fg' : 'text-fg')}>
                        {t.draftCount > 0 && <span className="mr-1 text-danger">Draft</span>}
                        {showParticipants || '(unknown)'}
                        {t.messageCount > 1 && <span className="ml-1 text-xs font-normal text-faint">{t.messageCount}</span>}
                      </span>
                      {t.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-faint" />}
                      <span className={cn('shrink-0 text-xs', unread ? 'font-semibold text-fg' : 'text-faint')}>{listDate(view === 'sent' && t.lastSentAt ? t.lastSentAt : view === 'snoozed' && t.snoozedUntil ? t.snoozedUntil : t.lastMessageAt)}</span>
                    </div>
                    <div className={cn('truncate text-[13px]', unread ? 'font-medium text-fg' : 'text-muted')}>{t.subject || '(no subject)'}</div>
                    <div className="flex items-center gap-1.5">
                      {t.labels.slice(0, 3).map((id) => {
                        const l = labelsById.get(id);
                        return l ? (
                          <span key={id} className={cn('shrink-0 rounded px-1.5 text-[10px] font-medium', LABEL_CHIP[l.color] ?? LABEL_CHIP.slate)}>
                            {l.name}
                          </span>
                        ) : null;
                      })}
                      <span className="min-w-0 flex-1 truncate text-xs text-faint">{t.snippet}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={sentinel} className="h-8" />
        {q.isFetchingNextPage && <div className="pb-4 text-center text-xs text-muted">Loading…</div>}
      </div>
    </div>
  );
}
