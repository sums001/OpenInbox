import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, Key, Plus, Settings, X } from 'lucide-react';
import { del, get, patch, post } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import { Button, IconButton } from '../../components/ui/button';
import { Field, Input, Select } from '../../components/ui/form';
import { Alert, Card, CardHeader, PageHeader, PageSpinner, StatusPill } from '../../components/ui/misc';
import { ConfirmDialog } from '../../components/ui/overlay';

interface InstanceSettings {
  instanceName: string;
  maxInboundMb: number;
  trashRetentionDays: number;
  spamRetentionDays: number;
  spamPolicy: 'spam' | 'reject' | 'off';
  remoteImages: 'block' | 'allow';
  appUrl: string | null;
  version: string;
  keyRotation: boolean;
}

export function AdminSettingsPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings" description="Instance-wide behavior, forwarding, blocked senders and maintenance." />
      <GeneralSettings />
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <ForwardingSettings />
        <BlockedSenders />
        <Suppressions />
        <Maintenance />
      </div>
    </div>
  );
}

// A number input with its unit inside the field: 30 days.
function WithUnit({ unit, children }: { unit: string; children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12.5px] text-faint">{unit}</span>
    </div>
  );
}

function GeneralSettings() {
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<InstanceSettings>('/admin/settings') });
  const [s, setS] = useState<InstanceSettings | null>(null);
  const { run, busy } = useAction();
  const invalidate = useInvalidate();
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  if (!s) return <PageSpinner />;
  const set = <K extends keyof InstanceSettings>(k: K, v: InstanceSettings[K]) => setS({ ...s, [k]: v });
  return (
    <Card>
      <CardHeader icon={<Settings />} title="General" />
      <div className="grid gap-x-6 gap-y-[18px] px-5 pt-[18px] pb-5 md:grid-cols-2">
        <Field label="Instance name" hint="Shown in the header and on the sign-in page.">
          <Input value={s.instanceName} onChange={(e) => set('instanceName', e.target.value)} />
        </Field>
        <Field label="App address" hint="Used in webhook URLs and links. Set automatically at setup.">
          <Input value={s.appUrl ?? ''} onChange={(e) => set('appUrl', e.target.value)} placeholder="https://mail.example.com" />
        </Field>
        <Field label="Largest message accepted" hint="Email Routing allows up to 25 MB. Bigger mail is rejected and the sender is told.">
          <Select value={s.maxInboundMb} onChange={(e) => set('maxInboundMb', Number(e.target.value))}>
            {[5, 10, 15, 20, 25].map((n) => (
              <option key={n} value={n}>
                {n} MB
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Failed SPF / DKIM / DMARC" hint="What to do with mail that fails sender authentication.">
          <Select value={s.spamPolicy} onChange={(e) => set('spamPolicy', e.target.value as InstanceSettings['spamPolicy'])}>
            <option value="off">Deliver normally</option>
            <option value="spam">Move to Spam</option>
            <option value="reject">Reject it</option>
          </Select>
        </Field>
        <Field label="Empty Trash after" hint="Conversations in Trash are deleted permanently after this many days.">
          <WithUnit unit="days">
            <Input type="number" min={1} value={s.trashRetentionDays} onChange={(e) => set('trashRetentionDays', Number(e.target.value))} className="pr-12" />
          </WithUnit>
        </Field>
        <Field label="Empty Spam after" hint="Spam is deleted permanently after this many days.">
          <WithUnit unit="days">
            <Input type="number" min={1} value={s.spamRetentionDays} onChange={(e) => set('spamRetentionDays', Number(e.target.value))} className="pr-12" />
          </WithUnit>
        </Field>
        <Field label="Remote images in mail" hint="Remote images can track when you open a message. Users can always load them per message.">
          <Select value={s.remoteImages} onChange={(e) => set('remoteImages', e.target.value as InstanceSettings['remoteImages'])}>
            <option value="block">Block until allowed</option>
            <option value="allow">Always load</option>
          </Select>
        </Field>
      </div>
      <div className="flex justify-end border-t border-border px-5 py-3">
        <Button
          variant="primary"
          size="sm"
          loading={busy === 'save'}
          onClick={() =>
            run(
              'save',
              async () => {
                const { version: _v, keyRotation: _k, appUrl, ...rest } = s;
                await patch('/admin/settings', { ...rest, ...(appUrl ? { appUrl } : {}) });
                await invalidate(['admin', 'settings'], ['session']);
              },
              'Settings saved',
            )
          }
        >
          Save changes
        </Button>
      </div>
    </Card>
  );
}

const row = 'flex items-center gap-2.5 border-b border-border px-5 py-2.5 text-[13px]';

function ForwardingSettings() {
  const q = useQuery({ queryKey: ['admin', 'forwarding'], queryFn: () => get<{ address: string; verified: boolean }[]>('/admin/forwarding') });
  const [email, setEmail] = useState('');
  const { run, busy } = useAction();
  return (
    <Card>
      <CardHeader title="Forwarding addresses" description="Members choose which verified address their mailbox forwards to in Mail settings." />
      {q.data?.map((d) => (
        <div key={d.address} className={row}>
          <span className="min-w-0 flex-1 truncate">{d.address}</span>
          <StatusPill tone={d.verified ? 'success' : 'warning'}>{d.verified ? 'Verified' : 'Pending'}</StatusPill>
          <IconButton label="Remove" onClick={() => run('rm', () => del(`/admin/forwarding/${encodeURIComponent(d.address)}`).then(() => q.refetch()))} icon={<X />} className="h-7 w-7 [&>svg]:h-3.5 [&>svg]:w-3.5" />
        </div>
      ))}
      <form
        className="flex gap-2 px-5 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            'add',
            () =>
              post('/admin/forwarding', { email }).then(() => {
                setEmail('');
                q.refetch();
              }),
            'Verification email sent',
          );
        }}
      >
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="me@gmail.com" required aria-label="Forwarding address" />
        <Button type="submit" icon={<Plus className="h-3.5 w-3.5" />} loading={busy === 'add'} className="h-9">
          Add
        </Button>
      </form>
      <p className="px-5 pb-4 text-xs text-faint text-pretty">Cloudflare emails each one a verification link. Forwarding is free and doesn't use your sending quota.</p>
    </Card>
  );
}

