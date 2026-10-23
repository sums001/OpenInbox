import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import {
  Bold,
  CalendarClock,
  ChevronDown,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Paperclip,
  Quote,
  Redo2,
  Send,
  Strikethrough,
  Trash,
  Underline,
  Undo2,
  X,
} from 'lucide-react';
import { api, del, errorText, post, put } from '../../lib/api';
import { bytes } from '../../lib/format';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import type { Address, Mailbox } from '../../lib/types';
import { Button, IconButton } from '../../components/ui/button';
import { Input } from '../../components/ui/form';
import { Dialog, Menu, MenuItem, MenuSeparator, useToast } from '../../components/ui/overlay';
import { RecipientInput } from './RecipientInput';

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
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => {
        e.preventDefault();
        run();
      }}
      className={cn('rounded p-1.5 transition-colors', active ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1">
      {btn('Bold (Ctrl+B)', Bold, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
      {btn('Italic (Ctrl+I)', Italic, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
      {btn('Underline (Ctrl+U)', Underline, editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run())}
      {btn('Strikethrough', Strikethrough, editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run())}
      <span className="mx-1 h-4 w-px bg-border" />
      {btn('Bulleted list', List, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
      {btn('Numbered list', ListOrdered, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
      {btn('Quote', Quote, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
      {btn('Link', LinkIcon, editor.isActive('link'), onLink)}
      <span className="mx-1 h-4 w-px bg-border" />
      {btn('Undo', Undo2, false, () => editor.chain().focus().undo().run())}
      {btn('Redo', Redo2, false, () => editor.chain().focus().redo().run())}
    </div>
  );
}

export function Composer({
  initial,
  mailboxes,
  variant,
  onClose,
  onSend,
}: {
  initial: ComposeState;
  mailboxes: Mailbox[];
  variant: 'inline' | 'floating';
  onClose: () => void;
  onSend: (r: SendRequest) => void;
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
  const [scheduleAt, setScheduleAt] = useState('');
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

  const body = (
    <div
      className={cn('flex min-h-0 flex-col', dragging && 'ring-2 ring-primary ring-inset')}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          send();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="w-10 shrink-0 text-[13px] text-muted">From</span>
        <select value={state.from} onChange={(e) => changeFrom(e.target.value)} className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none">
          {fromOptions.map((o) => (
            <option key={o.address} value={o.address}>
              {o.label}
            </option>
          ))}
        </select>
        {!showCc && (
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setShowCc(true)}>
            Cc Bcc
          </button>
        )}
      </div>
      <RecipientInput label="To" value={state.to} onChange={(to) => update({ to })} autoFocus={variant === 'floating' && !state.to.length} />
      {showCc && (
        <>
          <RecipientInput label="Cc" value={state.cc} onChange={(cc) => update({ cc })} />
          <RecipientInput label="Bcc" value={state.bcc} onChange={(bcc) => update({ bcc })} />
        </>
      )}
      <input value={state.subject} onChange={(e) => update({ subject: e.target.value })} placeholder="Subject" className="border-b border-border bg-transparent px-3 py-2 text-sm font-medium outline-none" />
      <Toolbar editor={editor} onLink={() => { setLinkUrl(editor?.getAttributes('link').href ?? ''); setLinkOpen(true); }} />
      <div className={cn('editor scroll-thin min-h-0 flex-1 overflow-y-auto text-sm', variant === 'floating' && !expanded && 'max-h-[40vh]')}>
        <EditorContent editor={editor} />
      </div>
      {state.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
          {state.attachments.map((a) => (
            <span key={a.key} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs">
              <Paperclip className="h-3.5 w-3.5 text-muted" />
              <span className="max-w-40 truncate">{a.filename}</span>
              <span className="text-faint">{a.progress !== undefined && a.progress < 100 ? 'uploading…' : bytes(a.size)}</span>
              <button
                type="button"
                className="text-faint hover:text-fg"
                onClick={() => {
                  if (a.uploadId && !a.attachmentId) del(`/uploads/${a.uploadId}`).catch(() => undefined);
                  update({ attachments: state.attachments.filter((x) => x.key !== a.key) });
                }}
                aria-label="Remove attachment"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2">
        <div className="flex">
          <Button variant="primary" size="sm" icon={<Send className="h-3.5 w-3.5" />} onClick={() => send()} className="rounded-r-none">
            Send
          </Button>
          <Menu
            align="start"
            trigger={({ onClick }) => (
              <Button variant="primary" size="sm" onClick={onClick} className="rounded-l-none border-l border-white/20 px-1.5" aria-label="Send later">
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            )}
            className="bottom-full mb-1"
          >
            {presets.map((p) => (
              <MenuItem key={p.label} icon={<CalendarClock />} onClick={() => send(p.at.getTime())} hint={p.at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}>
                {p.label}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={() => setScheduleOpen(true)}>Pick date and time…</MenuItem>
          </Menu>
        </div>
        <IconButton
          label={attachmentsOn ? 'Attach files' : 'Attachments are off (enable R2 in Admin)'}
          disabled={!attachmentsOn}
          onClick={() => fileInput.current?.click()}
          icon={<Paperclip className="h-4 w-4" />}
        />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        <div className="flex-1 text-right text-xs text-faint">{saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Draft saved' : saved === 'error' ? 'Not saved' : ''}</div>
        <IconButton label="Discard draft" onClick={discard} icon={<Trash className="h-4 w-4" />} />
      </div>
      <Dialog open={linkOpen} onClose={() => setLinkOpen(false)} title="Link" size="sm" footer={<><Button variant="ghost" onClick={() => setLinkOpen(false)}>Cancel</Button><Button variant="primary" onClick={applyLink}>Apply</Button></>}>
        <Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://example.com" onKeyDown={(e) => e.key === 'Enter' && applyLink()} />
      </Dialog>
      <Dialog
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        title="Send later"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!scheduleAt || new Date(scheduleAt).getTime() < Date.now() + 60_000} onClick={() => { setScheduleOpen(false); send(new Date(scheduleAt).getTime()); }}>
              Schedule
            </Button>
          </>
        }
      >
        <Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
        <p className="mt-2 text-xs text-muted">Sent within a minute of the chosen time, even with OpenInbox closed.</p>
      </Dialog>
    </div>
  );

  if (variant === 'inline') {
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5">
          <span className="text-[13px] font-medium">{state.title ?? 'Reply'}</span>
          <IconButton label="Close" onClick={close} icon={<X className="h-4 w-4" />} />
        </div>
        {body}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'pointer-events-auto flex flex-col overflow-hidden rounded-t-xl border border-border bg-surface shadow-pop',
        expanded ? 'fixed inset-4 z-40 rounded-xl sm:inset-10' : 'w-full sm:w-[560px]',
        minimized ? 'h-11' : !expanded && 'max-h-[85vh]',
      )}
    >
      <div className="flex shrink-0 cursor-pointer items-center gap-2 bg-fg px-3 py-2 text-bg" onClick={() => setMinimized((m) => !m)}>
        <span className="flex-1 truncate text-[13px] font-medium">{state.subject || state.title || 'New message'}</span>
        <button type="button" onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); setMinimized(false); }} className="opacity-70 hover:opacity-100" aria-label={expanded ? 'Shrink' : 'Expand'}>
          {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        <button type="button" onClick={(e) => { e.stopPropagation(); close(); }} className="opacity-70 hover:opacity-100" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      {!minimized && body}
    </div>
  );
}
