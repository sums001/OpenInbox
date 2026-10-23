import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ellipsis, KeyRound, Lock, Shield, Trash, UserPlus } from 'lucide-react';
import { del, get, patch, post, errorText } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import { useUser } from '../../lib/session';
import type { DomainInfo, MailboxAdmin, UserSummary } from '../../lib/types';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input, SegmentedControl, Select } from '../../components/ui/form';
import { Alert, Avatar, Badge, Card, CopyButton, EmptyState, PageHeader, PageSpinner } from '../../components/ui/misc';
import { ConfirmDialog, Dialog, Menu, MenuItem, MenuSeparator } from '../../components/ui/overlay';

export function UsersPage() {
  const me = useUser();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => get<UserSummary[]>('/admin/users') });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [deleting, setDeleting] = useState<UserSummary | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const { run, busy } = useAction();
  const invalidate = useInvalidate();
  const refresh = () => invalidate(['admin', 'users'], ['admin', 'mailboxes'], ['admin', 'overview']);

  if (users.isLoading) return <PageSpinner />;
  const list = users.data ?? [];

  return (
    <div>
      <PageHeader
        title="Users"
        description="People who can sign in. Each person sees only the inboxes they're a member of."
        actions={
          <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            Add user
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {list.length === 0 ? (
          <EmptyState title="No users yet" />
        ) : (
          <div className="divide-y divide-border">
            {list.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                <Avatar name={u.name} address={u.email} size={36} />
                <div className="min-w-48 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{u.name || u.email}</span>
                    {u.id === me?.id && <Badge>You</Badge>}
                    <Badge tone={u.role === 'owner' ? 'primary' : u.role === 'admin' ? 'warning' : 'neutral'}>{u.role}</Badge>
                    {u.status === 'disabled' && <Badge tone="danger">disabled</Badge>}
                    {u.totpEnabled && (
                      <span title="Two-factor enabled">
                        <Shield className="h-3.5 w-3.5 text-success" />
                      </span>
                    )}
                  </div>
                  <div className="text-[13px] text-muted">{u.email}</div>
                </div>
                <div className="hidden min-w-40 text-[13px] text-muted md:block">
                  {u.mailboxes.length ? u.mailboxes.map((m) => m.address).join(', ') : 'No inboxes'}
                </div>
                <div className="w-28 text-right text-xs text-faint">{u.lastLoginAt ? `Active ${timeAgo(u.lastLoginAt)}` : u.mustChangePassword ? 'Not signed in yet' : 'Never'}</div>
                <Menu
                  trigger={({ onClick }) => (
                    <Button variant="ghost" size="icon" onClick={onClick} aria-label="Actions">
                      <Ellipsis className="h-4 w-4" />
                    </Button>
                  )}
                >
                  <MenuItem onClick={() => setEditing(u)}>Edit</MenuItem>
                  <MenuItem
                    icon={<KeyRound />}
                    disabled={u.role === 'owner' && u.id !== me?.id}
                    onClick={() =>
                      run('reset', async () => {
                        const r = await post<{ password: string }>(`/admin/users/${u.id}/reset-password`);
                        setSecret({ email: u.email, password: r.password });
                        await refresh();
                      })
                    }
                  >
                    Reset password
                  </MenuItem>
                  {u.totpEnabled && (
                    <MenuItem icon={<Lock />} onClick={() => run('2fa', () => post(`/admin/users/${u.id}/reset-2fa`).then(refresh), 'Two-factor turned off for this user')}>
                      Turn off two-factor
                    </MenuItem>
                  )}
                  {u.role !== 'owner' && (
                    <MenuItem onClick={() => run('status', () => patch(`/admin/users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' }).then(refresh))}>
                      {u.status === 'active' ? 'Disable' : 'Enable'}
                    </MenuItem>
                  )}
                  {u.role !== 'owner' && u.id !== me?.id && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Trash />} danger onClick={() => setDeleting(u)}>
                        Delete
                      </MenuItem>
                    </>
                  )}
                </Menu>
              </div>
            ))}
          </div>
        )}
      </Card>

      {creating && (
        <CreateUserDialog
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setSecret(r);
            refresh();
          }}
        />
      )}
      {editing && <EditUserDialog user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {deleting && <DeleteUserDialog user={deleting} users={list} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); refresh(); }} />}
      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title="Share these sign-in details"
        description="The password is shown only once. The user must choose their own password when they first sign in."
        footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}
      >
        {secret && (
          <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-4 font-mono text-sm">
            <div className="flex items-center justify-between gap-2">
              <span>{secret.email}</span>
              <CopyButton text={secret.email} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>{secret.password}</span>
              <CopyButton text={secret.password} />
            </div>
            <div className="border-t border-border pt-3 font-sans text-xs text-muted">Sign in at {location.origin}</div>
          </div>
        )}
      </Dialog>
      {busy && null}
    </div>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { email: string; password: string }) => void }) {
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => get<DomainInfo[]>('/admin/domains') });
  const mailboxes = useQuery({ queryKey: ['admin', 'mailboxes'], queryFn: () => get<MailboxAdmin[]>('/admin/mailboxes') });
  const [name, setName] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [localPart, setLocalPart] = useState('');
  const [domainId, setDomainId] = useState<number | ''>('');
  const [email, setEmail] = useState('');
  const [shared, setShared] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const domainList = domains.data ?? [];
  const domain = domainList.find((d) => d.id === domainId) ?? domainList[0];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await post<{ email: string; password: string }>('/admin/users', {
        name,
        role,
        email: mode === 'existing' ? email : undefined,
        newMailbox: mode === 'new' ? { localPart: localPart || name.toLowerCase().replace(/[^a-z0-9]+/g, '.'), domainId: domain?.id } : null,
        mailboxIds: shared,
      });
      onCreated(r);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a user"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-user" loading={busy}>
            Create user
          </Button>
        </>
      }
    >
      <form id="create-user" onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name" id="name">
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Role">
          <SegmentedControl
            value={role}
            onChange={setRole}
            options={[
              { value: 'member', label: 'Member' },
              { value: 'admin', label: 'Admin' },
            ]}
          />
          <p className="text-xs text-muted">{role === 'admin' ? 'Admins manage domains, providers, inboxes and users.' : 'Members use their inboxes and nothing else.'}</p>
        </Field>
        <Field label="Inbox">
          <SegmentedControl
            value={mode}
            onChange={setMode}
            options={[
              { value: 'new', label: 'Create a new inbox' },
              { value: 'existing', label: 'Sign in with another email' },
            ]}
          />
        </Field>
        {mode === 'new' ? (
          <Field label="Email address" id="local" hint="This becomes their inbox and their sign-in.">
            <div className="flex gap-2">
              <Input id="local" value={localPart} onChange={(e) => setLocalPart(e.target.value.trim())} placeholder={name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '.') : 'jane'} />
              <Select value={domain?.id ?? ''} onChange={(e) => setDomainId(Number(e.target.value))} className="max-w-48">
                {domainList.map((d) => (
                  <option key={d.id} value={d.id}>
                    @{d.name}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        ) : (
          <Field label="Sign-in email" id="email" hint="Any address; give them access to shared inboxes below.">
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
        )}
        {!!mailboxes.data?.length && (
          <Field label="Also give access to">
            <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-border p-3">
              {mailboxes.data.map((m) => (
                <Checkbox key={m.id} label={m.address} hint={m.kind === 'shared' ? 'Shared inbox' : undefined} checked={shared.includes(m.id)} onChange={(v) => setShared((s) => (v ? [...s, m.id] : s.filter((x) => x !== m.id)))} />
              ))}
            </div>
          </Field>
        )}
      </form>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose, onSaved }: { user: UserSummary; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<'member' | 'admin'>(user.role === 'admin' ? 'admin' : 'member');
  const { run, busy } = useAction();
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${user.name || user.email}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={!!busy}
            onClick={() => run('save', () => patch(`/admin/users/${user.id}`, { name, email, ...(user.role !== 'owner' ? { role } : {}) }).then(onSaved), 'User updated')}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" id="ename">
          <Input id="ename" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Sign-in email" id="eemail">
          <Input id="eemail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {user.role !== 'owner' && (
          <Field label="Role">
            <SegmentedControl value={role} onChange={setRole} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} />
          </Field>
        )}
        <p className="text-xs text-muted">Inbox access is managed on the Inboxes page.</p>
      </div>
    </Dialog>
  );
}

function DeleteUserDialog({ user, users, onClose, onDeleted }: { user: UserSummary; users: UserSummary[]; onClose: () => void; onDeleted: () => void }) {
  const [reassign, setReassign] = useState<number | ''>('');
  const { run, busy } = useAction();
  return (
    <ConfirmDialog
      open
      danger
      onClose={onClose}
      title={`Delete ${user.name || user.email}?`}
      confirmLabel="Delete user"
      loading={!!busy}
      onConfirm={() => run('delete', () => del(`/admin/users/${user.id}${reassign ? `?reassignTo=${reassign}` : ''}`).then(onDeleted), 'User deleted')}
    >
      <p>They lose access immediately. Their inboxes and mail are kept.</p>
      <div className="mt-3">
        <Field label="Give their inbox access and assigned conversations to">
          <Select value={reassign} onChange={(e) => setReassign(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Nobody</option>
            {users
              .filter((u) => u.id !== user.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
          </Select>
        </Field>
      </div>
    </ConfirmDialog>
  );
}
