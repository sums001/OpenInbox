import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams, Routes, Route } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { api, errorText, post } from '../../lib/api';
import { fullDate } from '../../lib/format';
import { cn } from '../../lib/utils';
import { withSignature, Composer, type ComposeState, type SendRequest } from './Composer';
import { MailSidebar } from './MailSidebar';
import { ThreadList } from './ThreadList';
import { ThreadView } from './ThreadView';
import { useMailboxes, useMailSync, useThreadActions, useThreads, useViewAction, useViewCount, type Action, type ActionOpts, type BulkProgress } from './data';
import { singleKeysOn } from './CommandPalette';
import { useAnnounce, useToast } from '../../components/ui/overlay';
import { Kbd, PageSpinner } from '../../components/ui/misc';
import type { ThreadSummary } from '../../lib/types';
import type { MessageRequest } from './ThreadView';

const BULK_VERBS: Partial<Record<Action, string>> = {
  archive: 'Archiving',
  inbox: 'Moving to Inbox',
  trash: 'Moving to Trash',
  delete: 'Deleting',
  spam: 'Marking as spam',
  read: 'Marking as read',
  unread: 'Marking as unread',
  star: 'Starring',
  unstar: 'Unstarring',
  snooze: 'Snoozing',
};

export default function MailPage() {
  return (
    <Routes>
      <Route path=":mailbox/:view/:threadId?" element={<MailApp />} />
      <Route path="*" element={<Navigate to="/mail/all/inbox" replace />} />
    </Routes>
  );
}

const UNDO_MS = 6000;

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

// Enter and Space on a button or link already press it.
function onControl(e: KeyboardEvent): boolean {
  return (e.key === 'Enter' || e.key === ' ') && !!(e.target as HTMLElement).closest('button, a[href], [role="menuitem"]');
}

function conversations(n: number): string {
  return n ? `${n} conversation${n === 1 ? '' : 's'} selected` : 'No conversations selected';
}

