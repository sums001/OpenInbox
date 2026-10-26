import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Ban, CircleCheck, Copy, Ellipsis, KeyRound, Minus, Pencil, ShieldCheck, ShieldOff, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { del, get, patch, post, errorText } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import { useUser } from '../../lib/session';
import { cn, copyText } from '../../lib/utils';
import type { DomainInfo, MailboxAdmin, UserSummary } from '../../lib/types';
import { Button, IconButton } from '../../components/ui/button';
import { AddressInput, ChoiceCards, Field, Input, Select, Tick } from '../../components/ui/form';
import { Alert, Avatar, Badge, Card, CopyButton, EmptyState, PageHeader, PageSpinner } from '../../components/ui/misc';
import { ConfirmDialog, Dialog, Menu, MenuItem, MenuSeparator, useToast } from '../../components/ui/overlay';

const grid = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 md:grid-cols-[minmax(0,2.4fr)_110px_90px_minmax(0,1.2fr)_40px]';

function RoleChip({ role }: { role: UserSummary['role'] }) {
  return (
    <span className={cn('inline-flex h-[22px] items-center rounded-md px-2 text-xs font-medium capitalize', role === 'owner' ? 'bg-primary-soft text-primary-text' : role === 'admin' ? 'bg-surface-3 text-muted' : 'bg-surface-2 text-muted')}>
      {role}
    </span>
  );
}

