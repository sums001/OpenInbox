import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  Archive,
  ArrowLeft,
  Ban,
  CalendarClock,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  CircleX,
  Clock,
  Download,
  Ellipsis,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Forward,
  Inbox,
  Info,
  Lock,
  Mail,
  MailOpen,
  OctagonAlert,
  Paperclip as PaperclipIcon,
  Pencil,
  Reply,
  ReplyAll,
  RotateCw,
  ShieldCheck,
  Star,
  StickyNote,
  Tag,
  Trash2,
  TriangleAlert,
  UserCheck,
  UserRound,
} from 'lucide-react';
import { del, get, post, errorText } from '../../lib/api';
import { bytes, displayName, formatAddress, fullDate, listDate, timeAgo } from '../../lib/format';
import { forwardHtml, ownAddresses, quoteHtml, replyFrom, replyRecipients, snoozePresets } from '../../lib/mail';
import { splitQuoted, textToSafeHtml } from '../../lib/sanitize';
import { useSession, useUser } from '../../lib/session';
import { cn, storageGet } from '../../lib/utils';
import type { Attachment, Mailbox, Message, ThreadDetail } from '../../lib/types';
import { labelChip, labelDot } from './labels';
import { Button, IconButton } from '../../components/ui/button';
import { Avatar, Badge, PageSpinner } from '../../components/ui/misc';
import { ConfirmDialog, Menu, MenuItem, MenuLabel, MenuSeparator, useToast } from '../../components/ui/overlay';
import { Textarea } from '../../components/ui/form';
import { Tooltip } from '../../components/ui/tooltip';
import { MailFrame } from './MailFrame';
import { Composer, withSignature, type ComposeState, type SendRequest } from './Composer';
import { PickTimeDialog } from './PickTimeDialog';
import { useThread, useThreadActions, type Action } from './data';

type ReplyKind = 'reply' | 'replyAll' | 'forward';

export interface ThreadNav {
  index: number;
  total: number;
  prev?: () => void;
  next?: () => void;
}

const sep = <span className="mx-1.5 h-[18px] w-px shrink-0 bg-border" />;
const mobileIcon = 'h-11 w-11 [&>svg]:h-[19px] [&>svg]:w-[19px]';