function MailApp() {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const announce = useAnnounce();
  const mailboxParam = params.mailbox ?? 'all';
  const view = params.view ?? 'inbox';
  const threadId = params.threadId ? Number(params.threadId) : null;
  const query = search.get('q') ?? '';
  const { data: mailboxes, isLoading } = useMailboxes();
  useMailSync(mailboxes);
  const threads = useThreads(mailboxParam, view, query);
  const list = useMemo(() => threads.data?.pages.flatMap((p) => p.threads) ?? [], [threads.data]);
  const act = useThreadActions();
  const viewAction = useViewAction();
  const [selected, setSelectedIds] = useState<Set<number>>(new Set());
  // Every conversation in the view, not just the loaded ones (Gmail's "Select all conversations").
  const [allMatching, setAllMatching] = useState(false);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const setSelected = useCallback((s: Set<number>) => {
    setSelectedIds(s);
    setAllMatching(false);
  }, []);
  const pageAllSelected = list.length > 0 && list.every((t) => selected.has(t.id));
  const hasMore = !!threads.hasNextPage;
  const wholeViewPossible = hasMore && view !== 'search' && view !== 'scheduled';
  const { data: matchCount } = useViewCount(mailboxParam, view, wholeViewPossible && (pageAllSelected || allMatching));
  const [focusIndex, setFocusIndex] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [composers, setComposers] = useState<ComposeState[]>([]);
  const [replyRequest, setReplyRequest] = useState<{ kind: 'reply' | 'replyAll' | 'forward'; nonce: number } | null>(null);
  const [messageRequest, setMessageRequest] = useState<MessageRequest | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pending = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const gPressed = useRef(false);

  useEffect(() => {
    setSelected(new Set());
    setFocusIndex(0);
  }, [mailboxParam, view, query, setSelected]);

  // The list's keyboard row follows the open conversation, so going back lands on it.
  useEffect(() => {
    const i = threadId ? list.findIndex((t) => t.id === threadId) : -1;
    if (i >= 0) setFocusIndex(i);
  }, [threadId, list]);

  // Runs an action on the selection. With `whole`, on every conversation in the view, one server
  // batch at a time with progress shown above the list.
  const bulkAction = useCallback(
    (action: Action, opts: ActionOpts = {}, label?: string, whole = allMatching) => {
      if (whole) {
        if (progress) {
          toast.info('Wait for the current action to finish.');
          return;
        }
        setSelected(new Set());
        setProgress({ verb: BULK_VERBS[action] ?? 'Updating', done: 0, total: matchCount && !matchCount.capped ? matchCount.count : null });
        viewAction(mailboxParam, view, action, opts, (done) => setProgress((p) => p && { ...p, done }))
          .then((n) => toast.success(`${label ?? 'Updated'} · ${n.toLocaleString()} conversation${n === 1 ? '' : 's'}`))
          .catch((e: Error & { done?: number }) => toast.error(`Stopped after ${(e.done ?? 0).toLocaleString()} conversations: ${errorText(e)}`))
          .finally(() => setProgress(null));
        return;
      }
      if (!selected.size) return;
      act([...selected], action, opts)
        .then(() => label && toast.success(label))
        .catch(() => toast.error('Something went wrong.'));
      setSelected(new Set());
    },
    [allMatching, progress, matchCount, mailboxParam, view, selected, act, viewAction, setSelected, toast],
  );

  const base = `/mail/${mailboxParam}/${view}`;
  const suffix = view === 'search' ? `?q=${encodeURIComponent(query)}` : '';
  const openThread = useCallback(
    (t: ThreadSummary) => {
      // A new message that was never sent opens in the composer.
      if (t.messageCount === 0 && t.draftCount > 0) {
        api<{ messages: { id: number; status: string; from: { address: string }; to: never[]; cc: never[]; bcc: never[]; subject: string; html: string | null; text: string; attachments: { id: number; filename: string; size: number }[] }[] }>(`/threads/${t.id}`).then((d) => {
          const draft = d.messages.find((m) => m.status === 'draft');
          if (draft)
            openCompose({
              key: `draft-${draft.id}`,
              draftId: draft.id,
              mailboxId: t.mailboxId,
              from: draft.from.address,
              to: draft.to,
              cc: draft.cc,
              bcc: draft.bcc,
              subject: draft.subject,
              html: draft.html ?? `<p>${draft.text}</p>`,
              attachments: draft.attachments.map((a) => ({ key: `a-${a.id}`, attachmentId: a.id, filename: a.filename, size: a.size })),
            });
        });
        return;
      }
      navigate(`${base}/${t.id}${suffix}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, suffix, navigate],
  );

  const openCompose = useCallback(
    (state?: Partial<ComposeState>) => {
      const boxes = (mailboxes ?? []).filter((m) => m.canSend);
      const preferred = boxes.find((m) => String(m.id) === mailboxParam) ?? boxes[0];
      if (!preferred && !state?.mailboxId) {
        toast.error('You cannot send from any inbox. Ask an admin for access.');
        return;
      }
      const box = (mailboxes ?? []).find((m) => m.id === state?.mailboxId) ?? preferred!;
      const full: ComposeState = {
        key: `c-${Date.now()}`,
        mailboxId: box.id,
        from: box.address,
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        html: withSignature('<p></p>', box.signature),
        attachments: [],
        ...state,
      };
      setComposers((cs) => (cs.some((c) => c.key === full.key) ? cs : [...cs.slice(-1), full]));
    },
    [mailboxes, mailboxParam, toast],
  );

  // mailto: style links, e.g. /mail/all/inbox?compose=ann@example.com (empty: a blank message).
  useEffect(() => {
    if (search.has('compose') && mailboxes) {
      const to = search.get('compose');
      openCompose(to ? { to: [{ name: '', address: to }] } : undefined);
      navigate(location.pathname, { replace: true });
    }
  }, [search, mailboxes, openCompose, navigate, location.pathname]);

  // The command palette lives in the app shell and asks for these.
  useEffect(() => {
    const compose = () => openCompose();
    const focusSearch = () => searchRef.current?.focus();
    window.addEventListener('oi:compose', compose);
    window.addEventListener('oi:search', focusSearch);
    return () => {
      window.removeEventListener('oi:compose', compose);
      window.removeEventListener('oi:search', focusSearch);
    };
  }, [openCompose]);

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['threads'] });
    qc.invalidateQueries({ queryKey: ['thread'] });
    qc.invalidateQueries({ queryKey: ['mailboxes'] });
  }, [qc]);

  const doSend = useCallback(
    async (id: number, sendAt?: number | null) => {
      // A failed send stays in the thread as a failed message; Retry sends it again.
      const retry = {
        label: 'Retry',
        onClick: () =>
          post<{ status: string; error?: string }>(`/messages/${id}/retry`)
            .then((r) => (r.status === 'sent' ? toast.success('Message sent') : toast.error(r.error ? `Not sent: ${r.error}` : 'Still not sent.')))
            .catch((e) => toast.error(errorText(e)))
            .finally(refresh),
      };
      try {
        const r = await post<{ status: string; error?: string }>(`/drafts/${id}/send`, { sendAt: sendAt ?? null });
        if (r.status === 'sent') toast.success('Message sent');
        else if (r.status === 'scheduled')
          toast.success(`Scheduled for ${fullDate(sendAt!)}`, {
            label: 'Undo',
            onClick: () => post(`/messages/${id}/cancel-schedule`).then(() => toast.success('Moved back to drafts')).catch((e) => toast.error(errorText(e))).finally(refresh),
          });
        else toast.error(r.error ? `Not sent: ${r.error}` : 'Not sent.', retry);
      } catch (e) {
        toast.error(`Not sent: ${errorText(e)}`);
      } finally {
        refresh();
      }
    },
    [refresh, toast],
  );

  // Undo send: the message waits a few seconds in the browser before it goes out.
  const onSend = useCallback(
    (r: SendRequest) => {
      if (r.sendAt) {
        doSend(r.draftId, r.sendAt);
        return;
      }
      const timer = setTimeout(() => {
        pending.current.delete(r.draftId);
        doSend(r.draftId);
      }, UNDO_MS);
      pending.current.set(r.draftId, timer);
      toast.pending(
        'Sending…',
        {
          label: 'Undo',
          onClick: () => {
            clearTimeout(timer);
            pending.current.delete(r.draftId);
            openCompose({ ...r.state, key: `undo-${r.draftId}-${Date.now()}`, draftId: r.draftId });
          },
        },
        UNDO_MS,
      );
    },
    [doSend, openCompose, toast],
  );

  // Leaving the page sends anything still waiting for its undo window.
  useEffect(() => {
    const flush = () => {
      const csrf = document.cookie.match(/(?:^|;\s*)oi_csrf=([^;]+)/)?.[1] ?? '';
      for (const [id, timer] of pending.current) {
        clearTimeout(timer);
        fetch(`/api/drafts/${id}/send`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' });
      }
      pending.current.clear();
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const onSearch = useCallback(
    (q: string) => {
      if (q.trim()) navigate(`/mail/${mailboxParam}/search?q=${encodeURIComponent(q.trim())}`);
      else navigate(`/mail/${mailboxParam}/inbox`);
    },
    [mailboxParam, navigate],
  );

  // Keyboard shortcuts (Ctrl/⌘ K is in the app shell).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || onControl(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[role="dialog"]')) return;
      // Letters and symbols can be turned off for screen readers that use them; named keys always work.
      if (e.key.length === 1 && e.key !== ' ' && !singleKeysOn()) return;
      const focused = list[focusIndex];
      const target = threadId ? [threadId] : selected.size ? [...selected] : focused ? [focused.id] : [];
      // Actions on the selection go through bulkAction, which also covers "every conversation".
      const onSelection = !threadId && (allMatching || selected.size > 0);
      if (gPressed.current) {
        gPressed.current = false;
        const map: Record<string, string> = { i: 'inbox', s: 'sent', d: 'drafts', a: 'archive', t: 'trash', p: 'spam', z: 'snoozed' };
        if (map[e.key]) navigate(`/mail/${mailboxParam}/${map[e.key]}`);
        return;
      }
      const leave = () => threadId && navigate(`${base}${suffix}`);
      const inList = !!(e.target as HTMLElement).closest('[role="listbox"]');
      // The first move from outside the list lands on its keyboard row, so it is heard before moving on.
      const enterList = () => {
        const row = threadId || inList ? null : document.querySelector<HTMLElement>('[role="listbox"] [tabindex="0"]');
        row?.focus();
        return !!row;
      };
      // Next / previous conversation: the keyboard row in the list, or the one that opens next.
      const step = (d: 1 | -1) => {
        if (threadId) {
          const next = list[list.findIndex((t) => t.id === threadId) + d];
          if (next) openThread(next);
          else announce(d > 0 ? 'No more conversations' : 'This is the first conversation');
        } else if (!enterList()) {
          const i = Math.min(focusIndex, list.length - 1) + d;
          if (i >= 0 && i < list.length) setFocusIndex(i);
          // More rows load as the list scrolls to its end.
          else if (d < 0 || !hasMore) announce(d > 0 ? 'No more conversations' : 'This is the first conversation');
        }
      };
      switch (e.key) {
        case 'c':
          e.preventDefault();
          openCompose();
          break;
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case '?':
          window.dispatchEvent(new CustomEvent('oi:shortcuts'));
          break;
        case 'g':
          gPressed.current = true;
          setTimeout(() => (gPressed.current = false), 1200);
          break;
        // In an open conversation, ↑ ↓ j k Home End move between its messages; n / p change conversation.
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          if (threadId) setMessageRequest({ kind: 'next', nonce: Date.now() });
          else step(1);
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          if (threadId) setMessageRequest({ kind: 'prev', nonce: Date.now() });
          else step(-1);
          break;
        case 'n':
          step(1);
          break;
        case 'p':
          step(-1);
          break;
        case 'Home':
        case 'End':
          e.preventDefault();
          if (threadId) setMessageRequest({ kind: e.key === 'Home' ? 'first' : 'last', nonce: Date.now() });
          else if (list.length) {
            enterList();
            setFocusIndex(e.key === 'Home' ? 0 : list.length - 1);
          }
          break;
        case 'o':
        case 'Enter':
          if (threadId) setMessageRequest({ kind: 'toggle', nonce: Date.now() });
          else if (focused) openThread(focused);
          break;
        case 'u':
        case 'Escape':
          if (threadId) navigate(`${base}${suffix}`);
          else if (selected.size || allMatching) {
            setSelected(new Set());
            announce('Selection cleared');
          }
          break;
        // Space selects too, as in any multi-select list; elsewhere it scrolls.
        case ' ':
        case 'x':
          if (e.key === ' ') {
            if (!inList) break;
            e.preventDefault();
          }
          if (focused && !threadId) {
            const n = new Set(selected);
            if (n.has(focused.id)) n.delete(focused.id);
            else n.add(focused.id);
            setSelected(n);
            announce(conversations(n.size));
          }
          break;
        case 'e':
          if (onSelection) bulkAction(view === 'archive' ? 'inbox' : 'archive', {}, view === 'archive' ? 'Moved to Inbox' : 'Archived');
          else if (target.length) act(target, view === 'archive' ? 'inbox' : 'archive').then(() => toast.success(view === 'archive' ? 'Moved to Inbox' : 'Archived'));
          leave();
          break;
        case '#':
          if (onSelection) bulkAction('trash', {}, 'Moved to Trash');
          else if (target.length) act(target, 'trash').then(() => toast.success('Moved to Trash'));
          leave();
          break;
        case '!':
          if (onSelection) bulkAction('spam', {}, 'Marked as spam');
          else if (target.length) act(target, 'spam').then(() => toast.success('Marked as spam'));
          leave();
          break;
        // These change the row in place, with no toast, so they are only spoken.
        case 's': {
          const t = list.find((x) => x.id === target[0]);
          if (onSelection) bulkAction(t?.starred ? 'unstar' : 'star');
          else if (target.length) act(target, t?.starred ? 'unstar' : 'star');
          if (onSelection || target.length) announce(t?.starred ? 'Unstarred' : 'Starred');
          break;
        }
        case 'I':
          if (onSelection) bulkAction('read');
          else if (target.length) act(target, 'read');
          if (onSelection || target.length) announce('Marked as read');
          break;
        case 'U':
          if (onSelection) bulkAction('unread');
          else if (target.length) act(target, 'unread');
          if (onSelection || target.length) announce('Marked as unread');
          break;
        case 'r':
        case 'a':
        case 'f':
          if (threadId) {
            e.preventDefault();
            setReplyRequest({ kind: e.key === 'r' ? 'reply' : e.key === 'a' ? 'replyAll' : 'forward', nonce: Date.now() });
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list, hasMore, focusIndex, selected, allMatching, threadId, view, base, suffix, mailboxParam, navigate, openCompose, openThread, act, bulkAction, setSelected, toast, announce]);

  // The browser tab shows the unread count.
  useEffect(() => {
    const unread = (mailboxes ?? []).reduce((n, m) => n + (m.unread.inbox ?? 0), 0);
    document.title = unread ? `(${unread}) Inbox · OpenInbox` : 'OpenInbox';
    return () => {
      document.title = 'OpenInbox';
    };
  }, [mailboxes]);

  if (isLoading || !mailboxes) return <PageSpinner />;

  const position = threadId ? list.findIndex((t) => t.id === threadId) : -1;
  const nav =
    position >= 0
      ? {
          index: position,
          total: list.length,
          prev: position > 0 ? () => openThread(list[position - 1]) : undefined,
          next: list[position + 1] ? () => openThread(list[position + 1]) : undefined,
        }
      : undefined;

  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar: drawer on mobile */}
      <div className={cn('fixed inset-0 z-30 bg-scrim md:hidden', drawer ? 'block animate-fade-in' : 'hidden')} onClick={() => setDrawer(false)} />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-[304px] bg-bg shadow-pop transition-transform md:static md:z-auto md:w-64 md:translate-x-0 md:border-r md:border-border md:shadow-none',
          drawer ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <MailSidebar mailboxes={mailboxes} current={mailboxParam} view={view} onCompose={() => { setDrawer(false); openCompose(); }} onNavigate={() => setDrawer(false)} onClose={() => setDrawer(false)} />
      </aside>
      <section className={cn('relative min-h-0 w-full flex-col border-border md:flex md:w-[380px] md:shrink-0 md:border-r lg:w-[400px]', threadId ? 'hidden' : 'flex')}>
        <ThreadList
          mailbox={mailboxParam}
          view={view}
          query={query}
          mailboxes={mailboxes}
          activeId={threadId}
          focusIndex={focusIndex}
          setFocusIndex={setFocusIndex}
          selected={selected}
          setSelected={setSelected}
          allMatching={allMatching}
          setAllMatching={setAllMatching}
          matchCount={matchCount ?? null}
          progress={progress}
          onBulk={bulkAction}
          onOpen={openThread}
          onSearch={onSearch}
          onMenu={() => setDrawer(true)}
          onCompose={() => openCompose()}
          searchRef={searchRef}
        />
      </section>
      <section className={cn('min-h-0 min-w-0 flex-1', threadId ? 'block' : 'hidden md:block')}>
        {threadId ? (
          <ThreadView
            key={threadId}
            threadId={threadId}
            mailboxes={mailboxes}
            onBack={() => navigate(`${base}${suffix}`)}
            onSend={onSend}
            onOpenDraft={(s) => openCompose(s)}
            replyRequest={replyRequest}
            messageRequest={messageRequest}
            nav={nav}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center pb-10 text-center">
            <div className="mb-[18px] grid h-[52px] w-[52px] place-items-center rounded-[15px] border border-border bg-surface text-faint shadow-card">
              <Inbox className="h-[22px] w-[22px]" />
            </div>
            <div className="text-[15px] font-semibold">Select a conversation</div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-[13px] text-muted">
              Press <Kbd>c</Kbd> to compose, <Kbd>/</Kbd> to search, <Kbd>?</Kbd> for shortcuts
            </div>
          </div>
        )}
      </section>

      <div className="pointer-events-none fixed right-0 bottom-0 z-30 flex items-end gap-3 px-2 sm:right-6">
        {composers.map((c) => (
          <Composer key={c.key} initial={c} mailboxes={mailboxes} variant="floating" onClose={() => setComposers((cs) => cs.filter((x) => x.key !== c.key))} onSend={onSend} />
        ))}
      </div>
    </div>
  );
}
