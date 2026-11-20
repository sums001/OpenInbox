import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { get, post } from '../../lib/api';
import { viewQuery } from '../../lib/mail';
import type { Mailbox, ThreadDetail, ThreadSummary } from '../../lib/types';
import { storageGet } from '../../lib/utils';

export function useMailboxes() {
  return useQuery({ queryKey: ['mailboxes'], queryFn: () => get<Mailbox[]>('/mailboxes'), staleTime: 60_000 });
}

interface Page {
  threads: ThreadSummary[];
  nextCursor: string | null;
}

export function useThreads(mailbox: string, view: string, q: string) {
  return useInfiniteQuery({
    queryKey: ['threads', mailbox, view, q],
    queryFn: ({ pageParam }) =>
      view === 'search'
        ? get<{ threads: ThreadSummary[] }>(`/search?mailbox=${mailbox}&q=${encodeURIComponent(q)}`).then((r) => ({ threads: r.threads, nextCursor: null }) as Page)
        : get<Page>(`/threads?mailbox=${mailbox}&${viewQuery(view)}${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: view !== 'search' || q.trim().length > 0,
  });
}

export function useThread(id: number | null) {
  return useQuery({ queryKey: ['thread', id], queryFn: () => get<ThreadDetail>(`/threads/${id}`), enabled: !!id });
}

export type Action = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'inbox' | 'spam' | 'notspam' | 'trash' | 'delete' | 'snooze' | 'unsnooze' | 'label' | 'unlabel' | 'assign';

const REMOVES: Record<string, (view: string) => boolean> = {
  archive: (v) => v !== 'archive' && v !== 'allmail' && !v.startsWith('label-') && v !== 'sent' && v !== 'starred',
  inbox: (v) => v !== 'inbox' && v !== 'allmail',
  spam: () => true,
  notspam: (v) => v === 'spam',
  trash: (v) => v !== 'trash',
  delete: () => true,
  snooze: (v) => v === 'inbox',
  unsnooze: (v) => v === 'snoozed',
};

export type ActionOpts = { labelId?: number; until?: number; userId?: number | null };

// An action running over a whole view, shown above the list.
export interface BulkProgress {
  verb: string;
  done: number;
  total: number | null;
}

// Applies an action with an optimistic cache update, then refetches.
export function useThreadActions() {
  const qc = useQueryClient();
  return async (ids: number[], action: Action, opts: ActionOpts = {}) => {
    optimistic(qc, ids, action, opts);
    try {
      // The API takes up to 500 ids per request.
      for (let i = 0; i < ids.length; i += 500) await post('/threads/actions', { threadIds: ids.slice(i, i + 500), action, ...opts });
    } finally {
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['mailboxes'] });
      for (const id of ids) qc.invalidateQueries({ queryKey: ['thread', id] });
    }
  };
}

// How many conversations a whole view holds. Only asked for once everything loaded is selected.
export function useViewCount(mailbox: string, view: string, enabled: boolean) {
  return useQuery({
    queryKey: ['threads-count', mailbox, view],
    queryFn: () => get<{ count: number; capped: boolean }>(`/threads/count?mailbox=${mailbox}&${viewQuery(view)}`),
    enabled,
    staleTime: 30_000,
  });
}

// Applies an action to every conversation in a view, one server batch at a time. Returns how many
// conversations it changed; throws with `done` set when a batch fails part way.
export function useViewAction() {
  const qc = useQueryClient();
  return async (mailbox: string, view: string, action: Action, opts: ActionOpts = {}, onProgress?: (done: number) => void): Promise<number> => {
    const loaded = (qc.getQueryData<InfiniteData<Page>>(['threads', mailbox, view, ''])?.pages ?? []).flatMap((p) => p.threads.map((t) => t.id));
    optimistic(qc, loaded, action, opts);
    const label = view.startsWith('label-') ? Number(view.slice(6)) : undefined;
    let done = 0;
    let cursor: string | null = null;
    try {
      do {
        const r: { count: number; nextCursor: string | null } = await post('/threads/actions/view', {
          mailbox: mailbox === 'all' ? 'all' : Number(mailbox),
          view: label ? 'label' : view,
          label,
          cursor,
          action,
          ...opts,
        });
        done += r.count;
        cursor = r.nextCursor;
        onProgress?.(done);
      } while (cursor);
      return done;
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { done });
    } finally {
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['threads-count'] });
      qc.invalidateQueries({ queryKey: ['mailboxes'] });
      qc.invalidateQueries({ queryKey: ['thread'] });
    }
  };
}

// Updates every loaded list right away, so the change shows before the server answers.
function optimistic(qc: QueryClient, ids: number[], action: Action, opts: ActionOpts) {
  const lists = qc.getQueriesData<InfiniteData<Page>>({ queryKey: ['threads'] });
  for (const [key, data] of lists) {
    if (!data) continue;
    const view = String((key as unknown[])[2]);
    qc.setQueryData<InfiniteData<Page>>(key, {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        threads: p.threads
          .filter((t) => !(ids.includes(t.id) && REMOVES[action]?.(view)))
          .map((t) => {
            if (!ids.includes(t.id)) return t;
            if (action === 'read') return { ...t, unreadCount: 0 };
            if (action === 'unread') return { ...t, unreadCount: Math.max(1, t.unreadCount) };
            if (action === 'star' || action === 'unstar') return { ...t, starred: action === 'star' };
            if (action === 'label' && opts.labelId) return { ...t, labels: [...new Set([...t.labels, opts.labelId])] };
            if (action === 'unlabel' && opts.labelId) return { ...t, labels: t.labels.filter((l) => l !== opts.labelId) };
            return t;
          }),
      })),
    });
  }
}

// Polls the per-mailbox state counters (a few rows) and refreshes lists when something changed.
// Also raises a browser notification for new inbox mail while the tab is in the background.
export function useMailSync(mailboxes: Mailbox[] | undefined) {
  const qc = useQueryClient();
  const last = useRef<Record<string, number> | null>(null);
  const unreadRef = useRef<number>(0);
  useEffect(() => {
    unreadRef.current = (mailboxes ?? []).reduce((n, m) => n + (m.unread.inbox ?? 0), 0);
  }, [mailboxes]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const { states } = await get<{ states: Record<string, number> }>('/sync');
        const prev = last.current;
        last.current = states;
        if (prev && Object.keys(states).some((k) => states[k] !== prev[k])) {
          const before = unreadRef.current;
          await qc.invalidateQueries({ queryKey: ['mailboxes'] });
          qc.invalidateQueries({ queryKey: ['threads'] });
          qc.invalidateQueries({ queryKey: ['thread'] });
          const boxes = qc.getQueryData<Mailbox[]>(['mailboxes']) ?? [];
          const after = boxes.reduce((n, m) => n + (m.unread.inbox ?? 0), 0);
          if (after > before && document.hidden && storageGet('oi.notify', false) && 'Notification' in window && Notification.permission === 'granted') {
            const n = new Notification('New mail', { body: `${after - before} new conversation${after - before === 1 ? '' : 's'} in your inbox`, tag: 'openinbox-new-mail', icon: '/icon-192.png' });
            n.onclick = () => window.focus();
          }
        }
      } catch {
        // offline or signed out; the session handler deals with the latter
      }
      if (!stopped) timer = setTimeout(tick, document.hidden ? 60_000 : 20_000);
    };
    tick();
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [qc]);
}
