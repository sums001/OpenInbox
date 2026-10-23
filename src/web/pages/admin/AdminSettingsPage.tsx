import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, CircleCheck, Clock, KeyRound, Forward, Plus, Settings2, ShieldOff, Trash } from 'lucide-react';
import { del, get, patch, post } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import { Button } from '../../components/ui/button';
import { Field, Input, Select } from '../../components/ui/form';
import { Alert, Badge, Card, CardHeader, PageHeader, PageSpinner } from '../../components/ui/misc';
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
    <div className="space-y-6">
      <PageHeader title="Settings" description="Instance-wide behavior, forwarding, blocked senders and maintenance." />
      <GeneralSettings />
      <ForwardingSettings />
      <div className="grid gap-6 lg:grid-cols-2">
        <BlockedSenders />
        <Suppressions />
      </div>
      <Maintenance />
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
      <CardHeader icon={<Settings2 className="h-5 w-5" />} title="General" />
      <div className="grid gap-5 p-5 md:grid-cols-2">
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
            <option value="spam">Move to Spam</option>
            <option value="reject">Reject it</option>
            <option value="off">Deliver normally</option>
          </Select>
        </Field>
        <Field label="Empty Trash after" hint="Conversations in Trash are deleted permanently after this many days.">
          <Input type="number" min={1} value={s.trashRetentionDays} onChange={(e) => set('trashRetentionDays', Number(e.target.value))} />
        </Field>
        <Field label="Empty Spam after">
          <Input type="number" min={1} value={s.spamRetentionDays} onChange={(e) => set('spamRetentionDays', Number(e.target.value))} />
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
          loading={busy === 'save'}
          onClick={() =>
            run('save', async () => {
              const { version: _v, keyRotation: _k, appUrl, ...rest } = s;
              await patch('/admin/settings', { ...rest, ...(appUrl ? { appUrl } : {}) });
              await invalidate(['admin', 'settings'], ['session']);
            }, 'Settings saved')
          }
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

function ForwardingSettings() {
  const q = useQuery({ queryKey: ['admin', 'forwarding'], queryFn: () => get<{ address: string; verified: boolean }[]>('/admin/forwarding') });
  const [email, setEmail] = useState('');
  const { run, busy } = useAction();
  return (
    <Card>
      <CardHeader
        icon={<Forward className="h-5 w-5" />}
        title="Forwarding addresses"
        description="Addresses outside OpenInbox that mailboxes may forward copies to. Cloudflare emails each one a verification link; forwarding is free and doesn't use your sending quota."
      />
      <div className="space-y-3 p-5">
        {q.data?.map((d) => (
          <div key={d.address} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
            <span>{d.address}</span>
            <div className="flex items-center gap-2">
              {d.verified ? (
                <Badge tone="success">
                  <CircleCheck className="h-3 w-3" /> Verified
                </Badge>
              ) : (
                <Badge tone="warning">
                  <Clock className="h-3 w-3" /> Waiting for verification
                </Badge>
              )}
              <Button size="xs" variant="ghost" icon={<Trash className="h-3.5 w-3.5" />} onClick={() => run('rm', () => del(`/admin/forwarding/${encodeURIComponent(d.address)}`).then(() => q.refetch()))} />
            </div>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run('add', () => post('/admin/forwarding', { email }).then(() => { setEmail(''); q.refetch(); }), 'Verification email sent');
          }}
        >
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="me@gmail.com" required />
          <Button type="submit" icon={<Plus className="h-4 w-4" />} loading={busy === 'add'}>
            Add
          </Button>
        </form>
        <p className="text-xs text-muted">Members choose which verified address their mailbox forwards to in Mail settings.</p>
      </div>
    </Card>
  );
}

function BlockedSenders() {
  const q = useQuery({ queryKey: ['admin', 'blocked'], queryFn: () => get<{ id: number; pattern: string; address: string | null; created_at: number }[]>('/admin/blocked') });
  const [pattern, setPattern] = useState('');
  const { run } = useAction();
  return (
    <Card>
      <CardHeader icon={<Ban className="h-5 w-5" />} title="Blocked senders" description="Mail from these addresses or @domains is rejected." />
      <div className="space-y-2 p-5">
        {q.data?.length === 0 && <div className="text-[13px] text-muted">Nobody is blocked.</div>}
        {q.data?.map((b) => (
          <div key={b.id} className="flex items-center justify-between text-sm">
            <span>
              {b.pattern} <span className="text-xs text-muted">{b.address ? `for ${b.address}` : 'for everyone'}</span>
            </span>
            <Button size="xs" variant="ghost" onClick={() => run('rm', () => del(`/admin/blocked/${b.id}`).then(() => q.refetch()))}>
              Unblock
            </Button>
          </div>
        ))}
        <form
          className="flex gap-2 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            run('add', () => post('/admin/blocked', { pattern }).then(() => { setPattern(''); q.refetch(); }));
          }}
        >
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="spammer@example.com or @example.com" required />
          <Button type="submit">Block</Button>
        </form>
      </div>
    </Card>
  );
}

