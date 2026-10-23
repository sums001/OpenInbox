import { useEffect, useMemo, useState } from 'react';
import {
  AlarmClock,
  Archive,
  ArrowLeft,
  Ban,
  ChevronDown,
  CircleCheck,
  CircleX,
  Clock,
  Download,
  Ellipsis,
  FileText,
  Forward,
  Inbox,
  MailOpen,
  Paperclip,
  Reply,
  ReplyAll,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Star,
  StickyNote,
  Tag,
  Trash,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { del, get, post, errorText } from '../../lib/api';
import { bytes, displayName, formatAddress, fullDate, listDate, timeAgo } from '../../lib/format';
import { forwardHtml, ownAddresses, quoteHtml, replyFrom, replyRecipients, snoozePresets } from '../../lib/mail';
import { splitQuoted, textToSafeHtml } from '../../lib/sanitize';
import { useSession, useUser } from '../../lib/session';
import { cn, storageGet } from '../../lib/utils';
import type { Mailbox, Message, ThreadDetail } from '../../lib/types';
import { LABEL_DOT } from './labels';
import { Button, IconButton } from '../../components/ui/button';
import { Avatar, Badge, PageSpinner } from '../../components/ui/misc';
import { Menu, MenuItem, MenuLabel, MenuSeparator, useToast } from '../../components/ui/overlay';
import { Textarea } from '../../components/ui/form';
import { MailFrame } from './MailFrame';
import { Composer, withSignature, type ComposeState, type SendRequest } from './Composer';
import { useThread, useThreadActions, type Action } from './data';
import { useQueryClient } from '@tanstack/react-query';

export function ThreadView({
  threadId,
  mailboxes,
  onBack,
  onSend,
  onOpenDraft,
  replyRequest,
}: {
  threadId: number;
  mailboxes: Mailbox[];
  onBack: () => void;
  onSend: (r: SendRequest) => void;
  onOpenDraft: (s: ComposeState) => void;
  replyRequest: { kind: 'reply' | 'replyAll' | 'forward'; nonce: number } | null;
}) {
  const { data, isLoading, error } = useThread(threadId);
  const act = useThreadActions();
  const toast = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const own = useMemo(() => ownAddresses(mailboxes), [mailboxes]);
  const mailbox = mailboxes.find((m) => m.id === data?.thread.mailboxId);
  const user = useUser();

  // Open the latest and unread messages; mark the thread read once shown.
  useEffect(() => {
    if (!data) return;
    const msgs = data.messages.filter((m) => m.status !== 'draft');
    setExpanded(new Set([...msgs.filter((m) => !m.isRead).map((m) => m.id), msgs[msgs.length - 1]?.id].filter(Boolean) as number[]));
    if (data.thread.unreadCount > 0) act([threadId], 'read').catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.thread.id]);

  useEffect(() => {
    setCompose(null);
  }, [threadId]);

  const startReply = (m: Message, kind: 'reply' | 'replyAll' | 'forward') => {
    if (!mailbox) return;
    const from = replyFrom(m, mailbox);
    const { to, cc } = kind === 'forward' ? { to: [], cc: [] } : replyRecipients(m, kind === 'replyAll', own);
    const body = kind === 'forward' ? forwardHtml(m) : quoteHtml(m);
    setCompose({
      key: `${kind}-${m.id}-${Date.now()}`,
      mailboxId: mailbox.id,
      from,
      to,
      cc,
      bcc: [],
      subject: kind === 'forward' ? (/^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`) : /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      html: withSignature(body, mailbox.signature),
      replyToMessageId: kind === 'forward' ? null : m.id,
      attachments: kind === 'forward' ? m.attachments.filter((a) => a.stored && !a.inline).map((a) => ({ key: `att-${a.id}`, attachmentId: a.id, filename: a.filename, size: a.size })) : [],
      title: kind === 'forward' ? 'Forward' : kind === 'replyAll' ? 'Reply all' : 'Reply',
    });
    setTimeout(() => document.getElementById('oi-reply')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  };

  // Keyboard shortcuts r / a / f come from the page.
  useEffect(() => {
    if (!replyRequest || !data) return;
    const last = [...data.messages].reverse().find((m) => m.status !== 'draft');
    if (last && data.canSend) startReply(last, replyRequest.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyRequest?.nonce]);

  if (isLoading) return <PageSpinner />;
  if (error || !data) return <div className="p-8 text-center text-sm text-muted">{error ? errorText(error) : 'Conversation not found.'}</div>;

  const t = data.thread;
  const run = (action: Action, opts: Parameters<typeof act>[2] = {}, label?: string, leave = true) => {
    act([t.id], action, opts)
      .then(() => {
        if (label)
          toast.success(label, ['archive', 'trash', 'spam', 'snooze'].includes(action) ? { label: 'Undo', onClick: () => act([t.id], action === 'snooze' ? 'unsnooze' : 'inbox') } : undefined);
      })
      .catch((e) => toast.error(errorText(e)));
    if (leave) onBack();
  };
  const labels = mailbox?.labels ?? [];
  const drafts = data.messages.filter((m) => m.status === 'draft');
  const messages = data.messages.filter((m) => m.status !== 'draft');
  const isShared = mailbox?.kind === 'shared';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-2 py-1.5 sm:px-3">
        <IconButton label="Back (u)" onClick={onBack} icon={<ArrowLeft className="h-4 w-4" />} />
        {t.folder !== 'inbox' || t.snoozedUntil ? (
          <IconButton label="Move to Inbox" onClick={() => run('inbox', {}, 'Moved to Inbox')} icon={<Inbox className="h-4 w-4" />} />
        ) : (
          <IconButton label="Archive (e)" onClick={() => run('archive', {}, 'Archived')} icon={<Archive className="h-4 w-4" />} />
        )}
        {t.folder === 'spam' ? (
          <IconButton label="Not spam" onClick={() => run('notspam', {}, 'Moved to Inbox')} icon={<ShieldCheck className="h-4 w-4" />} />
        ) : (
          <IconButton label="Report spam" onClick={() => run('spam', {}, 'Marked as spam')} icon={<ShieldAlert className="h-4 w-4" />} />
        )}
        {t.folder === 'trash' ? (
          <IconButton label="Delete forever" onClick={() => window.confirm('Delete this conversation forever?') && run('delete', {}, 'Deleted forever')} icon={<Trash className="h-4 w-4 text-danger" />} />
        ) : (
          <IconButton label="Delete (#)" onClick={() => run('trash', {}, 'Moved to Trash')} icon={<Trash className="h-4 w-4" />} />
        )}
        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton label="Mark unread" onClick={() => run('unread', {}, undefined)} icon={<MailOpen className="h-4 w-4" />} />
        <Menu
          align="start"
          trigger={({ onClick }) => <IconButton label="Snooze" onClick={onClick} icon={<AlarmClock className="h-4 w-4" />} />}
        >
          <MenuLabel>Snooze until…</MenuLabel>
          {snoozePresets().map((p) => (
            <MenuItem key={p.label} onClick={() => run('snooze', { until: p.at }, `Snoozed until ${listDate(p.at)}`)} hint={new Date(p.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}>
              {p.label}
            </MenuItem>
          ))}
          {t.snoozedUntil && (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => run('unsnooze', {}, 'Unsnoozed', false)}>Unsnooze</MenuItem>
            </>
          )}
        </Menu>
        {labels.length > 0 && (
          <Menu align="start" trigger={({ onClick }) => <IconButton label="Labels" onClick={onClick} icon={<Tag className="h-4 w-4" />} />}>
            <MenuLabel>Labels</MenuLabel>
            {labels.map((l) => {
              const on = t.labels.includes(l.id);
              return (
                <MenuItem key={l.id} icon={<span className={cn('block h-2.5 w-2.5 rounded-full', LABEL_DOT[l.color] ?? 'bg-faint')} />} hint={on ? '✓' : undefined} onClick={() => run(on ? 'unlabel' : 'label', { labelId: l.id }, undefined, false)}>
                  {l.name}
                </MenuItem>
              );
            })}
          </Menu>
        )}
        {isShared && <AssignMenu threadId={t.id} assignedTo={t.assignedTo} mailboxId={t.mailboxId} onAssign={(userId) => run('assign', { userId }, userId ? 'Assigned' : 'Unassigned', false)} />}
        <div className="flex-1" />
        <IconButton label={t.starred ? 'Unstar (s)' : 'Star (s)'} onClick={() => run(t.starred ? 'unstar' : 'star', {}, undefined, false)} icon={<Star className={cn('h-4 w-4', t.starred && 'fill-amber-400 text-amber-400')} />} />
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-3 py-5 sm:px-6">
          <div className="mb-4 flex flex-wrap items-start gap-2">
            <h1 className="min-w-0 flex-1 text-xl font-semibold leading-snug break-words">{t.subject || '(no subject)'}</h1>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {t.labels.map((id) => {
                const l = labels.find((x) => x.id === id);
                return l ? (
                  <Badge key={id}>
                    <span className={cn('h-2 w-2 rounded-full', LABEL_DOT[l.color])} />
                    {l.name}
                  </Badge>
                ) : null;
              })}
              {t.folder === 'spam' && <Badge tone="warning">Spam</Badge>}
              {t.snoozedUntil && (
                <Badge tone="primary">
                  <Clock className="h-3 w-3" /> Snoozed until {listDate(t.snoozedUntil)}
                </Badge>
              )}
              {mailbox && mailboxes.length > 1 && <Badge>{mailbox.address}</Badge>}
            </div>
          </div>

          <div className="space-y-3">
            {messages.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                own={own}
                expanded={expanded.has(m.id)}
                onToggle={() => setExpanded((s) => {
                  const n = new Set(s);
                  if (n.has(m.id)) n.delete(m.id);
                  else n.add(m.id);
                  return n;
                })}
                canSend={data.canSend}
                mailboxId={t.mailboxId}
                onReply={(kind) => startReply(m, kind)}
                onChanged={() => qc.invalidateQueries({ queryKey: ['thread', threadId] })}
              />
            ))}
          </div>

          {drafts.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() =>
                onOpenDraft({
                  key: `draft-${d.id}`,
                  draftId: d.id,
                  mailboxId: t.mailboxId,
                  from: d.from.address,
                  to: d.to,
                  cc: d.cc,
                  bcc: d.bcc,
                  subject: d.subject,
                  html: d.html ?? `<p>${d.text}</p>`,
                  replyToMessageId: null,
                  attachments: d.attachments.map((a) => ({ key: `a-${a.id}`, attachmentId: a.id, filename: a.filename, size: a.size })),
                  title: 'Draft',
                })
              }
              className="mt-3 flex w-full items-center gap-3 rounded-xl border border-dashed border-danger/40 bg-danger-soft/40 px-4 py-3 text-left"
            >
              <FileText className="h-4 w-4 text-danger" />
              <span className="text-[13px] font-medium text-danger">Draft</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{d.snippet || 'Empty draft'}</span>
              <span className="text-xs text-faint">{timeAgo(d.sentAt)}</span>
            </button>
          ))}

          {isShared && <Notes threadId={t.id} notes={data.notes} currentUserId={user?.id} />}

          <div id="oi-reply" className="mt-5">
            {compose ? (
              <Composer key={compose.key} initial={compose} mailboxes={mailboxes} variant="inline" onClose={() => setCompose(null)} onSend={onSend} />
            ) : (
              data.canSend &&
              messages.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <Button icon={<Reply className="h-4 w-4" />} onClick={() => startReply(messages[messages.length - 1], 'reply')}>
                    Reply
                  </Button>
                  <Button icon={<ReplyAll className="h-4 w-4" />} onClick={() => startReply(messages[messages.length - 1], 'replyAll')}>
                    Reply all
                  </Button>
                  <Button icon={<Forward className="h-4 w-4" />} onClick={() => startReply(messages[messages.length - 1], 'forward')}>
                    Forward
                  </Button>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AssignMenu({ assignedTo, mailboxId, onAssign }: { threadId: number; assignedTo: number | null; mailboxId: number; onAssign: (userId: number | null) => void }) {
  const [members, setMembers] = useState<{ userId: number; name: string; email: string }[] | null>(null);
  const user = useUser();
  return (
    <Menu
      align="start"
      trigger={({ onClick }) => (
        <IconButton
          label="Assign"
          onClick={() => {
            onClick();
            if (!members) get<{ members: { userId: number; name: string; email: string }[] }>(`/mailboxes/${mailboxId}/members`).then((r) => setMembers(r.members)).catch(() => setMembers([]));
          }}
          icon={<UserRound className={cn('h-4 w-4', assignedTo && 'text-primary')} />}
        />
      )}
    >
      <MenuLabel>Assign to</MenuLabel>
      {user && <MenuItem onClick={() => onAssign(user.id)} hint={assignedTo === user.id ? '✓' : undefined}>Me</MenuItem>}
      {(members ?? [])
        .filter((m) => m.userId !== user?.id)
        .map((m) => (
          <MenuItem key={m.userId} onClick={() => onAssign(m.userId)} hint={assignedTo === m.userId ? '✓' : undefined}>
            {m.name || m.email}
          </MenuItem>
        ))}
      {assignedTo && (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => onAssign(null)}>Unassign</MenuItem>
        </>
      )}
    </Menu>
  );
}

function Notes({ threadId, notes, currentUserId }: { threadId: number; notes: ThreadDetail['notes']; currentUserId?: number }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await post(`/threads/${threadId}/notes`, { body: text });
      setText('');
      qc.invalidateQueries({ queryKey: ['thread', threadId] });
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-5 rounded-xl border border-amber-300/50 bg-amber-50/60 p-4 dark:border-amber-500/20 dark:bg-amber-500/5">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-amber-800 dark:text-amber-300">
        <StickyNote className="h-4 w-4" /> Internal notes · only your team sees these
      </div>
      <div className="space-y-2">
        {notes.map((n) => (
          <div key={n.id} className="rounded-lg bg-surface/70 px-3 py-2 text-[13px]">
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="font-medium text-fg">{n.name}</span> {timeAgo(n.createdAt)}
              {n.userId === currentUserId && (
                <button type="button" className="ml-auto hover:text-danger" onClick={() => del(`/notes/${n.id}`).then(() => qc.invalidateQueries({ queryKey: ['thread', threadId] }))}>
                  Delete
                </button>
              )}
            </div>
            <div className="mt-0.5 whitespace-pre-wrap">{n.body}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note for your team…" className="min-h-10 bg-surface" rows={1} />
        <Button onClick={add} loading={busy} disabled={!text.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}

function AuthBadges({ m }: { m: Message }) {
  if (m.direction === 'out' || (!m.auth.spf && !m.auth.dkim && !m.auth.dmarc)) return null;
  const ok = m.auth.dmarc === 'pass' || (m.auth.dkim === 'pass' && m.auth.spf === 'pass');
  return (
    <span title={`SPF ${m.auth.spf ?? 'n/a'} · DKIM ${m.auth.dkim ?? 'n/a'} · DMARC ${m.auth.dmarc ?? 'n/a'}`} className={cn('inline-flex items-center gap-0.5 text-xs', ok ? 'text-success' : 'text-warning')}>
      {ok ? <ShieldCheck className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
      {ok ? 'Verified sender' : 'Unverified sender'}
    </span>
  );
}

function MessageItem({
  message: m,
  own,
  expanded,
  onToggle,
  canSend,
  mailboxId,
  onReply,
  onChanged,
}: {
  message: Message;
  own: Set<string>;
  expanded: boolean;
  onToggle: () => void;
  canSend: boolean;
  mailboxId: number;
  onReply: (kind: 'reply' | 'replyAll' | 'forward') => void;
  onChanged: () => void;
}) {
  const { data: session } = useSession();
  const toast = useToast();
  const trusted = storageGet<string[]>('oi.trusted', []);
  const [allowImages, setAllowImages] = useState(session?.remoteImages === 'allow' || trusted.includes(m.from.address) || m.direction === 'out');
  const [html, setHtml] = useState<string | null>(m.html);
  const [showQuoted, setShowQuoted] = useState(false);
  const [details, setDetails] = useState(false);
  const isMe = own.has(m.from.address.toLowerCase());

  useEffect(() => {
    if (expanded && m.htmlDeferred && html === null) get<{ html: string | null }>(`/messages/${m.id}/body`).then((b) => setHtml(b.html)).catch(() => undefined);
  }, [expanded, m.htmlDeferred, m.id, html]);

  const files = m.attachments.filter((a) => !a.inline || !a.contentId || !html?.includes(`cid:${a.contentId}`));
  const recipients = [...m.to, ...m.cc].map((a) => (own.has(a.address.toLowerCase()) ? 'me' : displayName(a))).join(', ');

  if (!expanded) {
    return (
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2">
        <Avatar name={m.from.name} address={m.from.address} size={28} />
        <span className={cn('w-40 shrink-0 truncate text-[13px]', !m.isRead ? 'font-semibold' : 'font-medium')}>{isMe ? 'me' : displayName(m.from)}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{m.snippet}</span>
        {m.attachments.some((a) => !a.inline) && <Paperclip className="h-3.5 w-3.5 shrink-0 text-faint" />}
        <span className="shrink-0 text-xs text-faint">{listDate(m.sentAt)}</span>
      </button>
    );
  }

  const unsubscribe = async () => {
    try {
      const r = await post<{ ok: boolean; method: string; url?: string | null }>(`/messages/${m.id}/unsubscribe`);
      if (r.method === 'link' && r.url) window.open(r.url, '_blank', 'noopener,noreferrer');
      else if (r.ok) toast.success('Unsubscribe request sent');
      else toast.error('The sender did not accept the request.');
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const text = splitQuoted(m.text);

  return (
    <article className="rounded-xl border border-border bg-surface shadow-card">
      {m.status === 'failed' && (
        <div className="flex flex-wrap items-center gap-2 rounded-t-xl border-b border-danger/30 bg-danger-soft px-4 py-2 text-[13px] text-danger">
          <CircleX className="h-4 w-4" />
          <span className="flex-1">Not sent: {m.error}</span>
          <Button size="xs" variant="danger" icon={<RotateCcw className="h-3 w-3" />} onClick={() => post<{ status: string; error?: string }>(`/messages/${m.id}/retry`).then((r) => { onChanged(); if (r.status === 'sent') toast.success('Sent'); else toast.error(r.error ?? 'Still failing'); })}>
            Retry
          </Button>
        </div>
      )}
      {m.status === 'scheduled' && m.sendAt && (
        <div className="flex flex-wrap items-center gap-2 rounded-t-xl border-b border-primary/20 bg-primary-soft px-4 py-2 text-[13px] text-primary">
          <Clock className="h-4 w-4" />
          <span className="flex-1">Scheduled for {fullDate(m.sendAt)}</span>
          <Button size="xs" onClick={() => post(`/messages/${m.id}/cancel-schedule`).then(() => { onChanged(); toast.success('Moved back to drafts'); })}>
            Cancel
          </Button>
        </div>
      )}
      {m.spamReason && (
        <div className="flex items-center gap-2 rounded-t-xl border-b border-warning/30 bg-warning-soft px-4 py-2 text-[13px] text-warning">
          <ShieldAlert className="h-4 w-4" /> {m.spamReason}. Be careful with links and attachments.
        </div>
      )}
      <header className="flex items-start gap-3 px-4 pt-4">
        <Avatar name={m.from.name} address={m.from.address} size={36} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onToggle}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold">{m.from.name || m.from.address}</span>
            {m.from.name && <span className="text-xs text-muted">{m.from.address}</span>}
            <AuthBadges m={m} />
          </div>
          <button type="button" onClick={(e) => { e.stopPropagation(); setDetails((d) => !d); }} className="flex items-center gap-0.5 text-xs text-muted hover:text-fg">
            to {recipients || 'undisclosed recipients'} <ChevronDown className="h-3 w-3" />
          </button>
          {details && (
            <dl className="mt-2 grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5 rounded-lg bg-surface-2 p-3 text-xs" onClick={(e) => e.stopPropagation()}>
              <dt className="text-muted">From</dt>
              <dd className="break-all">{formatAddress(m.from)}</dd>
              {m.replyTo && (
                <>
                  <dt className="text-muted">Reply-to</dt>
                  <dd className="break-all">{formatAddress(m.replyTo)}</dd>
                </>
              )}
              <dt className="text-muted">To</dt>
              <dd className="break-all">{m.to.map(formatAddress).join(', ') || '–'}</dd>
              {m.cc.length > 0 && (
                <>
                  <dt className="text-muted">Cc</dt>
                  <dd className="break-all">{m.cc.map(formatAddress).join(', ')}</dd>
                </>
              )}
              {m.bcc.length > 0 && (
                <>
                  <dt className="text-muted">Bcc</dt>
                  <dd className="break-all">{m.bcc.map(formatAddress).join(', ')}</dd>
                </>
              )}
              <dt className="text-muted">Date</dt>
              <dd>{fullDate(m.sentAt)}</dd>
              {m.deliveredTo && (
                <>
                  <dt className="text-muted">Delivered</dt>
                  <dd>{m.deliveredTo}</dd>
                </>
              )}
              {m.direction === 'in' && (
                <>
                  <dt className="text-muted">Security</dt>
                  <dd>
                    SPF {m.auth.spf ?? 'n/a'} · DKIM {m.auth.dkim ?? 'n/a'} · DMARC {m.auth.dmarc ?? 'n/a'}
                  </dd>
                </>
              )}
              {m.direction === 'out' && (
                <>
                  <dt className="text-muted">Status</dt>
                  <dd className="capitalize">{m.status}</dd>
                </>
              )}
            </dl>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-faint" title={fullDate(m.sentAt)}>
            {listDate(m.sentAt)}
          </span>
          {m.direction === 'out' && m.status === 'delivered' && <span title="Delivered"><CircleCheck className="h-3.5 w-3.5 text-success" /></span>}
          {m.direction === 'out' && (m.status === 'bounced' || m.status === 'complained') && <Badge tone="danger">{m.status}</Badge>}
          {canSend && <IconButton label="Reply" onClick={() => onReply('reply')} icon={<Reply className="h-4 w-4" />} />}
          <Menu trigger={({ onClick }) => <IconButton label="More" onClick={onClick} icon={<Ellipsis className="h-4 w-4" />} />}>
            {canSend && (
              <>
                <MenuItem icon={<Reply />} onClick={() => onReply('reply')}>Reply</MenuItem>
                <MenuItem icon={<ReplyAll />} onClick={() => onReply('replyAll')}>Reply all</MenuItem>
                <MenuItem icon={<Forward />} onClick={() => onReply('forward')}>Forward</MenuItem>
                <MenuSeparator />
              </>
            )}
            <MenuItem icon={<Download />} onClick={() => window.open(`/api/messages/${m.id}/raw`, '_blank')}>
              Download .eml {m.rawAvailable ? '' : '(rebuilt)'}
            </MenuItem>
            {m.listUnsubscribe && canSend && <MenuItem onClick={unsubscribe}>Unsubscribe</MenuItem>}
            {m.direction === 'in' && (
              <MenuItem
                icon={<Ban />}
                danger
                onClick={() =>
                  window.confirm(`Block ${m.from.address}? Future mail from them is rejected.`) &&
                  post('/blocked', { pattern: m.from.address, mailboxId }).then(() => toast.success(`Blocked ${m.from.address}`)).catch((e) => toast.error(errorText(e)))
                }
              >
                Block sender
              </MenuItem>
            )}
          </Menu>
        </div>
      </header>
      <div className="px-4 pt-3 pb-4 sm:pl-[64px]">
        {m.truncated && (
          <div className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            This message was too large to store in full. {m.rawAvailable ? 'Download the .eml from the menu to see all of it.' : ''}
          </div>
        )}
        {html ? (
          <MailFrame
            html={html}
            attachments={m.attachments}
            allowImages={allowImages}
            onAllowImages={() => setAllowImages(true)}
            onTrustSender={() => {
              const list = storageGet<string[]>('oi.trusted', []);
              localStorage.setItem('oi.trusted', JSON.stringify([...new Set([...list, m.from.address])]));
              post('/account/trusted-senders', { pattern: m.from.address }).catch(() => undefined);
              setAllowImages(true);
            }}
          />
        ) : m.htmlDeferred ? (
          <PageSpinner />
        ) : (
          <div>
            <div className="mail-text" dangerouslySetInnerHTML={{ __html: textToSafeHtml(text.main) }} />
            {text.quoted && (
              <>
                <button type="button" onClick={() => setShowQuoted((s) => !s)} className="mt-2 rounded bg-surface-2 px-2 text-xs text-muted hover:text-fg" title="Show quoted text">
                  •••
                </button>
                {showQuoted && <div className="mail-text mt-2 border-l-2 border-border pl-3 text-muted" dangerouslySetInnerHTML={{ __html: textToSafeHtml(text.quoted) }} />}
              </>
            )}
          </div>
        )}
        {files.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {files.map((a) =>
              a.stored ? (
                <a
                  key={a.id}
                  href={`/api/attachments/${a.id}`}
                  className="group flex max-w-64 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] transition-colors hover:border-primary"
                  title={`Download ${a.filename}`}
                >
                  <Paperclip className="h-4 w-4 shrink-0 text-muted group-hover:text-primary" />
                  <span className="min-w-0 flex-1 truncate">{a.filename || 'attachment'}</span>
                  <span className="shrink-0 text-xs text-faint">{bytes(a.size)}</span>
                </a>
              ) : (
                <span key={a.id} className="flex max-w-64 items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-[13px] text-muted" title="Not stored: attachments are off (text-only mode)">
                  <Paperclip className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{a.filename || 'attachment'}</span>
                  <span className="shrink-0 text-xs">{bytes(a.size)} · not stored</span>
                </span>
              ),
            )}
          </div>
        )}
      </div>
    </article>
  );
}
