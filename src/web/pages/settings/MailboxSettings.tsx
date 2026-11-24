import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { zipSync } from 'fflate';
import { CalendarClock, Download, FileUp, Funnel, PenLine, Plus, Tag, Trash, Forward, Archive } from 'lucide-react';
import { del, get, patch, post, put, api, ApiError, errorText } from '../../lib/api';
import { useAction, useInvalidate } from '../../lib/hooks';
import { cleanSignature } from '../../lib/sanitize';
import { cn, downloadBlob } from '../../lib/utils';
import { streamMbox, formatMboxEntry, parseGmailLabels } from '../../lib/mbox';
import { LABEL_COLORS } from '../../../shared/constants';
import type { Label, Mailbox } from '../../lib/types';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input, Select, Switch, Textarea } from '../../components/ui/form';
import { Alert, Card, CardHeader, EmptyState, PageHeader, PageSpinner } from '../../components/ui/misc';
import { Dialog } from '../../components/ui/overlay';
import { labelChip, labelDot } from '../mail/labels';

interface BoxSettings {
  signature: string;
  autoReply: { enabled: boolean; subject: string; body: string; startAt?: number | null; endAt?: number | null } | null;
  forwardTo: string[];
  displayName: string;
  destinations: { address: string; verified: boolean }[];
}

interface Filter {
  id: number;
  name: string;
  conditions: { match?: 'all' | 'any'; from?: string; to?: string; subject?: string; body?: string; hasAttachment?: boolean; isList?: boolean };
  actions: { labelIds?: number[]; folder?: 'inbox' | 'archive' | 'spam' | 'trash'; markRead?: boolean; star?: boolean; forwardTo?: string; neverSpam?: boolean };
  enabled: boolean;
}

export type MailSection = 'signature' | 'auto-reply' | 'forwarding' | 'labels' | 'filters' | 'import-export';

export const MAIL_SECTIONS: { id: MailSection; label: string; description: string }[] = [
  { id: 'signature', label: 'Signature', description: 'Your sender name and the signature added to new messages and replies.' },
  { id: 'auto-reply', label: 'Auto-reply', description: "Answer incoming mail automatically, for example while you're away. Each sender gets it at most once every 4 days; mailing lists never do." },
  { id: 'forwarding', label: 'Forwarding', description: 'Keep a copy here and forward every message to another address. Forwarding goes through Cloudflare, not your sending quota.' },
  { id: 'labels', label: 'Labels', description: 'Organize conversations. Filters can apply labels automatically.' },
  { id: 'filters', label: 'Filters', description: 'Rules applied to new mail as it arrives, in order.' },
  { id: 'import-export', label: 'Import & export', description: 'Import mail from Google Takeout (.mbox) or .eml files, or export your inbox as .mbox or .zip.' },
];

// One mail section for one inbox. The inbox comes from ?inbox= so the choice survives switching
// sections.
export function MailboxSettings({ section }: { section: MailSection }) {
  const boxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => get<Mailbox[]>('/mailboxes') });
  const [params, setParams] = useSearchParams();
  const meta = MAIL_SECTIONS.find((s) => s.id === section)!;
  if (boxes.isLoading) return <PageSpinner />;
  if (!boxes.data?.length) return <EmptyState title="No inboxes">Ask an admin to give you access to an inbox.</EmptyState>;
  const box = boxes.data.find((b) => b.id === Number(params.get('inbox'))) ?? boxes.data[0];
  return (
    <div className="space-y-6">
      <PageHeader
        title={meta.label}
        description={meta.description}
        actions={
          boxes.data.length > 1 && (
            <Select value={box.id} onChange={(e) => setParams({ inbox: e.target.value }, { replace: true })} className="min-w-64" aria-label="Inbox">
              {boxes.data.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.address}
                </option>
              ))}
            </Select>
          )
        }
      />
      {section === 'signature' && <Signature box={box} key={box.id} />}
      {section === 'auto-reply' && <AutoReply box={box} key={box.id} />}
      {section === 'forwarding' && <Forwarding box={box} key={box.id} />}
      {section === 'labels' && <Labels box={box} key={box.id} />}
      {section === 'filters' && <Filters box={box} key={box.id} />}
      {section === 'import-export' && <ImportExport box={box} key={box.id} />}
    </div>
  );
}

