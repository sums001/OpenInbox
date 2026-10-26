import { useEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, Archive, CalendarClock, Check, ChevronDown, CircleCheck, Clock, Inbox, LoaderCircle, Mail, MailOpen, Menu as MenuIcon, OctagonAlert, Paperclip, RefreshCw, Search, SearchX, SquarePen, Star, Trash2, X } from 'lucide-react';
import { listDate } from '../../lib/format';
import { ownAddresses, participantLabel, snoozePresets, VIEW_LABELS } from '../../lib/mail';
import { cn, storageGet, storageSet } from '../../lib/utils';
import type { Mailbox, ThreadSummary } from '../../lib/types';
import { Button, IconButton } from '../../components/ui/button';
import { Tick } from '../../components/ui/form';
import { Avatar, Kbd, Skeleton } from '../../components/ui/misc';
import { ConfirmDialog, Menu, MenuItem, MenuLabel, MenuSeparator, useToast } from '../../components/ui/overlay';
import { labelChip } from './labels';
import { PickTimeDialog } from './PickTimeDialog';
import { useThreadActions, useThreads, type Action } from './data';

const OPERATORS: [string, string][] = [
  ['from:', 'Sender name or address'],
  ['to:', 'Recipient'],
  ['subject:', 'Words in the subject'],
  ['has:attachment', 'Only with files'],
  ['is:unread', 'Unread conversations'],
  ['in:anywhere', 'Include Archive, Spam, Trash'],
  ['before:2026-01-31', 'Also after:'],
];

const RECENT_KEY = 'oi.recentSearches';