export function UsersPage() {
  const me = useUser();
  const [params, setParams] = useSearchParams();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => get<UserSummary[]>('/admin/users') });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [deleting, setDeleting] = useState<UserSummary | null>(null);
  const [secret, setSecret] = useState<{ name: string; email: string; password: string } | null>(null);
  const { run } = useAction();
  const invalidate = useInvalidate();
  const refresh = () => invalidate(['admin', 'users'], ['admin', 'mailboxes'], ['admin', 'overview']);

  // "Invite people" on the overview links here with ?add=1.
  useEffect(() => {
    if (params.get('add')) {
      setCreating(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  if (users.isLoading) return <PageSpinner />;
  const list = users.data ?? [];

  return (
    <div>
      <PageHeader
        title="Users"
        description="People who can sign in. Each person sees only the inboxes they're a member of."
        actions={
          <Button variant="primary" icon={<UserPlus className="h-[15px] w-[15px]" />} onClick={() => setCreating(true)}>
            Add a user
          </Button>
        }
      />
      <Card>
        {list.length === 0 ? (
          <EmptyState icon={<UsersRound />} title="No users yet" />
        ) : (
          <>
            <div className={cn(grid, 'hidden h-[38px] rounded-t-xl border-b border-border bg-surface-2 text-xs font-medium text-faint md:grid')}>
              <span>Person</span>
              <span>Role</span>
              <span>Two-factor</span>
              <span>Last sign-in</span>
              <span />
            </div>
            {list.map((u) => (
              <div key={u.id} className={cn(grid, 'min-h-[58px] border-b border-border py-2 text-[13px] last:border-b-0')}>
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={u.name} address={u.email} size={32} />
                  <div className="min-w-0 leading-snug">
                    <div className="flex items-center gap-1.5 truncate font-semibold">
                      {u.name || u.email}
                      {u.id === me?.id && <span className="font-normal text-faint">(you)</span>}
                      {u.status === 'disabled' && (
                        <Badge tone="danger" pill>
                          Disabled
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-[12.5px] text-muted">{u.email}</div>
                  </div>
                </div>
                <span className="hidden md:block">
                  <RoleChip role={u.role} />
                </span>
                <span className="hidden md:block" title={u.totpEnabled ? 'Two-factor on' : 'Two-factor off'}>
                  {u.totpEnabled ? <ShieldCheck className="h-4 w-4 text-success" /> : <Minus className="h-4 w-4 text-faint" />}
                </span>
                <span className="hidden truncate text-[12.5px] text-muted md:block">
                  {u.lastLoginAt ? timeAgo(u.lastLoginAt) : u.mustChangePassword ? 'Not signed in yet' : 'Never signed in'}
                </span>
                <Menu trigger={({ onClick, open }) => <IconButton label="Actions" onClick={onClick} icon={<Ellipsis />} className={cn(open && 'bg-surface-2 text-fg')} />}>
                  <MenuItem icon={<Pencil />} onClick={() => setEditing(u)}>
                    Edit user
                  </MenuItem>
                  <MenuItem
                    icon={<KeyRound />}
                    disabled={u.role === 'owner' && u.id !== me?.id}
                    onClick={() =>
                      run('reset', async () => {
                        const r = await post<{ password: string }>(`/admin/users/${u.id}/reset-password`);
                        setSecret({ name: u.name, email: u.email, password: r.password });
                        await refresh();
                      })
                    }
                  >
                    Reset password
                  </MenuItem>
                  {u.totpEnabled && (
                    <MenuItem icon={<ShieldOff />} onClick={() => run('2fa', () => post(`/admin/users/${u.id}/reset-2fa`).then(refresh), 'Two-factor turned off for this user')}>
                      Turn off two-factor
                    </MenuItem>
                  )}
                  {u.role !== 'owner' && (
                    <MenuItem icon={u.status === 'active' ? <Ban /> : <CircleCheck />} onClick={() => run('status', () => patch(`/admin/users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' }).then(refresh))}>
                      {u.status === 'active' ? 'Disable sign-in' : 'Enable sign-in'}
                    </MenuItem>
                  )}
                  {u.role !== 'owner' && u.id !== me?.id && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 />} danger onClick={() => setDeleting(u)}>
                        Delete user
                      </MenuItem>
                    </>
                  )}
                </Menu>
              </div>
            ))}
          </>
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
      {editing && (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {deleting && (
        <DeleteUserDialog
          user={deleting}
          users={list}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            refresh();
          }}
        />
      )}
      {secret && <SecretDialog secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function SecretDialog({ secret, onClose }: { secret: { name: string; email: string; password: string }; onClose: () => void }) {
  const toast = useToast();
  const rows: [string, string, boolean][] = [
    ['Sign in at', location.host, false],
    ['Email', secret.email, false],
    ['Password', secret.password, true],
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      icon={<CircleCheck />}
      tone="success"
      title="Share these sign-in details"
      description={`Send them to ${secret.name?.split(' ')[0] || 'them'} privately. The password works once; they'll choose a new one.`}
      footer={
        <>
          <Button
            icon={<Copy className="h-3.5 w-3.5" />}
            onClick={() => copyText(`Sign in at ${location.origin}\nEmail: ${secret.email}\nPassword: ${secret.password}`).then(() => toast.success('Copied'))}
          >
            Copy all
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="overflow-hidden rounded-[10px] border border-border text-[13px]">
        {rows.map(([k, v, mono]) => (
          <div key={k} className="flex min-h-11 items-center gap-2.5 border-b border-border py-1.5 pr-2 pl-3.5 last:border-b-0">
            <span className="w-[84px] shrink-0 text-[12.5px] text-faint">{k}</span>
            <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono tracking-[0.02em]')}>{v}</span>
            {mono && <CopyButton text={v} />}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { name: string; email: string; password: string }) => void }) {
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
  const suggested = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await post<{ email: string; password: string }>('/admin/users', {
        name,
        role,
        email: mode === 'existing' ? email : undefined,
        newMailbox: mode === 'new' ? { localPart: localPart || suggested, domainId: domain?.id } : null,
        mailboxIds: shared,
      });
      onCreated({ name, ...r });
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
      description="They get a temporary password and choose their own on first sign-in."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-user" loading={busy}>
            Add user
          </Button>
        </>
      }
    >
      <form id="create-user" onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid grid-cols-[1fr_150px] gap-2.5">
          <Field label="Name" id="name">
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Role" id="role">
            <Select id="role" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
        </div>
        <p className="-mt-2 text-xs text-muted">{role === 'admin' ? 'Admins manage domains, providers, inboxes and users.' : 'Members use their inboxes and nothing else.'}</p>
        <ChoiceCards
          value={mode}
          onChange={setMode}
          options={[
            { value: 'new', label: 'Create a new inbox', hint: 'This becomes their inbox and their sign-in.' },
            { value: 'existing', label: 'Sign-in email only', hint: 'Any address; give them access to shared inboxes below.' },
          ]}
        />
        {mode === 'new' ? (
          <Field label="Their address" id="local">
            <AddressInput id="local" local={localPart} onLocal={setLocalPart} domainId={domain?.id} onDomain={setDomainId} domains={domainList} placeholder={suggested || 'jane'} />
          </Field>
        ) : (
          <Field label="Sign-in email" id="email">
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
        )}
        {!!mailboxes.data?.length && (
          <Field label="Also give access to">
            <div className="scroll-thin flex max-h-40 flex-col gap-2 overflow-y-auto pt-0.5">
              {mailboxes.data.map((m) => {
                const on = shared.includes(m.id);
                const toggle = (v: boolean) => setShared((s) => (v ? [...s, m.id] : s.filter((x) => x !== m.id)));
                return (
                  <div key={m.id} className="flex cursor-pointer items-center gap-2.5 text-[13px]" onClick={() => toggle(!on)}>
                    <Tick checked={on} onChange={toggle} label={m.address} />
                    {m.address}
                    <span className="truncate text-faint">· {m.displayName || (m.kind === 'shared' ? 'Shared inbox' : 'Personal')}</span>
                  </div>
                );
              })}
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
      description="Inbox access is managed on the Inboxes page."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={!!busy} onClick={() => run('save', () => patch(`/admin/users/${user.id}`, { name, email, ...(user.role !== 'owner' ? { role } : {}) }).then(onSaved), 'User updated')}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-2.5 sm:grid-cols-[1fr_150px]">
          <Field label="Name" id="ename">
            <Input id="ename" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {user.role !== 'owner' && (
            <Field label="Role" id="erole">
              <Select id="erole" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
          )}
        </div>
        <Field label="Sign-in email" id="eemail">
          <Input id="eemail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function DeleteUserDialog({ user, users, onClose, onDeleted }: { user: UserSummary; users: UserSummary[]; onClose: () => void; onDeleted: () => void }) {
  const [reassign, setReassign] = useState<number | ''>('');
  const { run, busy } = useAction();
  const target = users.find((u) => u.id === reassign);
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
      <div className="mt-4 text-fg">
        <Field label="Give their inbox access and assigned conversations to" hint={target ? `Their inboxes and assigned conversations move to ${target.name || target.email}.` : undefined}>
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
