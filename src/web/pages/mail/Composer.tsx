import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import {
  Bold,
  CalendarClock,
  Check,
  ChevronDown,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Forward,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  Paperclip,
  Quote,
  Reply,
  SendHorizontal,
  Trash2,
  Underline,
  X,
} from 'lucide-react';
import { api, del, errorText, post, put } from '../../lib/api';
import { bytes } from '../../lib/format';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import type { Address, Mailbox } from '../../lib/types';
import { Button, IconButton } from '../../components/ui/button';
import { Input } from '../../components/ui/form';
import { Dialog, Menu, MenuItem, MenuLabel, MenuSeparator, useToast } from '../../components/ui/overlay';
import { Tooltip } from '../../components/ui/tooltip';
import { RecipientInput } from './RecipientInput';
import { PickTimeDialog } from './PickTimeDialog';

export interface ComposeAttachment {
  key: string;
  attachmentId?: number; // already on the draft, or an attachment of a forwarded message
  uploadId?: string;
  filename: string;
  size: number;
  progress?: number;
}

export interface ComposeState {
  key: string;
  mailboxId: number;
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  replyToMessageId?: number | null;
  attachments: ComposeAttachment[];
  draftId?: number;
  title?: string;
}

export interface SendRequest {
  state: ComposeState;
  draftId: number;
  sendAt?: number | null;
}

const SIGNATURE_MARK = 'data-oi-signature';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function withSignature(html: string, signature: string): string {
  const stripped = html.replace(new RegExp(`<div ${SIGNATURE_MARK}[^>]*>[\\s\\S]*?</div>(?![\\s\\S]*<div ${SIGNATURE_MARK})`), '');
  if (!signature.trim()) return stripped;
  const block = `<div ${SIGNATURE_MARK}="1"><p>-- </p>${signature}</div>`;
  // Above quoted history, like most clients.
  const quote = stripped.search(/<p>On .{4,200} wrote:<\/p><blockquote>|<p>---------- Forwarded message/);
  return quote >= 0 ? `${stripped.slice(0, quote)}${block}${stripped.slice(quote)}` : `${stripped}${block}`;
}