function useBoxSettings(box: Mailbox, watchPending = false) {
  const q = useQuery({
    queryKey: ['box-settings', box.id],
    queryFn: () => get<BoxSettings>(`/mailboxes/${box.id}/settings`),
    // Forwarding: the owner of a new address clicks the verification link in another tab or app.
    refetchOnWindowFocus: watchPending ? (query) => !!query.state.data?.destinations.some((d) => !d.verified) : false,
  });
  const [s, setS] = useState<BoxSettings | null>(null);
  const { run, busy } = useAction();
  const invalidate = useInvalidate();
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  const save = (key: string, body: Partial<BoxSettings>, msg: string) =>
    run(key, () => patch(`/mailboxes/${box.id}/settings`, body).then(() => invalidate(['box-settings', box.id], ['mailboxes'])), msg);
  return { s, setS, save, busy };
}

function Signature({ box }: { box: Mailbox }) {
  const { s, setS, save, busy } = useBoxSettings(box);
  if (!s) return <PageSpinner />;
  return (
    <Card>
      <CardHeader icon={<PenLine className="h-5 w-5" />} title="Name and signature" description={box.canSend ? undefined : 'You can read this inbox but not send from it.'} />
      <div className="space-y-4 p-5">
        <Field label="Sender name">
          <Input value={s.displayName} onChange={(e) => setS({ ...s, displayName: e.target.value })} disabled={!box.canSend} />
        </Field>
        <Field label="Signature" hint="Plain text or HTML, such as a signature from a generator. Tables, images, links and styles are kept; scripts and positioning are removed.">
          <Textarea value={s.signature} onChange={(e) => setS({ ...s, signature: e.target.value })} rows={4} className="font-mono text-[13px]" disabled={!box.canSend} />
        </Field>
        {s.signature && (
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium">Preview</div>
            <div className="rounded-lg border border-border bg-surface-2 p-3 text-[13px]" dangerouslySetInnerHTML={{ __html: cleanSignature(s.signature) }} />
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!box.canSend} loading={busy === 'sig'} onClick={() => save('sig', { displayName: s.displayName, signature: cleanSignature(s.signature) }, 'Saved')}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

function AutoReply({ box }: { box: Mailbox }) {
  const { s, setS, save, busy } = useBoxSettings(box);
  if (!s) return <PageSpinner />;
  const reply = s.autoReply ?? { enabled: false, subject: '', body: '' };
  const toLocal = (ms?: number | null) => (ms ? new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
  return (
    <Card>
      <CardHeader
        icon={<CalendarClock className="h-5 w-5" />}
        title="Send an automatic reply"
        description={reply.enabled ? 'On. Save to apply your changes.' : 'Off'}
        action={<Switch checked={reply.enabled} onChange={(v) => setS({ ...s, autoReply: { ...reply, enabled: v } })} disabled={!box.canSend} label="Auto-reply" />}
      />
      <div className="space-y-4 p-5">
        <Field label="Subject" hint="Leave empty to use “Re: <their subject>”.">
          <Input value={reply.subject} onChange={(e) => setS({ ...s, autoReply: { ...reply, subject: e.target.value } })} />
        </Field>
        <Field label="Message">
          <Textarea value={reply.body} onChange={(e) => setS({ ...s, autoReply: { ...reply, body: e.target.value } })} rows={4} placeholder="Thanks for your email. I'm away until Monday and will reply when I'm back." />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start (optional)">
            <Input type="datetime-local" value={toLocal(reply.startAt)} onChange={(e) => setS({ ...s, autoReply: { ...reply, startAt: e.target.value ? new Date(e.target.value).getTime() : null } })} />
          </Field>
          <Field label="End (optional)">
            <Input type="datetime-local" value={toLocal(reply.endAt)} onChange={(e) => setS({ ...s, autoReply: { ...reply, endAt: e.target.value ? new Date(e.target.value).getTime() : null } })} />
          </Field>
        </div>
        <p className="text-xs text-muted">Auto-replies are sent through your sending provider and count toward its limits.</p>
        <div className="flex justify-end">
          <Button variant="primary" disabled={!box.canSend} loading={busy === 'auto'} onClick={() => save('auto', { autoReply: { ...reply, body: reply.body } }, reply.enabled ? 'Auto-reply is on' : 'Saved')}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Forwarding({ box }: { box: Mailbox }) {
  const { s, setS, save, busy } = useBoxSettings(box, true);
  if (!s) return <PageSpinner />;
  return (
    <Card>
      <CardHeader icon={<Forward className="h-5 w-5" />} title="Forward a copy to" />
      <div className="space-y-3 p-5">
        {s.destinations.length === 0 ? (
          <Alert tone="neutral">No forwarding addresses yet. An admin adds and verifies them in Admin → Settings → Forwarding addresses.</Alert>
        ) : (
          s.destinations.map((d) => (
            <Checkbox
              key={d.address}
              disabled={!d.verified}
              label={d.address}
              hint={d.verified ? undefined : 'Waiting for the owner to click the verification link'}
              checked={s.forwardTo.includes(d.address)}
              onChange={(v) => setS({ ...s, forwardTo: v ? [...s.forwardTo, d.address] : s.forwardTo.filter((x) => x !== d.address) })}
            />
          ))
        )}
        {s.destinations.length > 0 && (
          <div className="flex justify-end">
            <Button variant="primary" disabled={!box.canSend} loading={busy === 'fwd'} onClick={() => save('fwd', { forwardTo: s.forwardTo }, 'Forwarding saved')}>
              Save
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Labels({ box }: { box: Mailbox }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>('blue');
  const [editing, setEditing] = useState<Label | null>(null);
  const { run } = useAction();
  const invalidate = useInvalidate();
  const refresh = () => invalidate(['mailboxes'], ['threads']);
  return (
    <Card>
      <CardHeader icon={<Tag className="h-5 w-5" />} title="Your labels" description="Click a label to rename, recolor or delete it." />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap gap-2">
          {box.labels.length === 0 && <span className="text-[13px] text-muted">No labels yet.</span>}
          {box.labels.map((l) => (
            <button key={l.id} type="button" onClick={() => setEditing(l)} className="label-chip rounded-md px-2.5 py-1 text-xs font-medium" style={labelChip(l.color)}>
              {l.name}
            </button>
          ))}
        </div>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run('add', () => post(`/mailboxes/${box.id}/labels`, { name, color }).then(() => { setName(''); refresh(); }), 'Label created');
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New label" required className="max-w-56" />
          <ColorPicker value={color} onChange={setColor} />
          <Button type="submit" icon={<Plus className="h-4 w-4" />}>
            Add
          </Button>
        </form>
      </div>
      {editing && (
        <Dialog
          open
          onClose={() => setEditing(null)}
          title="Edit label"
          size="sm"
          footer={
            <>
              <Button variant="ghost" icon={<Trash className="h-4 w-4" />} onClick={() => run('del', () => del(`/labels/${editing.id}`).then(() => { setEditing(null); refresh(); }), 'Label deleted')}>
                Delete
              </Button>
              <Button variant="primary" onClick={() => run('save', () => patch(`/labels/${editing.id}`, { name: editing.name, color: editing.color }).then(() => { setEditing(null); refresh(); }), 'Saved')}>
                Save
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <ColorPicker value={editing.color} onChange={(c) => setEditing({ ...editing, color: c })} />
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      {LABEL_COLORS.map((c) => (
        <button key={c} type="button" onClick={() => onChange(c)} aria-label={c} className={cn('h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-surface', value === c ? 'ring-fg' : 'ring-transparent')} style={labelDot(c)} />
      ))}
    </div>
  );
}

function Filters({ box }: { box: Mailbox }) {
  const q = useQuery({ queryKey: ['filters', box.id], queryFn: () => get<Filter[]>(`/mailboxes/${box.id}/filters`) });
  const [editing, setEditing] = useState<Partial<Filter> | null>(null);
  const { run } = useAction();
  const describe = (f: Filter) => {
    const c = f.conditions;
    const conds = [c.from && `from contains “${c.from}”`, c.to && `to contains “${c.to}”`, c.subject && `subject contains “${c.subject}”`, c.body && `body contains “${c.body}”`, c.hasAttachment && 'has attachment', c.isList && 'is a mailing list']
      .filter(Boolean)
      .join(c.match === 'any' ? ' or ' : ' and ');
    const a = f.actions;
    const acts = [
      a.labelIds?.length && `label ${a.labelIds.map((id) => box.labels.find((l) => l.id === id)?.name).filter(Boolean).join(', ')}`,
      a.folder && `move to ${a.folder}`,
      a.markRead && 'mark read',
      a.star && 'star',
      a.neverSpam && 'never spam',
      a.forwardTo && `forward to ${a.forwardTo}`,
    ]
      .filter(Boolean)
      .join(', ');
    return `If ${conds || '…'} → ${acts || '…'}`;
  };
  return (
    <Card>
      <CardHeader icon={<Funnel className="h-5 w-5" />} title="Rules" action={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ conditions: { match: 'all' }, actions: {}, enabled: true, name: '' })}>New filter</Button>} />
      <div className="divide-y divide-border">
        {q.data?.length === 0 && <div className="px-5 py-4 text-[13px] text-muted">No filters yet.</div>}
        {q.data?.map((f) => (
          <div key={f.id} className="flex items-center gap-3 px-5 py-3">
            <Switch checked={f.enabled} onChange={(v) => run('t', () => put(`/filters/${f.id}`, { ...f, enabled: v }).then(() => q.refetch()))} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{f.name || 'Unnamed filter'}</div>
              <div className="truncate text-xs text-muted">{describe(f)}</div>
            </div>
            <Button size="xs" variant="ghost" onClick={() => setEditing(f)}>
              Edit
            </Button>
            <Button size="xs" variant="ghost" icon={<Trash className="h-3.5 w-3.5" />} onClick={() => run('d', () => del(`/filters/${f.id}`).then(() => q.refetch()))} />
          </div>
        ))}
      </div>
      {editing && <FilterDialog box={box} filter={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.refetch(); }} />}
    </Card>
  );
}

function FilterDialog({ box, filter, onClose, onSaved }: { box: Mailbox; filter: Partial<Filter>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Partial<Filter>>(filter);
  const { run, busy } = useAction();
  const c = f.conditions ?? {};
  const a = f.actions ?? {};
  const setC = (patch: Partial<Filter['conditions']>) => setF({ ...f, conditions: { ...c, ...patch } });
  const setA = (patch: Partial<Filter['actions']>) => setF({ ...f, actions: { ...a, ...patch } });
  const save = () => run('save', () => (f.id ? put(`/filters/${f.id}`, f) : post(`/mailboxes/${box.id}/filters`, f)).then(onSaved), 'Filter saved');
  return (
    <Dialog open onClose={onClose} title={f.id ? 'Edit filter' : 'New filter'} size="lg" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={!!busy} onClick={save}>Save filter</Button></>}>
      <div className="space-y-5">
        <Field label="Name">
          <Input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Receipts" />
        </Field>
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            When mail matches
            <Select value={c.match ?? 'all'} onChange={(e) => setC({ match: e.target.value as 'all' | 'any' })} className="h-8 w-auto">
              <option value="all">all</option>
              <option value="any">any</option>
            </Select>
            of these:
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From contains"><Input value={c.from ?? ''} onChange={(e) => setC({ from: e.target.value || undefined })} /></Field>
            <Field label="To contains"><Input value={c.to ?? ''} onChange={(e) => setC({ to: e.target.value || undefined })} /></Field>
            <Field label="Subject contains"><Input value={c.subject ?? ''} onChange={(e) => setC({ subject: e.target.value || undefined })} /></Field>
            <Field label="Body contains"><Input value={c.body ?? ''} onChange={(e) => setC({ body: e.target.value || undefined })} /></Field>
          </div>
          <div className="flex flex-wrap gap-5">
            <Checkbox label="Has attachments" checked={!!c.hasAttachment} onChange={(v) => setC({ hasAttachment: v || undefined })} />
            <Checkbox label="Is from a mailing list" checked={!!c.isList} onChange={(v) => setC({ isList: v || undefined })} />
          </div>
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="text-[13px] font-medium">Do this:</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Move to">
              <Select value={a.folder ?? ''} onChange={(e) => setA({ folder: (e.target.value || undefined) as Filter['actions']['folder'] })}>
                <option value="">Keep in Inbox</option>
                <option value="archive">Archive (skip the inbox)</option>
                <option value="spam">Spam</option>
                <option value="trash">Trash</option>
              </Select>
            </Field>
            <Field label="Apply label">
              <Select value={a.labelIds?.[0] ?? ''} onChange={(e) => setA({ labelIds: e.target.value ? [Number(e.target.value)] : undefined })}>
                <option value="">None</option>
                {box.labels.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-5">
            <Checkbox label="Mark as read" checked={!!a.markRead} onChange={(v) => setA({ markRead: v || undefined })} />
            <Checkbox label="Star it" checked={!!a.star} onChange={(v) => setA({ star: v || undefined })} />
            <Checkbox label="Never send to Spam" checked={!!a.neverSpam} onChange={(v) => setA({ neverSpam: v || undefined })} />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

function buildImportParams(folder: string, customLabels: string[], isStarred: boolean): URLSearchParams {
  const params = new URLSearchParams({ folder });
  for (const label of customLabels) {
    params.append('label', label);
  }
  if (isStarred) {
    params.set('starred', '1');
  }
  return params;
}

function ImportExport({ box }: { box: Mailbox }) {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const invalidate = useInvalidate();

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const startController = () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return ctrl;
  };

  const importFiles = async (files: FileList) => {
    setError('');
    setIsProcessing(true);
    const ctrl = startController();
    let done = 0;
    let dupes = 0;
    let errors = 0;
    let lastError = '';

    try {
      for (const file of Array.from(files)) {
        if (ctrl.signal.aborted) break;
        const isMbox = file.name.toLowerCase().endsWith('.mbox') || file.type === 'application/mbox';
        if (isMbox) {
          // Stream-parse mbox archive in constant browser memory
          for await (const msg of streamMbox(file, 2 * 1024 * 1024, (read, total) => {
            if (ctrl.signal.aborted) return;
            const pct = total > 0 ? Math.round((read / total) * 100) : 100;
            setProgress(`Scanning ${file.name} (${pct}%) — ${done} imported…`);
          })) {
            if (ctrl.signal.aborted) break;
            if (msg.oversized || msg.bytes.byteLength > MAX_IMPORT_BYTES) {
              errors++;
              lastError = `${file.name} #${msg.index}: Files over 25 MB cannot be imported.`;
              continue;
            }
            try {
              const folderLabel = msg.targetFolder === 'inbox' ? 'Inbox' : msg.targetFolder === 'trash' ? 'Trash' : msg.targetFolder === 'spam' ? 'Spam' : 'Archive';
              setProgress(`Importing message ${msg.index} (${folderLabel}) from ${file.name}…`);

              const params = buildImportParams(msg.targetFolder, msg.customLabels, msg.isStarred);
              const r = await api<{ status: string }>(`/mailboxes/${box.id}/import?${params}`, {
                raw: new Blob([msg.bytes as BlobPart], { type: 'message/rfc822' }),
                headers: { 'Content-Type': 'message/rfc822' },
                signal: ctrl.signal,
              });
              if (r.status === 'duplicate') dupes++;
              done++;
            } catch (e) {
              if (ctrl.signal.aborted) break;
              if (e instanceof ApiError && (e.status === 401 || e.status === 403)) throw e;
              errors++;
              lastError = `${file.name} #${msg.index}: ${errorText(e)}`;
            }
          }
        } else {
          // Standard single .eml file
          if (file.size > MAX_IMPORT_BYTES) {
            errors++;
            lastError = `${file.name}: Files over 25 MB cannot be imported.`;
            continue;
          }
          setProgress(`Importing ${done + 1} of ${files.length}…`);
          try {
            const headerSlice = await file.slice(0, 65536).arrayBuffer();
            const labelsInfo = parseGmailLabels(new Uint8Array(headerSlice));
            const params = buildImportParams(labelsInfo.targetFolder, labelsInfo.customLabels, labelsInfo.isStarred);

            const r = await api<{ status: string }>(`/mailboxes/${box.id}/import?${params}`, {
              raw: file,
              headers: { 'Content-Type': 'message/rfc822' },
              signal: ctrl.signal,
            });
            if (r.status === 'duplicate') dupes++;
            done++;
          } catch (e) {
            if (ctrl.signal.aborted) break;
            if (e instanceof ApiError && (e.status === 401 || e.status === 403)) throw e;
            errors++;
            lastError = `${file.name}: ${errorText(e)}`;
          }
        }
      }

      if (!ctrl.signal.aborted) {
        if (lastError) setError(errors > 1 ? `${lastError} (${errors} failed total)` : lastError);
        const imported = done - dupes;
        setProgress(
          `Import complete: ${imported} message${imported === 1 ? '' : 's'} imported` +
            (dupes ? ` (${dupes} duplicates skipped)` : '') +
            (errors ? `, ${errors} failed.` : '.'),
        );
        invalidate(['threads'], ['mailboxes']);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(errorText(e));
    } finally {
      if (abortRef.current === ctrl) setIsProcessing(false);
    }
  };

  type ExportMessageMeta = { id: number; subject: string; sent_at: number };

  const collectExport = async (
    label: string,
    onMessage: (meta: ExportMessageMeta, raw: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<{ exported: number; failed: number }> => {
    let after = 0;
    let exported = 0;
    let failed = 0;

    for (;;) {
      if (signal.aborted) break;
      const page = await get<{ messages: ExportMessageMeta[]; next: number | null }>(
        `/mailboxes/${box.id}/export?after=${after}`,
        signal,
      );
      for (const m of page.messages) {
        if (signal.aborted) break;
        setProgress(`${label} message ${exported + failed + 1}…`);
        const res = await fetch(`/api/messages/${m.id}/raw`, { credentials: 'same-origin', signal });
        if (res.status === 401 || res.status === 403) {
          throw new ApiError(res.status, 'auth', `Export stopped (${res.status}). Please sign in again.`);
        }
        if (!res.ok) {
          failed++;
          continue;
        }
        const raw = new Uint8Array(await res.arrayBuffer());
        onMessage(m, raw);
        exported++;
      }
      if (!page.next) break;
      after = page.next;
    }
    return { exported, failed };
  };

  const safeAddress = box.address.replace(/[^\w.@+-]+/g, '_');

  const exportMbox = async () => {
    setError('');
    setIsProcessing(true);
    const ctrl = startController();
    const mboxParts: Uint8Array[] = [];

    try {
      const { exported, failed } = await collectExport(
        'Exporting',
        (m, raw) => {
          mboxParts.push(formatMboxEntry(raw, new Date(m.sent_at), box.address));
        },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;

      setProgress('Generating .mbox file…');
      const blob = new Blob(mboxParts as BlobPart[], { type: 'application/mbox' });
      downloadBlob(blob, `${safeAddress}-${new Date().toISOString().slice(0, 10)}.mbox`);
      setProgress(`Exported ${exported} message${exported === 1 ? '' : 's'} to .mbox${failed ? ` (${failed} failed).` : '.'}`);
      if (failed > 0) setError(`${failed} message${failed === 1 ? '' : 's'} could not be downloaded and were omitted from the export.`);
    } catch (e) {
      if (!ctrl.signal.aborted) setError(errorText(e));
    } finally {
      if (abortRef.current === ctrl) setIsProcessing(false);
    }
  };

  const exportZip = async () => {
    setError('');
    setIsProcessing(true);
    const ctrl = startController();
    const files: Record<string, Uint8Array> = {};

    try {
      const { exported, failed } = await collectExport(
        'Downloading',
        (m, raw) => {
          const date = new Date(m.sent_at).toISOString().slice(0, 10);
          const name = `${date}-${m.id}-${(m.subject || 'message').replace(/[^\w -]+/g, '').trim().slice(0, 50)}.eml`;
          files[name] = raw;
        },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;

      setProgress('Creating zip…');
      const zip = zipSync(files, { level: 6 });
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${safeAddress}-${new Date().toISOString().slice(0, 10)}.zip`);
      setProgress(`Exported ${exported} message${exported === 1 ? '' : 's'} to .zip${failed ? ` (${failed} failed).` : '.'}`);
      if (failed > 0) setError(`${failed} message${failed === 1 ? '' : 's'} could not be downloaded and were omitted from the export.`);
    } catch (e) {
      if (!ctrl.signal.aborted) setError(errorText(e));
    } finally {
      if (abortRef.current === ctrl) setIsProcessing(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={<Download className="h-5 w-5" />}
        title="Mail Import & Export"
        description="Transfer your mail using Google Takeout (.mbox) or standard .eml files."
      />
      <div className="space-y-4 p-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {progress && <Alert tone="neutral">{progress}</Alert>}
        <div className="flex flex-wrap gap-2">
          <label
            className={cn(
              'inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-2 px-3.5 py-2 text-sm font-medium hover:bg-surface-3 transition',
              isProcessing && 'pointer-events-none opacity-50'
            )}
          >
            <FileUp className="h-4 w-4" /> Import .mbox or .eml
            <input
              type="file"
              accept=".mbox,.eml,message/rfc822,application/mbox"
              multiple
              hidden
              disabled={isProcessing}
              onChange={(e) => {
                if (e.target.files?.length) {
                  importFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
          </label>
          <Button
            icon={<Archive className="h-4 w-4" />}
            onClick={exportMbox}
            disabled={isProcessing}
          >
            Export as .mbox (Gmail / Thunderbird)
          </Button>
          <Button
            icon={<Download className="h-4 w-4" />}
            onClick={exportZip}
            disabled={isProcessing}
          >
            Export as .zip
          </Button>
        </div>
        <p className="text-xs text-muted">
          All extraction runs locally in your browser chunk-by-chunk with low memory usage, allowing multi-gigabyte Google Takeout files to be imported safely into your free Cloudflare Worker.
        </p>
      </div>
    </Card>
  );
}
