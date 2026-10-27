import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { zipSync } from 'fflate';
import { CalendarClock, Download, FileUp, Funnel, PenLine, Plus, Tag, Trash, Forward } from 'lucide-react';
import { del, get, patch, post, put, api, errorText } from '../../lib/api';
import { useAction, useInvalidate } from '../../lib/hooks';
import { cn, downloadBlob } from '../../lib/utils';
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
  { id: 'import-export', label: 'Import & export', description: 'Bring mail from another account as .eml files, or download everything in this inbox as a zip of .eml files.' },
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

function useBoxSettings(box: Mailbox) {
  const q = useQuery({ queryKey: ['box-settings', box.id], queryFn: () => get<BoxSettings>(`/mailboxes/${box.id}/settings`) });
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
        <Field label="Signature" hint="Plain text or simple HTML (links, bold, line breaks).">
          <Textarea value={s.signature} onChange={(e) => setS({ ...s, signature: e.target.value })} rows={4} className="font-mono text-[13px]" disabled={!box.canSend} />
        </Field>
        {s.signature && (
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium">Preview</div>
            <div className="rounded-lg border border-border bg-surface-2 p-3 text-[13px]" dangerouslySetInnerHTML={{ __html: sanitizeSignature(s.signature) }} />
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!box.canSend} loading={busy === 'sig'} onClick={() => save('sig', { displayName: s.displayName, signature: sanitizeSignature(s.signature) }, 'Saved')}>
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
  const { s, setS, save, busy } = useBoxSettings(box);
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

// Keeps signatures to harmless formatting.
function sanitizeSignature(html: string): string {
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(html);
  const text = looksHtml ? html : html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  return text
    .replace(/<(script|style|iframe|object|embed|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
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

function ImportExport({ box }: { box: Mailbox }) {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState('');
  const invalidate = useInvalidate();

  const importFiles = async (files: FileList) => {
    setError('');
    let done = 0;
    let dupes = 0;
    for (const file of Array.from(files)) {
      setProgress(`Importing ${done + 1} of ${files.length}…`);
      try {
        const r = await api<{ status: string }>(`/mailboxes/${box.id}/import`, { raw: file, headers: { 'Content-Type': 'message/rfc822' } });
        if (r.status === 'duplicate') dupes++;
      } catch (e) {
        setError(`${file.name}: ${errorText(e)}`);
      }
      done++;
    }
    setProgress(`Imported ${done - dupes} message${done - dupes === 1 ? '' : 's'}${dupes ? ` (${dupes} already here)` : ''} into Archive.`);
    invalidate(['threads'], ['mailboxes']);
  };

  const exportAll = async () => {
    setError('');
    const files: Record<string, Uint8Array> = {};
    let after = 0;
    let count = 0;
    try {
      for (;;) {
        const page = await get<{ messages: { id: number; subject: string; sent_at: number }[]; next: number | null }>(`/mailboxes/${box.id}/export?after=${after}`);
        for (const m of page.messages) {
          setProgress(`Downloading message ${++count}…`);
          const res = await fetch(`/api/messages/${m.id}/raw`, { credentials: 'same-origin' });
          if (!res.ok) continue;
          const date = new Date(m.sent_at).toISOString().slice(0, 10);
          const name = `${date}-${m.id}-${(m.subject || 'message').replace(/[^\w -]+/g, '').trim().slice(0, 50)}.eml`;
          files[name] = new Uint8Array(await res.arrayBuffer());
        }
        if (!page.next) break;
        after = page.next;
      }
      setProgress('Creating zip…');
      const zip = zipSync(files, { level: 6 });
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${box.address}-${new Date().toISOString().slice(0, 10)}.zip`);
      setProgress(`Exported ${count} messages.`);
    } catch (e) {
      setError(errorText(e));
      setProgress(null);
    }
  };

  return (
    <Card>
      <CardHeader icon={<Download className="h-5 w-5" />} title="Your mail as .eml files" description="Imported messages go to Archive." />
      <div className="space-y-4 p-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {progress && <Alert tone="neutral">{progress}</Alert>}
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-2 px-3.5 py-2 text-sm font-medium hover:bg-surface-3">
            <FileUp className="h-4 w-4" /> Import .eml files
            <input type="file" accept=".eml,message/rfc822" multiple hidden onChange={(e) => e.target.files && importFiles(e.target.files)} />
          </label>
          <Button icon={<Download className="h-4 w-4" />} onClick={exportAll}>
            Export as zip
          </Button>
        </div>
        <p className="text-xs text-muted">The export runs in your browser, one message at a time, so it works on the free plan for any size of inbox.</p>
      </div>
    </Card>
  );
}