function BlockedSenders() {
  const q = useQuery({ queryKey: ['admin', 'blocked'], queryFn: () => get<{ id: number; pattern: string; address: string | null; created_at: number }[]>('/admin/blocked') });
  const [pattern, setPattern] = useState('');
  const { run } = useAction();
  return (
    <Card>
      <CardHeader title="Blocked senders" description="Mail from these addresses or @domains is rejected." />
      <form
        className="flex gap-2 border-b border-border px-5 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          run('add', () =>
            post('/admin/blocked', { pattern }).then(() => {
              setPattern('');
              q.refetch();
            }),
          );
        }}
      >
        <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="spammer@example.com or @example.com" required aria-label="Address or domain to block" />
        <Button type="submit" className="h-9">
          Block
        </Button>
      </form>
      {q.data?.length === 0 && <div className="px-5 py-5 text-center text-[13px] text-muted">Nobody is blocked.</div>}
      {q.data?.map((b) => (
        <div key={b.id} className={row}>
          <Ban className="h-3.5 w-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-mono text-[12.5px]">{b.pattern}</span> <span className="text-xs text-faint">{b.address ? `for ${b.address}` : 'for every inbox'}</span>
          </span>
          <button type="button" className="text-[12.5px] text-muted hover:text-fg" onClick={() => run('rm', () => del(`/admin/blocked/${b.id}`).then(() => q.refetch()))}>
            Remove
          </button>
        </div>
      ))}
    </Card>
  );
}

function Suppressions() {
  const q = useQuery({ queryKey: ['admin', 'suppressions'], queryFn: () => get<{ address: string; reason: string; detail: string | null; created_at: number }[]>('/admin/suppressions') });
  const { run } = useAction();
  return (
    <Card>
      <CardHeader title="Suppressed recipients" description="Addresses that bounced or marked your mail as spam. Sends to them are skipped, protecting your sender reputation." />
      {q.data?.length === 0 && <div className="px-5 py-[22px] text-center text-[13px] text-muted">None. Delivery webhooks add addresses here automatically.</div>}
      {q.data?.map((s) => (
        <div key={s.address} className={row}>
          <div className="min-w-0 flex-1">
            <div className="truncate">{s.address}</div>
            <div className="truncate text-xs text-muted">
              {s.reason} · {timeAgo(s.created_at)} {s.detail ? `· ${s.detail}` : ''}
            </div>
          </div>
          <button type="button" className="text-[12.5px] text-muted hover:text-fg" onClick={() => run('rm', () => del(`/admin/suppressions/${encodeURIComponent(s.address)}`).then(() => q.refetch()))}>
            Remove
          </button>
        </div>
      ))}
    </Card>
  );
}

function Maintenance() {
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<InstanceSettings>('/admin/settings') });
  const [confirm, setConfirm] = useState(false);
  const { run, busy } = useAction();
  const code = (t: string) => <code className="rounded bg-surface-2 px-1 font-mono text-[12px] text-fg">{t}</code>;
  const steps: ReactNode[] = [
    <>
      In the Worker's settings, add the current key as a new secret {code('ENCRYPTION_KEY_PREVIOUS')}, then set {code('ENCRYPTION_KEY')} to a new random value.
    </>,
    'Come back here and re-encrypt everything with the new key.',
    <>Delete {code('ENCRYPTION_KEY_PREVIOUS')}.</>,
  ];
  return (
    <Card>
      <CardHeader title="Encryption key rotation" description="Stored credentials (provider keys, the Cloudflare token, R2 keys, 2FA secrets) are encrypted with ENCRYPTION_KEY." />
      <div className="flex flex-col gap-2.5 px-5 py-3.5 text-[13px]">
        {steps.map((t, i) => (
          <div key={i} className="flex gap-2.5">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-muted">{i + 1}</span>
            <span className="leading-normal text-muted text-pretty">{t}</span>
          </div>
        ))}
        {settings.data?.keyRotation && <Alert tone="warning">ENCRYPTION_KEY_PREVIOUS is set: a rotation is in progress.</Alert>}
        <div className="mt-1 flex items-center justify-between gap-3">
          <Button size="sm" onClick={() => setConfirm(true)} icon={<Key className="h-3.5 w-3.5" />}>
            Re-encrypt now
          </Button>
          <span className="text-xs text-faint">OpenInbox {settings.data?.version}</span>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        icon={<Key />}
        title="Re-encrypt with the current key?"
        confirmLabel="Re-encrypt"
        loading={!!busy}
        onConfirm={() => run('re', () => post('/admin/reencrypt').then(() => setConfirm(false)), 'Secrets re-encrypted')}
      >
        Every stored secret is decrypted (with either key) and saved again with ENCRYPTION_KEY. Mail isn't affected.
      </ConfirmDialog>
    </Card>
  );
}
