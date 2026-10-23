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
import { CommandPalette, SHORTCUTS } from './CommandPalette';
import { useMailboxes, useMailSync, useThreadActions, useThreads } from './data';
import { Dialog, useToast } from '../../components/ui/overlay';
import { EmptyState, Kbd, PageSpinner } from '../../components/ui/misc';
import type { ThreadSummary } from '../../lib/types';

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

function MailApp() {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const mailboxParam = params.mailbox ?? 'all';
  const view = params.view ?? 'inbox';
  const threadId = params.threadId ? Number(params.threadId) : null;
  const query = search.get('q') ?? '';
  const { data: mailboxes, isLoading } = useMailboxes();
  useMailSync(mailboxes);
  const threads = useThreads(mailboxParam, view, query);
  const list = useMemo(() => threads.data?.pages.flatMap((p) => p.threads) ?? [], [threads.data]);
  const act = useThreadActions();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focusIndex, setFocusIndex] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [composers, setComposers] = useState<ComposeState[]>([]);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [replyRequest, setReplyRequest] = useState<{ kind: 'reply' | 'replyAll' | 'forward'; nonce: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pending = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const gPressed = useRef(false);

  useEffect(() => {
    setSelected(new Set());
    setFocusIndex(0);
  }, [mailboxParam, view, query]);

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

  // mailto: style links, e.g. /mail/all/inbox?compose=ann@example.com
  useEffect(() => {
    const to = search.get('compose');
    if (to && mailboxes) {
      openCompose({ to: [{ name: '', address: to }] });
      navigate(location.pathname, { replace: true });
    }
  }, [search, mailboxes, openCompose, navigate, location.pathname]);

  const doSend = useCallback(
    async (id: number, sendAt?: number | null) => {
      try {
        const r = await post<{ status: string; error?: string }>(`/drafts/${id}/send`, { sendAt: sendAt ?? null });
        if (r.status === 'sent') toast.success('Message sent');
        else if (r.status === 'scheduled') toast.success(`Scheduled for ${fullDate(sendAt!)}`);
        else toast.error(r.error ? `Not sent: ${r.error}` : 'Not sent.');
      } catch (e) {
        toast.error(`Not sent: ${errorText(e)}`);
      } finally {
        qc.invalidateQueries({ queryKey: ['threads'] });
        qc.invalidateQueries({ queryKey: ['thread'] });
        qc.invalidateQueries({ queryKey: ['mailboxes'] });
      }
    },
    [qc, toast],
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
      toast.info(
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

  // Keyboard shortcuts.
  useEffect(() => {
    const onHelp = () => setHelp(true);
    window.addEventListener('oi:shortcuts', onHelp);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[role="dialog"]')) return;
      const focused = list[focusIndex];
      const target = threadId ? [threadId] : selected.size ? [...selected] : focused ? [focused.id] : [];
      if (gPressed.current) {
        gPressed.current = false;
        const map: Record<string, string> = { i: 'inbox', s: 'sent', d: 'drafts', a: 'archive', t: 'trash', p: 'spam', z: 'snoozed' };
        if (map[e.key]) navigate(`/mail/${mailboxParam}/${map[e.key]}`);
        return;
      }
      const leave = () => threadId && navigate(`${base}${suffix}`);
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
          setHelp(true);
          break;
        case 'g':
          gPressed.current = true;
          setTimeout(() => (gPressed.current = false), 1200);
          break;
        case 'j':
        case 'ArrowDown':
          if (threadId) {
            const i = list.findIndex((t) => t.id === threadId);
            if (list[i + 1]) openThread(list[i + 1]);
          } else setFocusIndex((i) => Math.min(i + 1, list.length - 1));
          break;
        case 'k':
        case 'ArrowUp':
          if (threadId) {
            const i = list.findIndex((t) => t.id === threadId);
            if (i > 0) openThread(list[i - 1]);
          } else setFocusIndex((i) => Math.max(i - 1, 0));
          break;
        case 'o':
        case 'Enter':
          if (!threadId && focused) openThread(focused);
          break;
        case 'u':
        case 'Escape':
          if (threadId) navigate(`${base}${suffix}`);
          else setSelected(new Set());
          break;
        case 'x':
          if (focused) {
            const n = new Set(selected);
            if (n.has(focused.id)) n.delete(focused.id);
            else n.add(focused.id);
            setSelected(n);
          }
          break;
        case 'e':
          if (target.length) act(target, view === 'archive' ? 'inbox' : 'archive').then(() => toast.success(view === 'archive' ? 'Moved to Inbox' : 'Archived'));
          setSelected(new Set());
          leave();
          break;
        case '#':
          if (target.length) act(target, 'trash').then(() => toast.success('Moved to Trash'));
          setSelected(new Set());
          leave();
          break;
        case '!':
          if (target.length) act(target, 'spam').then(() => toast.success('Marked as spam'));
          setSelected(new Set());
          leave();
          break;
        case 's': {
          const t = list.find((x) => x.id === target[0]);
          if (target.length) act(target, t?.starred ? 'unstar' : 'star');
          break;
        }
        case 'I':
          if (target.length) act(target, 'read');
          break;
        case 'U':
          if (target.length) act(target, 'unread');
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
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('oi:shortcuts', onHelp);
    };
  }, [list, focusIndex, selected, threadId, view, base, suffix, mailboxParam, navigate, openCompose, openThread, act, toast]);

  // The browser tab shows the unread count.
  useEffect(() => {
    const unread = (mailboxes ?? []).reduce((n, m) => n + (m.unread.inbox ?? 0), 0);
    document.title = unread ? `(${unread}) Inbox · OpenInbox` : 'OpenInbox';
    return () => {
      document.title = 'OpenInbox';
    };
  }, [mailboxes]);

  if (isLoading || !mailboxes) return <PageSpinner />;

  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar: drawer on mobile */}
      <div className={cn('fixed inset-0 z-30 bg-black/40 md:hidden', drawer ? 'block' : 'hidden')} onClick={() => setDrawer(false)} />
      <aside className={cn('fixed inset-y-0 left-0 z-40 w-64 border-r border-border bg-surface transition-transform md:static md:z-auto md:translate-x-0', drawer ? 'translate-x-0' : '-translate-x-full')}>
        <MailSidebar mailboxes={mailboxes} current={mailboxParam} view={view} onCompose={() => { setDrawer(false); openCompose(); }} onNavigate={() => setDrawer(false)} />
      </aside>
      <section className={cn('min-h-0 w-full flex-col border-r border-border bg-bg md:flex md:w-[380px] md:shrink-0 lg:w-[420px]', threadId ? 'hidden' : 'flex')}>
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
          onOpen={openThread}
          onSearch={onSearch}
          onMenu={() => setDrawer(true)}
          onCompose={() => openCompose()}
          searchRef={searchRef}
        />
      </section>
      <section className={cn('min-h-0 min-w-0 flex-1 bg-bg', threadId ? 'block' : 'hidden md:block')}>
        {threadId ? (
          <ThreadView
            key={threadId}
            threadId={threadId}
            mailboxes={mailboxes}
            onBack={() => navigate(`${base}${suffix}`)}
            onSend={onSend}
            onOpenDraft={(s) => openCompose(s)}
            replyRequest={replyRequest}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon={<Inbox className="h-5 w-5" />} title="Select a conversation">
              <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
                Press <Kbd>c</Kbd> to compose, <Kbd>/</Kbd> to search, <Kbd>?</Kbd> for shortcuts.
              </span>
            </EmptyState>
          </div>
        )}
      </section>

      <div className="pointer-events-none fixed right-0 bottom-0 z-30 flex items-end gap-3 px-2 sm:right-4">
        {composers.map((c) => (
          <Composer key={c.key} initial={c} mailboxes={mailboxes} variant="floating" onClose={() => setComposers((cs) => cs.filter((x) => x.key !== c.key))} onSend={onSend} />
        ))}
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} mailboxes={mailboxes} onCompose={() => openCompose()} onSearch={onSearch} />
      <Dialog open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" size="md">
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={keys} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="text-muted">{label}</span>
              <Kbd>{keys}</Kbd>
            </div>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