function Suppressions() {
  const q = useQuery({ queryKey: ['admin', 'suppressions'], queryFn: () => get<{ address: string; reason: string; detail: string | null; created_at: number }[]>('/admin/suppressions') });
  const { run } = useAction();
  return (
    <Card>
      <CardHeader icon={<ShieldOff className="h-5 w-5" />} title="Suppressed recipients" description="Addresses that hard-bounced or marked your mail as spam. OpenInbox won't send to them, protecting your sender reputation." />
      <div className="space-y-2 p-5">
        {q.data?.length === 0 && <div className="text-[13px] text-muted">None. Delivery webhooks add addresses here automatically.</div>}
        {q.data?.map((s) => (
          <div key={s.address} className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <div className="truncate">{s.address}</div>
              <div className="truncate text-xs text-muted">
                {s.reason} · {timeAgo(s.created_at)} {s.detail ? `· ${s.detail}` : ''}
              </div>
            </div>
            <Button size="xs" variant="ghost" onClick={() => run('rm', () => del(`/admin/suppressions/${encodeURIComponent(s.address)}`).then(() => q.refetch()))}>
              Remove
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Maintenance() {
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<InstanceSettings>('/admin/settings') });
  const [confirm, setConfirm] = useState(false);
  const { run, busy } = useAction();
  return (
    <Card>
      <CardHeader icon={<KeyRound className="h-5 w-5" />} title="Encryption key rotation" description="Stored credentials (provider keys, the Cloudflare token, R2 keys, 2FA secrets) are encrypted with ENCRYPTION_KEY." />
      <div className="space-y-3 p-5 text-[13px] text-muted">
        <ol className="list-decimal space-y-1 pl-5">
          <li>In the Worker's settings, add the current key as a new secret <code className="rounded bg-surface-2 px-1">ENCRYPTION_KEY_PREVIOUS</code>, then set <code className="rounded bg-surface-2 px-1">ENCRYPTION_KEY</code> to a new random value.</li>
          <li>Come back here and re-encrypt everything with the new key.</li>
          <li>Delete <code className="rounded bg-surface-2 px-1">ENCRYPTION_KEY_PREVIOUS</code>.</li>
        </ol>
        {settings.data?.keyRotation && <Alert tone="warning">ENCRYPTION_KEY_PREVIOUS is set: a rotation is in progress.</Alert>}
        <Button onClick={() => setConfirm(true)} icon={<KeyRound className="h-4 w-4" />}>
          Re-encrypt stored secrets
        </Button>
        <div className="text-xs text-faint">OpenInbox {settings.data?.version}</div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Re-encrypt with the current key?"
        confirmLabel="Re-encrypt"
        loading={!!busy}
        onConfirm={() => run('re', () => post('/admin/reencrypt').then(() => setConfirm(false)), 'Secrets re-encrypted')}
      >
        Every stored secret is decrypted (with either key) and encrypted again with ENCRYPTION_KEY.
      </ConfirmDialog>
    </Card>
  );
}
