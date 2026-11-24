import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Braces, Plus, Trash } from 'lucide-react';
import { del, get, post } from '../../lib/api';
import { fullDate, timeAgo } from '../../lib/format';
import { useAction } from '../../lib/hooks';
import type { Mailbox } from '../../lib/types';
import { UPSTREAM_REPO } from '../../../shared/constants';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input, PasswordInput, Select } from '../../components/ui/form';
import { Alert, Badge, Card, CardHeader, CopyButton, EmptyState, PageHeader } from '../../components/ui/misc';
import { ConfirmDialog, Dialog } from '../../components/ui/overlay';

interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  mailboxIds: number[] | null;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
}

const SCOPES = [
  { id: 'read', label: 'Read mail', hint: 'List, read and search messages, download attachments.' },
  { id: 'send', label: 'Send mail', hint: 'Send and schedule messages from your addresses.' },
  { id: 'modify', label: 'Organize mail', hint: 'Mark read, archive, label, move to spam or trash.' },
];

const DOCS_URL = `https://github.com/${UPSTREAM_REPO}/blob/main/API.md`;

export function ApiKeysSettings() {
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => get<ApiKey[]>('/account/api-keys') });
  const boxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => get<Mailbox[]>('/mailboxes') });
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<ApiKey | null>(null);
  const { run } = useAction();
  const boxName = (id: number) => boxes.data?.find((b) => b.id === id)?.address ?? `#${id}`;
  return (
    <div className="space-y-6">
      <PageHeader
        title="API keys"
        description={
          <>
            Let scripts and apps read and send your mail through the Inbox API at <span className="font-mono text-fg">{location.origin}/api/v1</span>.{' '}
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-primary-text hover:underline">
              API docs
            </a>
          </>
        }
      />
      <Card>
        <CardHeader
          icon={<Braces className="h-5 w-5" />}
          title="Your keys"
          description="A key acts as you, limited to the permissions and inboxes you choose."
          action={
            <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
              New key
            </Button>
          }
        />
        {keys.data?.length === 0 && (
          <div className="p-5">
            <EmptyState icon={<Braces />} title="No API keys yet" />
          </div>
        )}
        <div className="divide-y divide-border">
          {keys.data?.map((k) => {
            const expired = k.expiresAt !== null && k.expiresAt <= Date.now();
            return (
              <div key={k.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {k.name} <span className="font-mono text-xs text-muted">{k.prefix}…</span>
                    {k.scopes.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                    {expired && <Badge tone="danger">Expired</Badge>}
                  </div>
                  <div className="text-xs text-muted">
                    {k.mailboxIds ? k.mailboxIds.map(boxName).join(', ') : 'All your inboxes'} · {k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}` : 'never used'}
                    {k.expiresAt && !expired && ` · expires ${fullDate(k.expiresAt)}`}
                  </div>
                </div>
                <Button size="xs" variant="ghost" icon={<Trash className="h-3.5 w-3.5" />} onClick={() => setRemoving(k)}>
                  Delete
                </Button>
              </div>
            );
          })}
        </div>
      </Card>
      {creating && <CreateKey mailboxes={boxes.data ?? []} onClose={() => setCreating(false)} onCreated={() => keys.refetch()} />}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Delete "${removing?.name}"?`}
        confirmLabel="Delete key"
        danger
        onConfirm={() => run('rm', () => del(`/account/api-keys/${removing!.id}`).then(() => { setRemoving(null); keys.refetch(); }), 'Key deleted')}
      >
        Apps using this key stop working right away.
      </ConfirmDialog>
    </div>
  );
}

function CreateKey({ mailboxes, onClose, onCreated }: { mailboxes: Mailbox[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read', 'send']);
  const [limit, setLimit] = useState<number[] | null>(null);
  const [days, setDays] = useState('');
  const [password, setPassword] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const { run, busy } = useAction();
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  if (created) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Copy your new key"
        description="It won't be shown again. Keep it secret, like a password."
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <span className="min-w-0 flex-1 font-mono text-[13px] break-all">{created}</span>
          <CopyButton text={created} />
        </div>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px] text-muted">{`curl ${location.origin}/api/v1/me \\\n  -H "Authorization: Bearer ${created.slice(0, 12)}…"`}</pre>
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="New API key"
      footer={
        <Button
          variant="primary"
          loading={busy === 'create'}
          disabled={!name.trim() || !password || !scopes.length || (limit !== null && !limit.length)}
          onClick={() =>
            run('create', async () => {
              const k = await post<{ key: string }>('/account/api-keys', { password, name, scopes, mailboxIds: limit, expiresInDays: days ? Number(days) : null });
              setCreated(k.key);
              onCreated();
            })
          }
        >
          Create key
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint="What uses it, e.g. CRM sync or newsletter script.">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
        </Field>
        <Field label="Permissions">
          <div className="space-y-2">
            {SCOPES.map((s) => (
              <Checkbox key={s.id} label={s.label} hint={s.hint} checked={scopes.includes(s.id)} onChange={(on) => setScopes(toggle(scopes, s.id, on))} />
            ))}
          </div>
        </Field>
        <Field label="Inboxes">
          <div className="space-y-2">
            <Checkbox label="All my inboxes, including ones I join later" checked={limit === null} onChange={(on) => setLimit(on ? null : [])} />
            {limit !== null &&
              mailboxes.map((b) => <Checkbox key={b.id} label={b.address} checked={limit.includes(b.id)} onChange={(on) => setLimit(toggle(limit, b.id, on))} />)}
          </div>
        </Field>
        <Field label="Expires">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="">Never</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In a year</option>
          </Select>
        </Field>
        <Field label="Your password" hint="Keys keep working after you sign out, so creating one needs your password.">
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        {scopes.includes('send') && <Alert tone="warning">Sending through the API counts against your providers' daily limits like any other mail. Send only to people who expect to hear from you.</Alert>}
      </div>
    </Dialog>
  );
}
