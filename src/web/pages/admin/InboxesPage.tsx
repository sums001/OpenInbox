import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AtSign, Inbox, Plus, Trash, UsersRound } from 'lucide-react';
import { del, get, patch, post, put, errorText } from '../../lib/api';
import { num } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import type { DomainInfo, MailboxAdmin, UserSummary } from '../../lib/types';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input, SegmentedControl, Select, Switch } from '../../components/ui/form';
import { Alert, Badge, Card, EmptyState, PageHeader, PageSpinner, Tabs } from '../../components/ui/misc';
import { ConfirmDialog, Dialog } from '../../components/ui/overlay';

export function InboxesPage() {
  const mailboxes = useQuery({ queryKey: ['admin', 'mailboxes'], queryFn: () => get<MailboxAdmin[]>('/admin/mailboxes') });
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => get<DomainInfo[]>('/admin/domains') });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const invalidate = useInvalidate();
  const refresh = () => invalidate(['admin', 'mailboxes'], ['admin', 'users'], ['mailboxes'], ['admin', 'overview']);
  if (mailboxes.isLoading) return <PageSpinner />;
  const list = mailboxes.data ?? [];
  const domainName = (id: number) => domains.data?.find((d) => d.id === id)?.name ?? '';
  const current = list.find((m) => m.id === editing);

  return (
    <div>
      <PageHeader
        title="Inboxes"
        description="Every address that receives mail. Create as many as you like on any connected domain; aliases deliver into an existing inbox."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)} disabled={!domains.data?.length}>
            New inbox
          </Button>
        }
      />
      {list.length === 0 ? (
        <Card>
          <EmptyState icon={<Inbox className="h-5 w-5" />} title="No inboxes yet" />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((m) => (
            <Card key={m.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{m.address}</div>
                  <div className="text-[13px] text-muted">{m.displayName || 'No display name'}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  {m.kind === 'shared' && <Badge tone="primary">Shared</Badge>}
                  {m.isCatchAll && <Badge tone="warning">Catch-all</Badge>}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-surface-2 py-2">
                  <div className="text-base font-semibold">{num(m.threads)}</div>
                  <div className="text-[11px] text-muted">conversations</div>
                </div>
                <div className="rounded-lg bg-surface-2 py-2">
                  <div className="text-base font-semibold">{num(m.unread)}</div>
                  <div className="text-[11px] text-muted">unread</div>
                </div>
                <div className="rounded-lg bg-surface-2 py-2">
                  <div className="text-base font-semibold">{m.members.length}</div>
                  <div className="text-[11px] text-muted">members</div>
                </div>
              </div>
              {m.aliases.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {m.aliases.map((a) => (
                    <Badge key={a.id}>
                      <AtSign className="h-3 w-3" />
                      {a.address}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="mt-3 text-xs text-muted">{m.members.length ? m.members.map((x) => `${x.name || x.email}${x.canSend ? '' : ' (read only)'}`).join(', ') : 'No members: nobody can read this inbox yet.'}</div>
              <div className="mt-4 flex justify-end">
                <Button size="sm" onClick={() => setEditing(m.id)}>
                  Manage
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {creating && domains.data && (
        <CreateInboxDialog
          domains={domains.data}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
      {current && domains.data && <ManageInboxDialog mailbox={current} domains={domains.data} domainName={domainName(current.domainId)} onClose={() => setEditing(null)} onChanged={refresh} />}
    </div>
  );
}

function MembersEditor({ value, onChange }: { value: { userId: number; canSend: boolean }[]; onChange: (v: { userId: number; canSend: boolean }[]) => void }) {
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => get<UserSummary[]>('/admin/users') });
  return (
    <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
      {(users.data ?? []).map((u) => {
        const m = value.find((x) => x.userId === u.id);
        return (
          <div key={u.id} className="flex items-center gap-3 px-3 py-2">
            <Checkbox
              label={u.name || u.email}
              hint={u.email}
              checked={!!m}
              onChange={(v) => onChange(v ? [...value, { userId: u.id, canSend: true }] : value.filter((x) => x.userId !== u.id))}
            />
            <div className="flex-1" />
            {m && (
              <label className="flex items-center gap-2 text-xs text-muted">
                Can send
                <Switch checked={m.canSend} onChange={(c) => onChange(value.map((x) => (x.userId === u.id ? { ...x, canSend: c } : x)))} />
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CreateInboxDialog({ domains, onClose, onCreated }: { domains: DomainInfo[]; onClose: () => void; onCreated: () => void }) {
  const [localPart, setLocalPart] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? 0);
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<'personal' | 'shared'>('shared');
  const [members, setMembers] = useState<{ userId: number; canSend: boolean }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/admin/mailboxes', { localPart, domainId, displayName, kind, members });
      onCreated();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="New inbox"
      description="For a person, it's easier to add a user (which creates their inbox). Use this for shared inboxes like support@ or hello@."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-inbox" loading={busy}>
            Create inbox
          </Button>
        </>
      }
    >
      <form id="create-inbox" onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Address" id="addr">
          <div className="flex gap-2">
            <Input id="addr" value={localPart} onChange={(e) => setLocalPart(e.target.value.trim())} placeholder="support" required autoFocus />
            <Select value={domainId} onChange={(e) => setDomainId(Number(e.target.value))} className="max-w-52">
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  @{d.name}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Field label="Display name" id="dn" hint="The sender name on mail sent from this inbox.">
          <Input id="dn" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Acme Support" />
        </Field>
        <Field label="Type">
          <SegmentedControl value={kind} onChange={setKind} options={[{ value: 'shared', label: 'Shared' }, { value: 'personal', label: 'Personal' }]} />
          <p className="text-xs text-muted">Shared inboxes add assignment and internal notes for teams.</p>
        </Field>
        <Field label="Members">
          <MembersEditor value={members} onChange={setMembers} />
        </Field>
      </form>
    </Dialog>
  );
}

function ManageInboxDialog({ mailbox, domains, domainName, onClose, onChanged }: { mailbox: MailboxAdmin; domains: DomainInfo[]; domainName: string; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<'general' | 'aliases' | 'members' | 'danger'>('general');
  const [displayName, setDisplayName] = useState(mailbox.displayName);
  const [kind, setKind] = useState(mailbox.kind);
  const [members, setMembers] = useState(mailbox.members.map((m) => ({ userId: m.userId, canSend: m.canSend })));
  const [alias, setAlias] = useState('');
  const [aliasDomain, setAliasDomain] = useState(mailbox.domainId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const { run, busy } = useAction();

  return (
    <Dialog open onClose={onClose} title={mailbox.address} description={domainName ? `On ${domainName}` : undefined} size="lg">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'general', label: 'General' },
          { value: 'aliases', label: 'Aliases', count: mailbox.aliases.length },
          { value: 'members', label: 'Members', count: mailbox.members.length },
          { value: 'danger', label: 'Delete' },
        ]}
      />
      <div className="pt-4">
        {tab === 'general' && (
          <div className="space-y-4">
            <Field label="Display name" id="mdn">
              <Input id="mdn" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label="Type">
              <SegmentedControl value={kind} onChange={setKind} options={[{ value: 'shared', label: 'Shared' }, { value: 'personal', label: 'Personal' }]} />
            </Field>
            <div className="flex justify-end">
              <Button variant="primary" loading={busy === 'general'} onClick={() => run('general', () => patch(`/admin/mailboxes/${mailbox.id}`, { displayName, kind }).then(onChanged), 'Saved')}>
                Save
              </Button>
            </div>
          </div>
        )}
        {tab === 'aliases' && (
          <div className="space-y-4">
            <p className="text-[13px] text-muted">Mail to an alias lands in this inbox, and replies go out from the alias it was sent to. Plus addressing (name+anything@) works automatically.</p>
            <div className="divide-y divide-border rounded-lg border border-border">
              {mailbox.aliases.length === 0 && <div className="px-3 py-3 text-[13px] text-muted">No aliases yet.</div>}
              {mailbox.aliases.map((a) => (
                <div key={a.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  {a.address}
                  <Button size="xs" variant="ghost" icon={<Trash className="h-3.5 w-3.5" />} onClick={() => run('rm', () => del(`/admin/mailboxes/${mailbox.id}/aliases/${a.id}`).then(onChanged), 'Alias removed')}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run('alias', () => post(`/admin/mailboxes/${mailbox.id}/aliases`, { localPart: alias, domainId: aliasDomain }).then(() => {
                  setAlias('');
                  onChanged();
                }), 'Alias added');
              }}
            >
              <Input value={alias} onChange={(e) => setAlias(e.target.value.trim())} placeholder="billing" required />
              <Select value={aliasDomain} onChange={(e) => setAliasDomain(Number(e.target.value))} className="max-w-48">
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    @{d.name}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="primary" loading={busy === 'alias'}>
                Add
              </Button>
            </form>
          </div>
        )}
        {tab === 'members' && (
          <div className="space-y-4">
            <p className="text-[13px] text-muted">Members can read this inbox. Turn off "Can send" for read-only access. Admins don't see inboxes they aren't members of.</p>
            <MembersEditor value={members} onChange={setMembers} />
            <div className="flex justify-end">
              <Button variant="primary" icon={<UsersRound className="h-4 w-4" />} loading={busy === 'members'} onClick={() => run('members', () => put(`/admin/mailboxes/${mailbox.id}/members`, { members }).then(onChanged), 'Members saved')}>
                Save members
              </Button>
            </div>
          </div>
        )}
        {tab === 'danger' && (
          <div className="space-y-4">
            <Alert tone="danger" title="Delete this inbox and all its mail">
              Its {num(mailbox.threads)} conversations, attachments and aliases are deleted permanently. Export it first from Mail settings if you need a copy.
            </Alert>
            <Button variant="danger" icon={<Trash className="h-4 w-4" />} onClick={() => setConfirmDelete(true)}>
              Delete inbox
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        danger
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${mailbox.address}?`}
        confirmLabel="Delete forever"
        loading={busy === 'delete'}
        onConfirm={() =>
          run('delete', () => del(`/admin/mailboxes/${mailbox.id}?confirm=${encodeURIComponent(confirmText)}`).then(() => {
            onChanged();
            onClose();
          }), 'Inbox deleted')
        }
      >
        <p className="mb-2">Type the address to confirm.</p>
        <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={mailbox.address} />
      </ConfirmDialog>
    </Dialog>
  );
}