function Toolbar({ editor, onLink }: { editor: Editor | null; onLink: () => void }) {
  if (!editor) return null;
  const btn = (label: string, Icon: typeof Bold, active: boolean, run: () => void) => (
    <Tooltip key={label} content={label}>
      <button
        type="button"
        aria-label={label}
        onMouseDown={(e) => {
          e.preventDefault();
          run();
        }}
        className={cn('grid h-7 w-7 place-items-center rounded-md transition-colors', active ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}
      >
        <Icon className="h-[15px] w-[15px]" />
      </button>
    </Tooltip>
  );
  return (
    <>
      {btn('Bold (Ctrl+B)', Bold, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
      {btn('Italic (Ctrl+I)', Italic, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
      {btn('Underline (Ctrl+U)', Underline, editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run())}
      {btn('Bulleted list', List, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
      {btn('Numbered list', ListOrdered, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
      {btn('Quote', Quote, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
      {btn('Link', LinkIcon, editor.isActive('link'), onLink)}
    </>
  );
}

function fileIcon(name: string) {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'pdf') return <FileText className="h-3.5 w-3.5 shrink-0 text-danger" />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'].includes(ext)) return <FileImage className="h-3.5 w-3.5 shrink-0 text-primary-text" />;
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-success" />;
  if (['zip', 'gz', 'tar', 'rar', '7z'].includes(ext)) return <FileArchive className="h-3.5 w-3.5 shrink-0 text-warning" />;
  return <File className="h-3.5 w-3.5 shrink-0 text-muted" />;
}

const small = 'h-[26px] w-[26px] [&>svg]:h-3.5 [&>svg]:w-3.5';

export function Composer({
  initial,
  mailboxes,
  variant,
  onClose,
  onSend,
  onPopOut,
}: {
  initial: ComposeState;
  mailboxes: Mailbox[];
  variant: 'inline' | 'floating';
  onClose: () => void;
  onSend: (r: SendRequest) => void;
  // Inline only: continue this message in a floating composer.
  onPopOut?: (s: ComposeState) => void;
}) {
  const { data: session } = useSession();
  const toast = useToast();
  const sendable = useMemo(() => mailboxes.filter((m) => m.canSend), [mailboxes]);
  const fromOptions = useMemo(
    () => sendable.flatMap((m) => m.addresses.map((a) => ({ mailboxId: m.id, address: a.address, label: `${a.displayName || m.displayName || ''} <${a.address}>`.trim() }))),
    [sendable],
  );
  const [state, setState] = useState<ComposeState>(initial);
  const [showCc, setShowCc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const draftId = useRef<number | undefined>(initial.draftId);
  const dirty = useRef(false);
  const saving = useRef<Promise<number | undefined> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentsOn = session?.storageMode === 'r2';

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } } }), Placeholder.configure({ placeholder: 'Write your message…' })],
    content: initial.html,
    autofocus: variant === 'inline' ? 'start' : false,
    onUpdate: ({ editor: e }) => {
      dirty.current = true;
      // Read the HTML now: React runs updaters later, when this editor instance may already be
      // destroyed (StrictMode remounts it), and getHTML() on a destroyed editor throws.
      const html = e.getHTML();
      setState((s) => ({ ...s, html }));
    },
  });

  const update = (patch: Partial<ComposeState>) => {
    dirty.current = true;
    setState((s) => ({ ...s, ...patch }));
  };

  const payload = useCallback(
    (s: ComposeState) => ({
      mailboxId: s.mailboxId,
      from: s.from,
      to: s.to,
      cc: s.cc,
      bcc: s.bcc,
      subject: s.subject,
      html: s.html,
      text: editor?.getText({ blockSeparator: '\n\n' }),
      replyToMessageId: s.replyToMessageId ?? null,
      attachmentIds: s.attachments.filter((a) => a.attachmentId).map((a) => a.attachmentId!),
      uploadIds: s.attachments.filter((a) => a.uploadId && !a.attachmentId).map((a) => a.uploadId!),
    }),
    [editor],
  );

  const save = useCallback(
    async (s: ComposeState): Promise<number | undefined> => {
      if (saving.current) await saving.current.catch(() => undefined);
      const run = (async () => {
        setSaved('saving');
        try {
          type Saved = { id: number; attachments: { id: number; uploadId: string | null }[] };
          const r = draftId.current ? await put<Saved>(`/drafts/${draftId.current}`, payload(s)) : await post<Saved>('/drafts', payload(s));
          draftId.current = r.id;
          dirty.current = false;
          setSaved('saved');
          // Uploads are now attachments of the draft; remember their ids so later saves keep them.
          setState((cur) => ({
            ...cur,
            attachments: cur.attachments.map((a) => {
              const match = a.uploadId ? r.attachments.find((x) => x.uploadId === a.uploadId) : undefined;
              return match ? { ...a, attachmentId: match.id } : a;
            }),
          }));
          return r.id;
        } catch (e) {
          setSaved('error');
          throw e;
        }
      })();
      saving.current = run;
      try {
        return await run;
      } finally {
        saving.current = null;
      }
    },
    [payload],
  );

  // Autosave 1.5 s after the last change.
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => {
      if (state.to.length || state.subject || (editor && !editor.isEmpty)) save(state).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
  }, [state, save, editor]);

  const send = async (sendAt?: number | null) => {
    if (!state.to.length && !state.cc.length && !state.bcc.length) return toast.error('Add at least one recipient.');
    if (state.attachments.some((a) => a.progress !== undefined && a.progress < 100)) return toast.error('Wait for attachments to finish uploading.');
    if (!state.subject.trim() && !window.confirm('Send without a subject?')) return;
    try {
      const id = (dirty.current || !draftId.current ? await save(state) : draftId.current)!;
      onSend({ state: { ...state, draftId: id }, draftId: id, sendAt });
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const discard = async () => {
    if (draftId.current) await del(`/drafts/${draftId.current}`).catch(() => undefined);
    else for (const a of state.attachments) if (a.uploadId) await del(`/uploads/${a.uploadId}`).catch(() => undefined);
    onClose();
  };

  const close = async () => {
    if (dirty.current && (state.to.length || state.subject || (editor && !editor.isEmpty))) {
      await save(state).catch(() => undefined);
      toast.info('Draft saved');
    }
    onClose();
  };

  const upload = async (files: FileList | File[]) => {
    if (!attachmentsOn) return toast.error('Attachments are off. An admin can enable them in Admin > Integrations.');
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        toast.error(`${file.name} is larger than 20 MB.`);
        continue;
      }
      const key = `${Date.now()}-${file.name}`;
      setState((s) => ({ ...s, attachments: [...s.attachments, { key, filename: file.name, size: file.size, progress: 0 }] }));
      try {
        const r = await api<{ id: string }>('/uploads', { raw: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } });
        dirty.current = true;
        setState((s) => ({ ...s, attachments: s.attachments.map((a) => (a.key === key ? { ...a, uploadId: r.id, progress: 100 } : a)) }));
      } catch (e) {
        toast.error(`${file.name}: ${errorText(e)}`);
        setState((s) => ({ ...s, attachments: s.attachments.filter((a) => a.key !== key) }));
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
  };

  const changeFrom = (address: string) => {
    const opt = fromOptions.find((o) => o.address === address);
    if (!opt) return;
    const box = mailboxes.find((m) => m.id === opt.mailboxId);
    const html = withSignature(editor?.getHTML() ?? state.html, box?.signature ?? '');
    editor?.commands.setContent(html);
    update({ from: address, mailboxId: opt.mailboxId, html });
  };

  const applyLink = () => {
    if (!editor) return;
    if (!linkUrl) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: /^(https?:|mailto:)/i.test(linkUrl) ? linkUrl : `https://${linkUrl}` }).run();
    setLinkOpen(false);
    setLinkUrl('');
  };

  const presets = (() => {
    const d = new Date();
    const tomorrow8 = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8, 0);
    const tomorrow13 = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 13, 0);
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (((8 - d.getDay()) % 7) || 7), 8, 0);
    return [
      { label: 'Tomorrow morning', at: tomorrow8 },
      { label: 'Tomorrow afternoon', at: tomorrow13 },
      { label: 'Monday morning', at: monday },
    ];
  })();

  // Inline replies can move to a floating composer; the draft is saved first so nothing is lost.
  const popOut = async () => {
    if (!onPopOut) return;
    try {
      const id = dirty.current || !draftId.current ? await save(state) : draftId.current;
      onPopOut({ ...state, key: `pop-${id}-${Date.now()}`, draftId: id });
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const inline = variant === 'inline';
  const tight = inline ? 'h-7 w-7 [&>svg]:h-[15px] [&>svg]:w-[15px]' : undefined;
  const linkHandler = () => {
    setLinkUrl(editor?.getAttributes('link').href ?? '');
    setLinkOpen(true);
  };

  const ccToggle = !showCc && (
    <button type="button" className="shrink-0 text-[12.5px] text-faint hover:text-fg" onClick={() => setShowCc(true)}>
      Cc Bcc
    </button>
  );
  const fromRow = (!inline || fromOptions.length > 1) && (
    <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border px-4 text-[13px]">
      <span className="w-11 shrink-0 text-faint">From</span>
      <select value={state.from} onChange={(e) => changeFrom(e.target.value)} aria-label="From" className="select-chevron h-full min-w-0 flex-1 bg-transparent pr-6 outline-none [background-position:right_0_center]">
        {fromOptions.map((o) => (
          <option key={o.address} value={o.address}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
  const attachmentList = state.attachments.length > 0 && (
    <div className="flex flex-wrap gap-2 px-4 pb-3">
      {state.attachments.map((a) => {
        const uploading = a.progress !== undefined && a.progress < 100;
        return (
          <span key={a.key} className={cn('relative inline-flex h-8 max-w-full items-center gap-2 overflow-hidden rounded-lg border border-border pr-1.5 pl-2.5 text-[12.5px]', uploading ? 'bg-surface-2' : 'bg-surface')}>
            {fileIcon(a.filename)}
            <span className="max-w-48 truncate">{a.filename}</span>
            <span className="shrink-0 text-faint">{uploading ? 'Uploading…' : bytes(a.size)}</span>
            <button
              type="button"
              className="grid h-5 w-5 place-items-center rounded text-faint hover:bg-surface-2 hover:text-fg"
              onClick={() => {
                if (a.uploadId && !a.attachmentId) del(`/uploads/${a.uploadId}`).catch(() => undefined);
                update({ attachments: state.attachments.filter((x) => x.key !== a.key) });
              }}
              aria-label="Remove attachment"
            >
              <X className="h-[13px] w-[13px]" />
            </button>
            {uploading && <span className="absolute bottom-0 left-0 h-0.5 w-3/5 animate-pulse bg-primary" />}
          </span>
        );
      })}
    </div>
  );
  const sendButton = (
    <div className={cn('flex shrink-0 rounded-lg bg-primary text-[13px] font-medium text-primary-fg shadow-card', inline ? 'h-8' : 'h-[34px]')}>
      <button type="button" onClick={() => send()} className={cn('flex items-center gap-[7px] rounded-l-lg hover:bg-primary-hover', inline ? 'px-3' : 'px-3.5')}>
        <SendHorizontal className="h-3.5 w-3.5" />
        Send
      </button>
      <span className="w-px bg-white/20" />
      <Menu
        align="start"
        className="bottom-full mb-1 w-[280px]"
        trigger={({ onClick, open }) => (
          <button type="button" onClick={onClick} className={cn('grid h-full place-items-center rounded-r-lg hover:bg-primary-hover', inline ? 'w-7' : 'w-[30px]', open && 'bg-primary-hover')} aria-label="Send later">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      >
        <MenuLabel>Send later</MenuLabel>
        {presets.map((p) => (
          <MenuItem key={p.label} onClick={() => send(p.at.getTime())} hint={p.at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}>
            {p.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<CalendarClock />} onClick={() => setScheduleOpen(true)}>
          Pick date and time…
        </MenuItem>
      </Menu>
    </div>
  );
  const attachButton = (
    <IconButton
      label={attachmentsOn ? 'Attach files' : 'Attachments are off (enable R2 in Admin)'}
      disabled={!attachmentsOn}
      onClick={() => fileInput.current?.click()}
      icon={<Paperclip />}
      className={tight}
    />
  );
  const status = (
    <span className="mr-1.5 flex items-center gap-[5px] text-xs text-faint">
      {saved === 'saved' && <Check className="h-3 w-3" />}
      {saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : saved === 'error' ? <span className="text-danger">Not saved</span> : null}
    </span>
  );
  const discardButton = <IconButton label="Discard draft" onClick={discard} icon={<Trash2 />} className={tight} />;

  const frame = (children: ReactNode, className: string) => (
    <div
      className={cn('flex min-h-0 flex-col', dragging && 'ring-2 ring-primary ring-inset', className)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          send();
        }
      }}
    >
      {children}
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
      <Dialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Insert link"
        size="sm"
        footer={
          <>
            <Button onClick={() => setLinkOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={applyLink}>
              Apply
            </Button>
          </>
        }
      >
        <div className="relative">
          <LinkIcon className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://example.com" className="pl-8" onKeyDown={(e) => e.key === 'Enter' && applyLink()} />
        </div>
      </Dialog>
      <PickTimeDialog
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        title="Send later"
        description="Sent within a minute of the chosen time, even with OpenInbox closed."
        confirmLabel="Schedule send"
        onPick={(at) => send(at)}
      />
    </div>
  );

  if (inline) {
    const KindIcon = state.title === 'Forward' ? Forward : Reply;
    return frame(
      <>
        <div className="flex min-h-11 items-start gap-2 border-b border-border pr-3 pl-4">
          <KindIcon className="mt-[14px] h-[15px] w-[15px] shrink-0 text-faint" />
          <RecipientInput label="To" value={state.to} onChange={(to) => update({ to })} autoFocus={!state.to.length} bare trailing={ccToggle} />
          {onPopOut && <IconButton label="Open in a window" onClick={popOut} icon={<Maximize2 />} className={cn('mt-[9px]', small)} />}
        </div>
        {showCc && (
          <>
            <RecipientInput label="Cc" value={state.cc} onChange={(cc) => update({ cc })} />
            <RecipientInput label="Bcc" value={state.bcc} onChange={(bcc) => update({ bcc })} />
          </>
        )}
        {fromRow}
        <div className="editor editor-compact scroll-thin max-h-[50vh] min-h-0 overflow-y-auto">
          <EditorContent editor={editor} />
        </div>
        {attachmentList}
        <div className="flex flex-wrap items-center gap-0.5 border-t border-border px-3 py-2">
          {sendButton}
          <span className="mx-2 h-[18px] w-px bg-border max-sm:hidden" />
          <div className="flex items-center max-sm:hidden">
            <Toolbar editor={editor} onLink={linkHandler} />
          </div>
          {attachButton}
          <div className="flex-1" />
          {status}
          {discardButton}
        </div>
      </>,
      'rounded-xl border border-border-strong bg-surface shadow-pop',
    );
  }

  const heading = state.title ?? 'New message';
  if (minimized)
    return (
      <div
        className="pointer-events-auto flex h-10 w-[280px] max-w-full cursor-pointer items-center gap-1 rounded-t-[10px] border border-b-0 border-border-strong bg-surface pr-1.5 pl-3.5 text-[13px] shadow-pop"
        onClick={() => setMinimized(false)}
      >
        <span className="min-w-0 flex-1 truncate font-semibold">
          {draftId.current ? 'Draft' : heading}
          {state.subject && <span className="font-normal text-muted"> · {state.subject}</span>}
        </span>
        <IconButton
          label="Expand"
          onClick={(e) => {
            e.stopPropagation();
            setMinimized(false);
            setExpanded(true);
          }}
          icon={<Maximize2 />}
          className={small}
        />
        <IconButton
          label="Close"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
          icon={<X />}
          className={small}
        />
      </div>
    );

  return frame(
    <>
      <div className="flex h-[42px] shrink-0 items-center gap-1 border-b border-border pr-2 pl-4 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-semibold">{heading}</span>
        <IconButton label="Minimize" onClick={() => setMinimized(true)} icon={<Minus />} className={small} />
        <IconButton label={expanded ? 'Shrink' : 'Expand'} onClick={() => setExpanded((x) => !x)} icon={expanded ? <Minimize2 /> : <Maximize2 />} className={small} />
        <IconButton label="Close" onClick={close} icon={<X />} className={small} />
      </div>
      {fromRow}
      <RecipientInput label="To" value={state.to} onChange={(to) => update({ to })} autoFocus={!state.to.length} trailing={ccToggle} />
      {showCc && (
        <>
          <RecipientInput label="Cc" value={state.cc} onChange={(cc) => update({ cc })} />
          <RecipientInput label="Bcc" value={state.bcc} onChange={(bcc) => update({ bcc })} />
        </>
      )}
      <input
        value={state.subject}
        onChange={(e) => update({ subject: e.target.value })}
        placeholder="Subject"
        aria-label="Subject"
        className="h-10 shrink-0 border-b border-border bg-transparent px-4 text-[13px] font-medium outline-none placeholder:font-normal placeholder:text-faint"
      />
      <div className="flex h-[38px] shrink-0 items-center gap-px border-b border-border px-2.5">
        <Toolbar editor={editor} onLink={linkHandler} />
      </div>
      <div className={cn('editor scroll-thin min-h-0 flex-1 overflow-y-auto', !expanded && 'max-h-[40vh]')}>
        <EditorContent editor={editor} />
      </div>
      {attachmentList}
      <div className="flex shrink-0 items-center gap-0.5 border-t border-border px-3 py-2.5">
        {sendButton}
        <span className="mx-2.5 font-mono text-[11px] font-medium text-faint max-sm:hidden">{isMac ? '⌘↵' : 'Ctrl ↵'}</span>
        {attachButton}
        <div className="flex-1" />
        {status}
        {discardButton}
      </div>
    </>,
    cn(
      'pointer-events-auto border border-border-strong bg-surface shadow-pop animate-slide-up',
      expanded ? 'fixed inset-2 z-40 rounded-xl sm:inset-10' : 'max-h-[85vh] w-screen rounded-t-xl border-b-0 sm:w-[560px]',
    ),
  );
}