function timeHint(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => storageGet(RECENT_KEY, []));
  const [pickSnooze, setPickSnooze] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
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

  const runSearch = (text: string) => {
    const t = text.trim();
    if (t) {
      const next = [t, ...recent.filter((r) => r !== t)].slice(0, 5);
      setRecent(next);
      storageSet(RECENT_KEY, next);
    }
    setSearchOpen(false);
    searchRef.current?.blur();
    onSearch(t);
  };

  const ids = [...selected];
  const bulk = (action: Action, opts: Parameters<typeof act>[2] = {}, label?: string) => {
    if (!ids.length) return;
    act(ids, action, opts)
      .then(() => label && toast.success(label))
      .catch(() => toast.error('Something went wrong.'));
    setSelected(new Set());
  };
  const toggle = (id: number) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };
  const allSelected = list.length > 0 && list.every((t) => selected.has(t.id));
  const title = view.startsWith('label-') ? (labelsById.get(Number(view.slice(6)))?.name ?? 'Label') : (VIEW_LABELS[view] ?? view);
  const mailboxName = mailbox === 'all' ? (mailboxes.length > 1 ? 'All inboxes' : '') : (mailboxes.find((m) => String(m.id) === mailbox)?.address ?? '');
  const heading = view === 'search' ? `Results for “${query}”` : title;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative shrink-0 px-3 pt-2.5 pb-2 max-md:pt-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(search);
          }}
          className="flex items-center gap-2"
        >
          <button type="button" onClick={onMenu} className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] text-muted md:hidden" aria-label="Menu">
            <MenuIcon className="h-5 w-5" />
          </button>
          <div
            className={cn(
              'flex h-10 flex-1 items-center gap-2 rounded-[10px] border bg-surface pr-1.5 pl-2.5 transition-shadow md:h-[34px] md:rounded-lg',
              searchOpen ? 'border-primary ring-3 ring-[var(--ring)]' : 'border-border',
            )}
          >
            <Search className="h-[15px] w-[15px] shrink-0 text-faint" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setSearchOpen(false)}
              placeholder="Search mail"
              aria-label="Search mail"
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint md:text-[13px]"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearch('');
                  (e.target as HTMLInputElement).blur();
                  if (query) onSearch('');
                }
              }}
            />
            {search ? (
              <button
                type="button"
                className="grid h-[22px] w-[22px] place-items-center rounded-[5px] bg-surface-2 text-faint hover:text-fg"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setSearch('');
                  onSearch('');
                }}
                aria-label="Clear search"
              >
                <X className="h-[13px] w-[13px]" />
              </button>
            ) : (
              <span className="hidden md:contents">
                <Kbd>/</Kbd>
              </span>
            )}
          </div>
          <button type="button" onClick={onCompose} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary text-primary-fg md:hidden" aria-label="Compose">
            <SquarePen className="h-[18px] w-[18px]" />
          </button>
        </form>
        {searchOpen && (
          <div className="absolute top-full right-3 left-3 z-20 -mt-1 rounded-[10px] border border-border bg-surface p-1.5 text-[13px] shadow-pop animate-fade-in" onMouseDown={(e) => e.preventDefault()}>
            <div className="px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-faint">Search operators</div>
            {OPERATORS.map(([op, d]) => (
              <button
                key={op}
                type="button"
                onClick={() => {
                  const base = search.trim();
                  setSearch(`${base ? `${base} ` : ''}${op.endsWith(':') ? op : `${op} `}`);
                  searchRef.current?.focus();
                }}
                className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-surface-2"
              >
                <span className="min-w-[132px] font-mono text-xs font-medium text-primary-text">{op}</span>
                <span className="truncate text-[12.5px] text-muted">{d}</span>
              </button>
            ))}
            {recent.length > 0 && (
              <>
                <div className="mx-0.5 my-1.5 h-px bg-border" />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-1 pb-1.5 text-xs text-faint">
                  <Clock className="h-[13px] w-[13px]" />
                  Recent:
                  {recent.map((r, i) => (
                    <span key={r} className="flex items-center gap-2">
                      {i > 0 && <span>·</span>}
                      <button
                        type="button"
                        className="text-muted hover:text-fg"
                        onClick={() => {
                          setSearch(r);
                          runSearch(r);
                        }}
                      >
                        {r}
                      </button>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {ids.length ? (
        <div className="flex h-10 shrink-0 items-center gap-0.5 border-y border-border bg-primary-soft pr-2 pl-3.5 md:border-t-0">
          <Tick checked={allSelected} indeterminate={!allSelected} onChange={(v) => setSelected(v ? new Set(list.map((t) => t.id)) : new Set())} label="Select all" className="mr-2" />
          <span className="flex-1 truncate text-[13px] font-semibold text-primary-text">{ids.length} selected</span>
          <IconButton label="Archive" shortcut="E" onClick={() => bulk('archive', {}, 'Archived')} icon={<Archive />} className="h-7 w-7" />
          <IconButton
            label={view === 'trash' ? 'Delete forever' : 'Delete'}
            shortcut="#"
            onClick={() => bulk(view === 'trash' ? 'delete' : 'trash', {}, view === 'trash' ? 'Deleted forever' : 'Moved to Trash')}
            icon={<Trash2 />}
            className="h-7 w-7"
          />
          <IconButton label="Report spam" shortcut="!" onClick={() => bulk('spam', {}, 'Marked as spam')} icon={<OctagonAlert />} className="h-7 w-7" />
          <IconButton label="Mark read" onClick={() => bulk('read')} icon={<MailOpen />} className="h-7 w-7" />
          <IconButton label="Mark unread" onClick={() => bulk('unread')} icon={<Mail />} className="h-7 w-7" />
          {view !== 'inbox' && <IconButton label="Move to Inbox" onClick={() => bulk('inbox', {}, 'Moved to Inbox')} icon={<Inbox />} className="h-7 w-7" />}
          <Menu
            className="w-[250px]"
            trigger={({ onClick, open }) => (
              <button
                type="button"
                onClick={onClick}
                aria-label="Snooze"
                className={cn('flex h-7 items-center gap-[3px] rounded-[7px] px-1.5 text-muted hover:text-fg', open && 'bg-surface text-fg shadow-card')}
              >
                <AlarmClock className="h-[15px] w-[15px]" />
                <ChevronDown className="h-3 w-3 text-faint" />
              </button>
            )}
          >
            <MenuLabel>Snooze until</MenuLabel>
            {snoozePresets().map((p) => (
              <MenuItem key={p.label} onClick={() => bulk('snooze', { until: p.at }, 'Snoozed')} hint={timeHint(p.at)}>
                {p.label}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon={<CalendarClock />} onClick={() => setPickSnooze(true)}>
              Pick date and time…
            </MenuItem>
          </Menu>
        </div>
      ) : (
        // One heading for both layouts: large on phones, a compact list header on desktop.
        <div className="flex shrink-0 items-baseline gap-2.5 px-[18px] pt-1.5 pb-2.5 md:h-10 md:items-center md:border-b md:border-border md:pt-0 md:pr-2.5 md:pb-0 md:pl-3.5">
          <Tick checked={false} onChange={(v) => v && setSelected(new Set(list.map((t) => t.id)))} label="Select all" className="max-md:hidden" />
          <div className="min-w-0 flex-1 truncate text-xl font-semibold tracking-[-0.02em] md:text-[13px] md:tracking-normal">
            {heading}
            {mailboxName && <span className="text-[13px] font-normal tracking-normal text-faint max-md:ml-2 md:before:content-['_·_']">{mailboxName}</span>}
          </div>
          {(view === 'spam' || view === 'trash') && list.length > 0 && (
            <Button size="xs" variant="ghost" className="hover:text-danger" onClick={() => setConfirmEmpty(true)}>
              Empty {view}
            </Button>
          )}
          <IconButton label="Refresh" onClick={() => q.refetch()} icon={<RefreshCw className={cn(q.isFetching && 'animate-spin text-primary-text')} />} className="h-7 w-7 max-md:hidden" />
        </div>
      )}

      <div ref={container} className="scroll-thin min-h-0 flex-1 overflow-y-auto max-md:border-t max-md:border-border">
        {q.isLoading ? (
          <div>
            {['38%,72%,88%', '30%,64%,80%', '44%,58%,92%', '26%,70%,76%', '40%,52%,84%', '34%,66%,90%', '28%,60%,78%', '42%,74%,86%'].map((w) => {
              const [a, b, c] = w.split(',');
              return (
                <div key={w} className="flex gap-[11px] border-b border-border px-3.5 py-3">
                  <Skeleton className="mt-0.5 h-[15px] w-[15px] rounded-[4px]" />
                  <div className="flex flex-1 flex-col gap-2 pt-[3px]">
                    <div className="flex gap-3">
                      <Skeleton className="h-2.5" style={{ width: a }} />
                      <div className="flex-1" />
                      <Skeleton className="h-2.5 w-11" />
                    </div>
                    <Skeleton className="h-2.5" style={{ width: b }} />
                    <Skeleton className="h-2.5 bg-surface-2" style={{ width: c }} />
                  </div>
                </div>
              );
            })}
            <div className="flex h-11 items-center justify-center gap-2 text-[12.5px] text-faint">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          </div>
        ) : list.length === 0 ? (
          view === 'search' ? (
            <div className="flex flex-col items-center px-9 pt-[72px] text-center">
              <div className="mb-4 grid h-12 w-12 place-items-center rounded-[14px] bg-surface-2 text-muted">
                <SearchX className="h-[22px] w-[22px]" />
              </div>
              <div className="text-[15px] font-semibold">No results</div>
              <div className="mt-1 text-[13px] text-muted text-pretty">Nothing matches. Try fewer words, or widen the search.</div>
              <div className="mt-5 flex w-full max-w-[300px] flex-col gap-2 rounded-[10px] border border-border bg-surface px-3.5 py-3 text-left text-[12.5px] text-muted">
                {[
                  ['in:anywhere', 'Include Archive, Spam, Trash'],
                  ['from:ann', 'Matches name or address'],
                  ['has:attachment', 'Only with files'],
                ].map(([op, d]) => (
                  <div key={op} className="flex gap-2.5">
                    <span className="min-w-24 font-mono text-xs leading-[18px] font-medium text-primary-text">{op}</span>
                    {d}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center px-8 pt-24 text-center">
              <div className={cn('mb-4 grid h-12 w-12 place-items-center rounded-[14px]', view === 'inbox' ? 'bg-success-soft text-success' : 'bg-surface-2 text-muted')}>
                {view === 'inbox' ? <CircleCheck className="h-[22px] w-[22px]" /> : <Inbox className="h-[22px] w-[22px]" />}
              </div>
              <div className="text-[15px] font-semibold">{view === 'inbox' ? 'Inbox zero' : 'Nothing here'}</div>
              {view === 'inbox' && <div className="mt-1 text-[13px] text-muted">New mail shows up here automatically.</div>}
            </div>
          )
        ) : (
          <ul>
            {list.map((t, i) => {
              const unread = t.unreadCount > 0;
              const active = activeId === t.id;
              const isSelected = selected.has(t.id);
              const participants = view === 'sent' || view === 'drafts' ? participantLabel(t.participants, new Set()) : participantLabel(t.participants, own);
              const first = t.participants.find((p) => !own.has(p.address.toLowerCase())) ?? t.participants[0];
              const strong = unread || active;
              return (
                <li
                  key={t.id}
                  data-index={i}
                  onClick={() => {
                    setFocusIndex(i);
                    onOpen(t);
                  }}
                  className={cn(
                    'group relative flex cursor-pointer gap-3 border-b border-border px-4 py-3 transition-colors md:gap-[11px] md:px-3.5 md:py-2.5',
                    isSelected ? 'bg-[color-mix(in_oklch,var(--primary-soft)_75%,var(--surface))]' : active ? 'bg-primary-soft' : unread ? 'bg-surface hover:bg-surface-2' : 'hover:bg-surface-2',
                    focusIndex === i && !active && 'md:shadow-[inset_0_0_0_2px_var(--ring)]',
                  )}
                >
                  {unread && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
                  {/* Mobile: the avatar toggles selection. */}
                  <button
                    type="button"
                    className="shrink-0 md:hidden"
                    aria-label={isSelected ? 'Deselect' : 'Select'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(t.id);
                    }}
                  >
                    {isSelected ? (
                      <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-primary-fg">
                        <Check className="h-4 w-4" />
                      </span>
                    ) : (
                      <Avatar name={first?.name ?? ''} address={first?.address ?? ''} size={36} />
                    )}
                  </button>
                  <div className="hidden flex-col items-center gap-[9px] pt-0.5 md:flex">
                    <Tick checked={isSelected} onChange={() => toggle(t.id)} label="Select" />
                    <button
                      type="button"
                      aria-label={t.starred ? 'Unstar' : 'Star'}
                      onClick={(e) => {
                        e.stopPropagation();
                        act([t.id], t.starred ? 'unstar' : 'star');
                      }}
                    >
                      <Star className={cn('h-[15px] w-[15px]', t.starred ? 'fill-[oklch(0.78_0.16_78)] text-[oklch(0.78_0.16_78)]' : 'text-transparent group-hover:text-faint')} />
                    </button>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-px">
                    <div className="flex items-center gap-1.5 text-sm leading-[19px] md:text-[13px]">
                      <span className={cn('min-w-0 flex-1 truncate', unread ? 'font-semibold' : 'font-medium', strong ? 'text-fg' : 'text-muted')}>
                        {t.draftCount > 0 && (
                          <>
                            <span className="font-semibold text-danger">Draft</span>
                            <span className="text-faint">, </span>
                          </>
                        )}
                        {participants || '(unknown)'}
                        {t.messageCount > 1 && <span className="ml-1.5 text-xs font-normal text-faint">{t.messageCount}</span>}
                      </span>
                      {t.hasAttachments && <Paperclip className="h-[13px] w-[13px] shrink-0 text-faint" />}
                      {t.starred && <Star className="h-3 w-3 shrink-0 fill-[oklch(0.78_0.16_78)] text-[oklch(0.78_0.16_78)] md:hidden" />}
                      <span className={cn('shrink-0 text-xs tabular-nums', unread ? 'font-semibold text-fg' : 'text-faint')}>
                        {listDate(view === 'sent' && t.lastSentAt ? t.lastSentAt : view === 'snoozed' && t.snoozedUntil ? t.snoozedUntil : t.lastMessageAt)}
                      </span>
                    </div>
                    <div className={cn('truncate text-[13.5px] leading-[19px] md:text-[13px]', unread ? 'font-semibold' : 'font-[450]', strong ? 'text-fg' : 'text-muted')}>{t.subject || '(no subject)'}</div>
                    <div className="flex min-w-0 items-center gap-[5px] text-[13px] leading-[19px]">
                      {t.labels.slice(0, 3).map((id) => {
                        const l = labelsById.get(id);
                        return l ? (
                          <span key={id} className="label-chip inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[11.5px] font-medium" style={labelChip(l.color)}>
                            {l.name}
                          </span>
                        ) : null;
                      })}
                      <span className="min-w-0 flex-1 truncate text-faint">{t.snippet}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={sentinel} className="h-8" />
        {q.isFetchingNextPage && (
          <div className="flex items-center justify-center gap-2 pb-4 text-[12.5px] text-faint">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        )}
      </div>

      <PickTimeDialog
        open={pickSnooze}
        onClose={() => setPickSnooze(false)}
        title="Snooze until"
        description="The conversation leaves the inbox and comes back at this time."
        confirmLabel="Snooze"
        onPick={(at) => bulk('snooze', { until: at }, 'Snoozed')}
      />
      <ConfirmDialog
        open={confirmEmpty}
        onClose={() => setConfirmEmpty(false)}
        icon={<Trash2 />}
        danger
        title={`Empty ${view}?`}
        confirmLabel="Delete forever"
        onConfirm={() => {
          setConfirmEmpty(false);
          act(
            list.map((t) => t.id),
            'delete',
          ).then(() => toast.success('Emptied'));
        }}
      >
        The {list.length} conversations here are deleted forever. This can't be undone.
      </ConfirmDialog>
    </div>
  );
}