function timeHint(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function useMembers(mailboxId: number, enabled: boolean) {
  return useQuery({
    queryKey: ['members', mailboxId],
    queryFn: () => get<{ members: { userId: number; name: string; email: string }[] }>(`/mailboxes/${mailboxId}/members`).then((r) => r.members),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function ThreadView({
  threadId,
  mailboxes,
  onBack,
  onSend,
  onOpenDraft,
  replyRequest,
  nav,
}: {
  threadId: number;
  mailboxes: Mailbox[];
  onBack: () => void;
  onSend: (r: SendRequest) => void;
  onOpenDraft: (s: ComposeState) => void;
  replyRequest: { kind: ReplyKind; nonce: number } | null;
  nav?: ThreadNav;
}) {
  const { data, isLoading, error } = useThread(threadId);
  const act = useThreadActions();
  const toast = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [pickSnooze, setPickSnooze] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  const startReply = (m: Message, kind: ReplyKind) => {
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
  const last = messages[messages.length - 1];
  const inInbox = t.folder === 'inbox' && !t.snoozedUntil;

  const archiveButton = (cls?: string) =>
    inInbox ? (
      <IconButton label="Archive" shortcut="E" onClick={() => run('archive', {}, 'Archived')} icon={<Archive />} className={cls} />
    ) : (
      <IconButton label="Move to Inbox" onClick={() => run('inbox', {}, 'Moved to Inbox')} icon={<Inbox />} className={cls} />
    );
  const deleteButton = (cls?: string) =>
    t.folder === 'trash' ? (
      <IconButton label="Delete forever" onClick={() => setConfirmDelete(true)} icon={<Trash2 className="text-danger" />} className={cls} />
    ) : (
      <IconButton label="Delete" shortcut="#" onClick={() => run('trash', {}, 'Moved to Trash')} icon={<Trash2 />} className={cls} />
    );
  const snoozeMenu = (mobile?: boolean) => (
    <Menu
      align={mobile ? 'end' : 'start'}
      className="w-[250px]"
      trigger={({ onClick, open }) =>
        mobile ? (
          <IconButton label="Snooze" onClick={onClick} icon={<AlarmClock />} className={mobileIcon} />
        ) : (
          <Tooltip content="Snooze">
            <button type="button" onClick={onClick} aria-label="Snooze" className={cn('flex h-[30px] items-center gap-[3px] rounded-[7px] px-1.5 text-muted hover:bg-surface-2 hover:text-fg', open && 'bg-surface-2 text-fg')}>
              <AlarmClock className="h-4 w-4" />
              <ChevronDown className="h-3 w-3 text-faint" />
            </button>
          </Tooltip>
        )
      }
    >
      <MenuLabel>Snooze until</MenuLabel>
      {snoozePresets().map((p) => (
        <MenuItem key={p.label} onClick={() => run('snooze', { until: p.at }, `Snoozed until ${listDate(p.at)}`)} hint={timeHint(p.at)}>
          {p.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<CalendarClock />} onClick={() => setPickSnooze(true)}>
        Pick date and time…
      </MenuItem>
      {t.snoozedUntil && <MenuItem onClick={() => run('unsnooze', {}, 'Unsnoozed', false)}>Unsnooze</MenuItem>}
    </Menu>
  );
  const labelItems = labels.map((l) => {
    const on = t.labels.includes(l.id);
    return (
      <MenuItem key={l.id} icon={<span className="mx-[3.5px] block h-2 w-2 rounded-full" style={labelDot(l.color)} />} checked={on} onClick={() => run(on ? 'unlabel' : 'label', { labelId: l.id }, undefined, false)}>
        {l.name}
      </MenuItem>
    );
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Desktop toolbar */}
      <div className="hidden h-12 shrink-0 items-center gap-0.5 border-b border-border px-3 md:flex">
        <IconButton label="Back" shortcut="U" onClick={onBack} icon={<ArrowLeft />} />
        {sep}
        {archiveButton()}
        {t.folder === 'spam' ? (
          <IconButton label="Not spam" onClick={() => run('notspam', {}, 'Moved to Inbox')} icon={<ShieldCheck />} />
        ) : (
          <IconButton label="Report spam" shortcut="!" onClick={() => run('spam', {}, 'Marked as spam')} icon={<OctagonAlert />} />
        )}
        {deleteButton()}
        {sep}
        <IconButton label="Mark unread" shortcut="⇧U" onClick={() => run('unread', {}, undefined)} icon={<Mail />} />
        {snoozeMenu()}
        {labels.length > 0 && (
          <Menu
            align="start"
            trigger={({ onClick, open }) => (
              <Tooltip content="Labels">
                <button type="button" onClick={onClick} aria-label="Labels" className={cn('flex h-[30px] items-center gap-[3px] rounded-[7px] px-1.5 text-muted hover:bg-surface-2 hover:text-fg', open && 'bg-surface-2 text-fg')}>
                  <Tag className="h-4 w-4" />
                  <ChevronDown className="h-3 w-3 text-faint" />
                </button>
              </Tooltip>
            )}
          >
            <MenuLabel>Labels</MenuLabel>
            {labelItems}
          </Menu>
        )}
        {isShared && <AssignMenu assignedTo={t.assignedTo} mailboxId={t.mailboxId} onAssign={(userId) => run('assign', { userId }, userId ? 'Assigned' : 'Unassigned', false)} />}
        <div className="flex-1" />
        {nav && nav.total > 1 && (
          <>
            <span className="mr-1 text-xs text-faint tabular-nums">
              {nav.index + 1} of {nav.total}
            </span>
            <IconButton label="Previous" shortcut="K" onClick={nav.prev} disabled={!nav.prev} icon={<ChevronUp />} />
            <IconButton label="Next" shortcut="J" onClick={nav.next} disabled={!nav.next} icon={<ChevronDown />} />
            {sep}
          </>
        )}
        <IconButton label={t.starred ? 'Unstar' : 'Star'} shortcut="S" onClick={() => run(t.starred ? 'unstar' : 'star', {}, undefined, false)} icon={<Star className={cn(t.starred && 'fill-[oklch(0.78_0.16_78)] text-[oklch(0.78_0.16_78)]')} />} />
      </div>

      {/* Mobile toolbar: 44px targets, the rest in More */}
      <div className="flex shrink-0 items-center border-b border-border px-2 py-1 md:hidden">
        <IconButton label="Back" onClick={onBack} icon={<ArrowLeft className="text-fg" />} className={mobileIcon} />
        <div className="flex-1" />
        {archiveButton(mobileIcon)}
        {deleteButton(mobileIcon)}
        {snoozeMenu(true)}
        {isShared && <AssignMenu mobile assignedTo={t.assignedTo} mailboxId={t.mailboxId} onAssign={(userId) => run('assign', { userId }, userId ? 'Assigned' : 'Unassigned', false)} />}
        <Menu trigger={({ onClick }) => <IconButton label="More" onClick={onClick} icon={<Ellipsis />} className={mobileIcon} />}>
          <MenuItem icon={<Star />} onClick={() => run(t.starred ? 'unstar' : 'star', {}, undefined, false)}>
            {t.starred ? 'Unstar' : 'Star'}
          </MenuItem>
          <MenuItem icon={<Mail />} onClick={() => run('unread', {}, undefined)}>
            Mark unread
          </MenuItem>
          {t.folder === 'spam' ? (
            <MenuItem icon={<ShieldCheck />} onClick={() => run('notspam', {}, 'Moved to Inbox')}>
              Not spam
            </MenuItem>
          ) : (
            <MenuItem icon={<OctagonAlert />} onClick={() => run('spam', {}, 'Marked as spam')}>
              Report spam
            </MenuItem>
          )}
          {labels.length > 0 && (
            <>
              <MenuSeparator />
              <MenuLabel>Labels</MenuLabel>
              {labelItems}
            </>
          )}
        </Menu>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[860px] flex-col gap-3 px-3.5 pt-[18px] pb-10 md:px-9 md:pt-7">
          <div className="px-1 pb-2 md:px-0.5">
            <h1 className="text-xl leading-[1.3] font-semibold tracking-[-0.02em] break-words text-pretty md:text-[22px]">{t.subject || '(no subject)'}</h1>
            {(t.labels.length > 0 || t.folder === 'spam' || t.snoozedUntil || (mailbox && mailboxes.length > 1)) && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {t.labels.map((id) => {
                  const l = labels.find((x) => x.id === id);
                  return l ? (
                    <span key={id} className="label-chip inline-flex h-[22px] items-center gap-1.5 rounded-md px-2 text-xs font-medium" style={labelChip(l.color)}>
                      <span className="h-[7px] w-[7px] rounded-full" style={labelDot(l.color)} />
                      {l.name}
                    </span>
                  ) : null;
                })}
                {t.folder === 'spam' && (
                  <Badge tone="warning">
                    <OctagonAlert /> Spam
                  </Badge>
                )}
                {t.snoozedUntil && (
                  <Badge tone="primary">
                    <Clock /> Snoozed until {listDate(t.snoozedUntil)} {new Date(t.snoozedUntil).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </Badge>
                )}
                {mailbox && mailboxes.length > 1 && (
                  <Badge>
                    <Inbox /> {mailbox.address}
                  </Badge>
                )}
              </div>
            )}
          </div>

          {messages.length > 0 && (
            <div className="rounded-xl border border-border bg-surface shadow-card">
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  own={own}
                  expanded={expanded.has(m.id)}
                  onToggle={() =>
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(m.id)) n.delete(m.id);
                      else n.add(m.id);
                      return n;
                    })
                  }
                  canSend={data.canSend}
                  mailboxId={t.mailboxId}
                  onReply={(kind) => startReply(m, kind)}
                  onChanged={() => qc.invalidateQueries({ queryKey: ['thread', threadId] })}
                />
              ))}
            </div>
          )}

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
              className="flex h-[42px] w-full items-center gap-2.5 rounded-[10px] border border-dashed border-[color-mix(in_oklch,var(--danger)_45%,transparent)] bg-[color-mix(in_oklch,var(--danger-soft)_60%,transparent)] px-4 text-left text-[13px] transition-colors hover:bg-danger-soft"
            >
              <Pencil className="h-3.5 w-3.5 text-danger" />
              <span className="font-semibold text-danger">Draft</span>
              <span className="text-faint">·</span>
              <span className="min-w-0 flex-1 truncate text-muted">{d.snippet || 'Empty draft'}</span>
              <span className="text-xs text-faint">{timeAgo(d.sentAt)}</span>
            </button>
          ))}

          {isShared && <Notes threadId={t.id} notes={data.notes} currentUserId={user?.id} />}

          <div id="oi-reply">
            {compose ? (
              <Composer key={compose.key} initial={compose} mailboxes={mailboxes} variant="inline" onClose={() => setCompose(null)} onSend={onSend} onPopOut={onOpenDraft} />
            ) : (
              data.canSend &&
              last && (
                <div className="hidden gap-2 pt-1 md:flex">
                  {(
                    [
                      ['reply', 'Reply', <Reply />, 'R'],
                      ['replyAll', 'Reply all', <ReplyAll />, 'A'],
                      ['forward', 'Forward', <Forward />, 'F'],
                    ] as [ReplyKind, string, ReactNode, string][]
                  ).map(([kind, label, icon, key]) => (
                    <Button key={kind} icon={icon} onClick={() => startReply(last, kind)} className="px-3 [&>svg]:h-[15px] [&>svg]:w-[15px] [&>svg]:text-muted">
                      {label}
                      <span aria-hidden className="font-mono text-[11px] font-medium text-faint">
                        {key}
                      </span>
                    </Button>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      </div>

      {/* Mobile reply bar */}
      {!compose && data.canSend && last && (
        <div className="grid shrink-0 grid-cols-3 gap-2 border-t border-border bg-surface px-3.5 pt-2.5 pb-[max(env(safe-area-inset-bottom),10px)] md:hidden">
          <Button variant="primary" size="lg" className="justify-center" icon={<Reply className="h-4 w-4" />} onClick={() => startReply(last, 'reply')}>
            Reply
          </Button>
          <Button size="lg" className="justify-center bg-surface-2" icon={<ReplyAll className="h-4 w-4" />} onClick={() => startReply(last, 'replyAll')}>
            All
          </Button>
          <Button size="lg" className="justify-center bg-surface-2" icon={<Forward className="h-4 w-4" />} onClick={() => startReply(last, 'forward')}>
            Forward
          </Button>
        </div>
      )}

      <PickTimeDialog
        open={pickSnooze}
        onClose={() => setPickSnooze(false)}
        title="Snooze until"
        description="The conversation leaves the inbox and comes back at this time."
        confirmLabel="Snooze"
        onPick={(at) => run('snooze', { until: at }, `Snoozed until ${listDate(at)}`)}
      />
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} icon={<Trash2 />} danger title="Delete this conversation forever?" confirmLabel="Delete forever" onConfirm={() => run('delete', {}, 'Deleted forever')}>
        Every message in it is removed. This can't be undone.
      </ConfirmDialog>
    </div>
  );
}

function AssignMenu({ assignedTo, mailboxId, onAssign, mobile }: { assignedTo: number | null; mailboxId: number; onAssign: (userId: number | null) => void; mobile?: boolean }) {
  const [wanted, setWanted] = useState(false);
  const user = useUser();
  // Names are needed to label someone else's assignment, or once the menu opens.
  const members = useMembers(mailboxId, wanted || (!!assignedTo && assignedTo !== user?.id));
  const assignee = assignedTo === user?.id ? 'Me' : members.data?.find((m) => m.userId === assignedTo)?.name?.split(' ')[0];
  return (
    <Menu
      align={mobile ? 'end' : 'start'}
      trigger={({ onClick, open }) => {
        const click = () => {
          onClick();
          setWanted(true);
        };
        if (mobile) return <IconButton label="Assign" onClick={click} icon={<UserCheck className={cn(assignedTo && 'text-primary-text')} />} className={mobileIcon} />;
        return assignedTo ? (
          <Tooltip content="Assign">
            <button type="button" onClick={click} className="ml-0.5 flex h-[30px] items-center gap-1.5 rounded-[7px] bg-primary-soft pr-2 pl-1.5 text-[12.5px] font-medium text-primary-text">
              <UserCheck className="h-[15px] w-[15px]" />
              {assignee ?? 'Assigned'}
              <ChevronDown className="h-3 w-3 opacity-70" />
            </button>
          </Tooltip>
        ) : (
          <Tooltip content="Assign">
            <button type="button" onClick={click} aria-label="Assign" className={cn('flex h-[30px] items-center gap-[3px] rounded-[7px] px-1.5 text-muted hover:bg-surface-2 hover:text-fg', open && 'bg-surface-2 text-fg')}>
              <UserRound className="h-4 w-4" />
              <ChevronDown className="h-3 w-3 text-faint" />
            </button>
          </Tooltip>
        );
      }}
    >
      <MenuLabel>Assign to</MenuLabel>
      {user && (
        <MenuItem onClick={() => onAssign(user.id)} checked={assignedTo === user.id}>
          Me
        </MenuItem>
      )}
      {(members.data ?? [])
        .filter((m) => m.userId !== user?.id)
        .map((m) => (
          <MenuItem key={m.userId} onClick={() => onAssign(m.userId)} checked={assignedTo === m.userId}>
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
    <div className="rounded-xl border border-[color-mix(in_oklch,var(--warning)_28%,transparent)] bg-warning-soft px-4 py-3.5">
      <div className="flex items-center gap-2 text-[13px]">
        <StickyNote className="h-[15px] w-[15px] text-warning" />
        <span className="font-semibold">Internal notes</span>
        <span className="text-muted">· only your team sees these</span>
        <Lock className="ml-auto h-[13px] w-[13px] text-warning" />
      </div>
      {notes.length > 0 && (
        <div className="mt-3.5 flex flex-col gap-3">
          {notes.map((n) => (
            <div key={n.id} className="flex gap-2.5">
              <Avatar name={n.name} address={n.name} size={24} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-[12.5px]">
                  <span className="font-semibold">
                    {n.name}
                    {n.userId === currentUserId && <span className="font-normal text-muted"> (you)</span>}
                  </span>
                  <span className="text-faint">{timeAgo(n.createdAt)}</span>
                  {n.userId === currentUserId && (
                    <button type="button" className="ml-auto text-xs text-muted hover:text-danger" onClick={() => del(`/notes/${n.id}`).then(() => qc.invalidateQueries({ queryKey: ['thread', threadId] }))}>
                      Delete
                    </button>
                  )}
                </div>
                <div className="text-[13px] leading-[1.55] whitespace-pre-wrap text-pretty">{n.body}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') add();
          }}
          placeholder="Add a note for your team…"
          className="min-h-[38px] border-[color-mix(in_oklch,var(--warning)_22%,var(--border))] py-2"
          rows={1}
        />
        <Button onClick={add} loading={busy} disabled={!text.trim()} className="h-[38px]">
          Add
        </Button>
      </div>
    </div>
  );
}

function authOk(m: Message): boolean {
  return m.auth.dmarc === 'pass' || (m.auth.dkim === 'pass' && m.auth.spf === 'pass');
}

function AuthBadge({ m }: { m: Message }) {
  if (m.direction === 'out' || (!m.auth.spf && !m.auth.dkim && !m.auth.dmarc)) return null;
  const ok = authOk(m);
  const rows: [string, string | null][] = [
    ['SPF', m.auth.spf],
    ['DKIM', m.auth.dkim],
    ['DMARC', m.auth.dmarc],
  ];
  return (
    <Tooltip
      rich
      content={
        <div className="flex w-44 flex-col gap-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span>{k}</span>
              <span className={cn('font-semibold', v && v !== 'pass' && v !== 'none' && 'text-[oklch(0.8_0.15_60)]')}>{v ?? 'n/a'}</span>
            </div>
          ))}
        </div>
      }
    >
      <span tabIndex={0} className={cn('inline-flex h-5 items-center gap-1 rounded-full pr-[7px] pl-[5px] text-[11.5px] font-medium', ok ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning')}>
        {ok ? <ShieldCheck className="h-3 w-3" /> : <TriangleAlert className="h-3 w-3" />}
        {ok ? 'Verified sender' : 'Unverified sender'}
      </span>
    </Tooltip>
  );
}

// File-type tile for attachment chips.
function fileKind(a: Attachment): { Icon: typeof File; cls: string; label: string } {
  const ext = (a.filename.split('.').pop() ?? '').toLowerCase();
  const type = a.contentType.toLowerCase();
  const label = (ext && ext.length <= 4 ? ext : type.split('/')[1] ?? 'file').toUpperCase();
  if (type === 'application/pdf' || ext === 'pdf') return { Icon: FileText, cls: 'bg-danger-soft text-danger', label };
  if (type.startsWith('image/')) return { Icon: FileImage, cls: 'bg-primary-soft text-primary-text', label };
  if (/sheet|excel|csv/.test(type) || ['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return { Icon: FileSpreadsheet, cls: 'bg-success-soft text-success', label };
  if (/zip|compressed|tar|rar|7z/.test(type) || ['zip', 'gz', 'tar', 'rar', '7z'].includes(ext)) return { Icon: FileArchive, cls: 'bg-warning-soft text-warning', label };
  if (type.startsWith('text/') || /word|document/.test(type)) return { Icon: FileText, cls: 'bg-surface-2 text-muted', label };
  return { Icon: File, cls: 'bg-surface-2 text-muted', label };
}

function AttachmentChip({ a }: { a: Attachment }) {
  const { Icon, cls, label } = fileKind(a);
  const name = a.filename || 'attachment';
  if (!a.stored)
    return (
      <span className="flex h-[46px] max-w-full items-center gap-2.5 rounded-[10px] border border-dashed border-border-strong pr-3.5 pl-1.5 text-muted max-md:w-full" title="Not stored: attachments are off (text-only mode)">
        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[7px] bg-surface-2 text-faint">
          <Icon className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13px] font-medium">{name}</span>
          <span className="text-[11.5px] text-faint">{bytes(a.size)} · not stored</span>
        </span>
      </span>
    );
  return (
    <a
      href={`/api/attachments/${a.id}`}
      className="group flex h-[46px] max-w-full items-center gap-2.5 rounded-[10px] border border-border bg-surface pr-3.5 pl-1.5 transition-shadow hover:border-primary hover:ring-3 hover:ring-primary-soft max-md:w-full md:max-w-72"
      title={`Download ${name}`}
    >
      <span className={cn('grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[7px]', cls)}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-medium">{name}</span>
        <span className="text-[11.5px] text-faint">
          {label} · {bytes(a.size)}
        </span>
      </span>
      <Download className="ml-1.5 h-[15px] w-[15px] shrink-0 text-primary-text opacity-0 transition-opacity group-hover:opacity-100 max-md:text-muted max-md:opacity-100" />
    </a>
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
  onReply: (kind: ReplyKind) => void;
  onChanged: () => void;
}) {
  const { data: session } = useSession();
  const toast = useToast();
  const trusted = storageGet<string[]>('oi.trusted', []);
  const [allowImages, setAllowImages] = useState(session?.remoteImages === 'allow' || trusted.includes(m.from.address) || m.direction === 'out');
  const [html, setHtml] = useState<string | null>(m.html);
  const [showQuoted, setShowQuoted] = useState(false);
  const [details, setDetails] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const isMe = own.has(m.from.address.toLowerCase());

  useEffect(() => {
    if (expanded && m.htmlDeferred && html === null) get<{ html: string | null }>(`/messages/${m.id}/body`).then((b) => setHtml(b.html)).catch(() => undefined);
  }, [expanded, m.htmlDeferred, m.id, html]);

  const files = m.attachments.filter((a) => !a.inline || !a.contentId || !html?.includes(`cid:${a.contentId}`));
  const recipients = [...m.to, ...m.cc].map((a) => (own.has(a.address.toLowerCase()) ? 'me' : displayName(a).split(' ')[0])).join(', ');
  const delivered = m.direction === 'out' && m.status === 'delivered';
  const section = 'group/msg border-b border-border last:border-b-0';

  if (!expanded) {
    return (
      <button type="button" onClick={onToggle} className={cn(section, 'flex h-[52px] w-full items-center gap-3 px-4 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-surface-2 md:px-5')}>
        <Avatar name={m.from.name} address={m.from.address} size={28} />
        <span className={cn('w-[110px] shrink-0 truncate text-[13px] md:w-[130px]', !m.isRead ? 'font-semibold' : 'font-medium')}>{isMe ? 'me' : displayName(m.from)}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-faint">{m.snippet}</span>
        {m.attachments.some((a) => !a.inline) && <PaperclipIcon className="h-[13px] w-[13px] shrink-0 text-faint" />}
        <span className="flex shrink-0 items-center gap-1 text-xs text-faint tabular-nums">
          {delivered && <CheckCheck className="h-3.5 w-3.5 text-success" />}
          {listDate(m.sentAt)}
        </span>
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
  const recent = Date.now() - m.sentAt < 86_400_000;
  const banner = 'flex flex-wrap items-center gap-2.5 border-b py-2.5 pr-3 pl-4 text-[13px] group-first/msg:rounded-t-xl';

  return (
    <article className={section}>
      {m.status === 'failed' && (
        <div className={cn(banner, 'border-danger/20 bg-danger-soft text-danger')}>
          <CircleX className="h-[15px] w-[15px]" />
          <span className="flex-1 font-medium">Not sent: {m.error}</span>
          <Button
            size="xs"
            className="border-danger/30 text-fg"
            icon={<RotateCw />}
            onClick={() =>
              post<{ status: string; error?: string }>(`/messages/${m.id}/retry`).then((r) => {
                onChanged();
                if (r.status === 'sent') toast.success('Message sent');
                else toast.error(r.error ?? 'Still failing');
              })
            }
          >
            Retry
          </Button>
        </div>
      )}
      {m.status === 'scheduled' && m.sendAt && (
        <div className={cn(banner, 'border-primary/25 bg-primary-soft text-primary-text')}>
          <CalendarClock className="h-[15px] w-[15px]" />
          <span className="flex-1 font-medium">Scheduled for {fullDate(m.sendAt)}</span>
          <Button
            size="xs"
            onClick={() =>
              post(`/messages/${m.id}/cancel-schedule`).then(() => {
                onChanged();
                toast.success('Moved back to drafts');
              })
            }
          >
            Cancel
          </Button>
        </div>
      )}
      {m.spamReason && (
        <div className={cn(banner, 'border-warning/20 bg-warning-soft text-warning')}>
          <TriangleAlert className="h-[15px] w-[15px]" />
          <span className="font-medium">{m.spamReason}. Be careful with links and attachments.</span>
        </div>
      )}
      <header className="flex items-start gap-3 px-4 pt-4 pb-1.5 md:px-5 md:pt-[18px]">
        <Avatar name={m.from.name} address={m.from.address} size={36} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onToggle}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold">{m.from.name || m.from.address}</span>
            {m.from.name && <span className="truncate text-[12.5px] text-faint max-md:hidden">{m.from.address}</span>}
            <span onClick={(e) => e.stopPropagation()}>
              <AuthBadge m={m} />
            </span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDetails((d) => !d);
            }}
            className={cn('mt-px flex max-w-full items-center gap-[3px] text-[12.5px] hover:text-fg', details ? 'text-fg' : 'text-muted')}
          >
            <span className="truncate">to {recipients || 'undisclosed recipients'}</span>
            {details ? <ChevronUp className="h-3 w-3 shrink-0 text-faint" /> : <ChevronDown className="h-3 w-3 shrink-0 text-faint" />}
          </button>
        </div>
        <div className="flex h-7 shrink-0 items-center gap-0.5">
          {m.status === 'scheduled' ? (
            <span className="mr-1.5 text-[12.5px] text-muted">Not sent yet</span>
          ) : (
            <span className="mr-1.5 text-[12.5px] text-muted tabular-nums" title={fullDate(m.sentAt)}>
              {listDate(m.sentAt)}
              {recent && <span className="text-faint max-lg:hidden"> ({timeAgo(m.sentAt)})</span>}
            </span>
          )}
          {delivered && (
            <span title="Delivered" className="mr-1">
              <CheckCheck className="h-3.5 w-3.5 text-success" />
            </span>
          )}
          {m.direction === 'out' && (m.status === 'bounced' || m.status === 'complained') && (
            <Badge tone="danger" pill className="mr-1 capitalize">
              {m.status}
            </Badge>
          )}
          {canSend && <IconButton label="Reply" shortcut="R" onClick={() => onReply('reply')} icon={<Reply />} className="h-7 w-7 max-md:hidden [&>svg]:h-[15px] [&>svg]:w-[15px]" />}
          <Menu className="w-[230px]" trigger={({ onClick }) => <IconButton label="More" onClick={onClick} icon={<Ellipsis />} className="h-7 w-7 [&>svg]:h-[15px] [&>svg]:w-[15px]" />}>
            {canSend && (
              <>
                <MenuItem icon={<Reply />} onClick={() => onReply('reply')} hint="R">
                  Reply
                </MenuItem>
                <MenuItem icon={<ReplyAll />} onClick={() => onReply('replyAll')} hint="A">
                  Reply all
                </MenuItem>
                <MenuItem icon={<Forward />} onClick={() => onReply('forward')} hint="F">
                  Forward
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            <MenuItem icon={<Download />} onClick={() => window.open(`/api/messages/${m.id}/raw`, '_blank')}>
              Download .eml {m.rawAvailable ? '' : '(rebuilt)'}
            </MenuItem>
            {m.listUnsubscribe && canSend && (
              <MenuItem icon={<MailOpen />} onClick={unsubscribe}>
                Unsubscribe
              </MenuItem>
            )}
            {m.direction === 'in' && (
              <>
                <MenuSeparator />
                <MenuItem icon={<Ban />} danger onClick={() => setConfirmBlock(true)}>
                  Block sender
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </header>
      {details && (
        <dl className="mx-4 mb-[18px] grid max-w-[460px] grid-cols-[84px_1fr] gap-x-2 gap-y-1.5 rounded-lg bg-surface-2 px-3.5 py-3 text-[12.5px] md:mr-5 md:ml-[68px]">
          <dt className="text-faint">From</dt>
          <dd className="break-all">{formatAddress(m.from)}</dd>
          {m.replyTo && (
            <>
              <dt className="text-faint">Reply-to</dt>
              <dd className="break-all">{formatAddress(m.replyTo)}</dd>
            </>
          )}
          <dt className="text-faint">To</dt>
          <dd className="break-all">{m.to.map(formatAddress).join(', ') || '–'}</dd>
          {m.cc.length > 0 && (
            <>
              <dt className="text-faint">Cc</dt>
              <dd className="break-all">{m.cc.map(formatAddress).join(', ')}</dd>
            </>
          )}
          {m.bcc.length > 0 && (
            <>
              <dt className="text-faint">Bcc</dt>
              <dd className="break-all">{m.bcc.map(formatAddress).join(', ')}</dd>
            </>
          )}
          <dt className="text-faint">Date</dt>
          <dd>{fullDate(m.sentAt)}</dd>
          {m.deliveredTo && (
            <>
              <dt className="text-faint">Delivered</dt>
              <dd className="break-all">{m.deliveredTo}</dd>
            </>
          )}
          {m.direction === 'in' && (
            <>
              <dt className="text-faint">Security</dt>
              <dd className={authOk(m) ? 'text-success' : 'text-warning'}>
                SPF {m.auth.spf ?? 'n/a'} · DKIM {m.auth.dkim ?? 'n/a'} · DMARC {m.auth.dmarc ?? 'n/a'}
              </dd>
            </>
          )}
          {m.direction === 'out' && (
            <>
              <dt className="text-faint">Status</dt>
              <dd className="capitalize">{m.status}</dd>
            </>
          )}
        </dl>
      )}
      <div className="px-4 pt-1.5 pb-5 md:pr-7 md:pl-[68px]">
        {m.truncated && (
          <div className="mb-3 flex items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 text-[12.5px] text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
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
          <div className="max-w-[680px]">
            <div className="mail-text text-pretty" dangerouslySetInnerHTML={{ __html: textToSafeHtml(text.main) }} />
            {text.quoted && (
              <>
                <button
                  type="button"
                  onClick={() => setShowQuoted((s) => !s)}
                  className="mt-3 h-4 rounded-full border border-border bg-surface-2 px-2 text-[11px] leading-3 tracking-[1px] text-muted hover:text-fg"
                  aria-label={showQuoted ? 'Hide quoted text' : 'Show quoted text'}
                >
                  •••
                </button>
                {showQuoted && <div className="mail-text mt-2 border-l-2 border-border pl-3 text-muted" dangerouslySetInnerHTML={{ __html: textToSafeHtml(text.quoted) }} />}
              </>
            )}
          </div>
        )}
        {files.length > 0 && (
          <div className="mt-[18px] flex flex-wrap gap-2">
            {files.map((a) => (
              <AttachmentChip key={a.id} a={a} />
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmBlock}
        onClose={() => setConfirmBlock(false)}
        icon={<Ban />}
        danger
        title={`Block ${m.from.address}?`}
        confirmLabel="Block sender"
        onConfirm={() => {
          setConfirmBlock(false);
          post('/blocked', { pattern: m.from.address, mailboxId })
            .then(() => toast.success(`Blocked ${m.from.address}`))
            .catch((e) => toast.error(errorText(e)));
        }}
      >
        Future mail from them is rejected.
      </ConfirmDialog>
    </article>
  );
}
