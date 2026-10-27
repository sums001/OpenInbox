import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { renderSVG } from 'uqr';
import { Bell, KeyRound, Laptop, Monitor, Moon, Shield, Sun, Trash } from 'lucide-react';
import { del, get, patch, post, errorText } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction } from '../../lib/hooks';
import { useRefreshSession, useUser } from '../../lib/session';
import { useTheme } from '../../lib/theme';
import { storageGet, storageSet } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Field, Input, PasswordInput, SegmentedControl, Switch } from '../../components/ui/form';
import { Alert, Badge, Card, CardHeader, CopyButton, PageHeader } from '../../components/ui/misc';
import { Dialog } from '../../components/ui/overlay';
import { PasswordStrength } from '../../components/PasswordStrength';

// Each section is its own page in the settings sidebar.
export function ProfileSettings() {
  return (
    <div className="space-y-6">
      <PageHeader title="Profile" description="Your name and sign-in email." />
      <Profile />
    </div>
  );
}

export function AppearanceSettings() {
  return (
    <div className="space-y-6">
      <PageHeader title="Appearance" description="Theme and desktop notifications for this browser." />
      <Appearance />
    </div>
  );
}

export function SecuritySettings() {
  return (
    <div className="space-y-6">
      <PageHeader title="Security" description="Your password and two-factor authentication." />
      <Password />
      <TwoFactor />
    </div>
  );
}

export function DevicesSettings() {
  return (
    <div className="space-y-6">
      <PageHeader title="Devices" description="Browsers signed in to your account. Sign out any you don't recognize." />
      <Sessions />
    </div>
  );
}

function Profile() {
  const user = useUser();
  const refresh = useRefreshSession();
  const [name, setName] = useState(user?.name ?? '');
  const { run, busy } = useAction();
  return (
    <Card>
      <CardHeader title="Profile" />
      <div className="space-y-4 p-5">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Sign-in email" hint="Ask an admin to change it.">
          <Input value={user?.email ?? ''} disabled />
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" loading={!!busy} onClick={() => run('save', () => patch('/account', { name }).then(refresh), 'Saved')}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Appearance() {
  const [theme, setTheme] = useTheme();
  const [notify, setNotify] = useState(storageGet('oi.notify', false));
  const toggleNotify = async (on: boolean) => {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') return;
    }
    setNotify(on);
    storageSet('oi.notify', on);
  };
  return (
    <Card>
      <CardHeader title="Theme and notifications" />
      <div className="space-y-5 p-5">
        <Field label="Theme">
          <SegmentedControl
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: <span className="flex items-center gap-1.5"><Sun className="h-3.5 w-3.5" />Light</span> },
              { value: 'dark', label: <span className="flex items-center gap-1.5"><Moon className="h-3.5 w-3.5" />Dark</span> },
              { value: 'system', label: <span className="flex items-center gap-1.5"><Monitor className="h-3.5 w-3.5" />System</span> },
            ]}
          />
        </Field>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Bell className="h-4 w-4" /> Desktop notifications
            </div>
            <div className="text-xs text-muted">Notify about new inbox mail while OpenInbox is open in a background tab (this browser only).</div>
          </div>
          <Switch checked={notify} onChange={toggleNotify} label="Desktop notifications" />
        </div>
      </div>
    </Card>
  );
}

function Password() {
  const user = useUser();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { run, busy } = useAction();
  return (
    <Card>
      <CardHeader icon={<KeyRound className="h-5 w-5" />} title="Password" description="Changing it signs out your other devices." />
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (next !== confirm) return;
          run('pw', () => post('/account/password', { current, next }).then(() => { setCurrent(''); setNext(''); setConfirm(''); }), 'Password changed');
        }}
      >
        <Field label="Current password">
          <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required={!user?.mustChangePassword} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password">
            <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={10} />
          </Field>
          <Field label="Confirm" error={confirm && next !== confirm ? 'Does not match' : undefined}>
            <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </Field>
        </div>
        <PasswordStrength password={next} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={!!busy}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TwoFactor() {
  const user = useUser();
  const refresh = useRefreshSession();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disable, setDisable] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { run, busy } = useAction();
  return (
    <Card>
      <CardHeader
        icon={<Shield className="h-5 w-5" />}
        title="Two-factor authentication"
        description="Ask for a code from an authenticator app when signing in."
        action={user?.totpEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
      />
      <div className="p-5">
        {user?.totpEnabled ? (
          <Button variant="outline" onClick={() => setDisable(true)}>
            Turn off
          </Button>
        ) : (
          <Button variant="primary" loading={busy === 'start'} onClick={() => run('start', async () => setSetup(await post<{ secret: string; uri: string }>('/account/2fa/setup')))}>
            Set up two-factor
          </Button>
        )}
      </div>
      <Dialog
        open={!!setup && !codes}
        onClose={() => setSetup(null)}
        title="Scan with your authenticator app"
        footer={
          <Button
            variant="primary"
            loading={busy === 'enable'}
            onClick={() =>
              run('enable', async () => {
                setError('');
                try {
                  const r = await post<{ recoveryCodes: string[] }>('/account/2fa/enable', { code });
                  setCodes(r.recoveryCodes);
                } catch (e) {
                  setError(errorText(e));
                }
              })
            }
          >
            Verify and turn on
          </Button>
        }
      >
        {setup && (
          <div className="space-y-4">
            <div className="mx-auto w-48 rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: renderSVG(setup.uri, { border: 1 }) }} />
            <div className="text-center text-xs text-muted">
              Or enter this key: <span className="font-mono text-fg">{setup.secret.match(/.{1,4}/g)?.join(' ')}</span> <CopyButton text={setup.secret} />
            </div>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="6-digit code from the app">
              <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" className="text-center font-mono text-lg tracking-widest" autoFocus />
            </Field>
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!codes}
        onClose={() => {
          setCodes(null);
          setSetup(null);
          refresh();
        }}
        title="Save your recovery codes"
        description="Each code signs you in once if you lose your phone. They won't be shown again."
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setCodes(null);
              setSetup(null);
              refresh();
            }}
          >
            I saved them
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-2 p-4 font-mono text-sm">
          {codes?.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="mt-2 flex justify-end">
          <CopyButton text={(codes ?? []).join('\n')} label="Copy all" />
        </div>
      </Dialog>
      <Dialog
        open={disable}
        onClose={() => setDisable(false)}
        title="Turn off two-factor?"
        size="sm"
        footer={
          <Button variant="danger" loading={busy === 'disable'} onClick={() => run('disable', () => post('/account/2fa/disable', { current: password }).then(() => { setDisable(false); setPassword(''); refresh(); }), 'Two-factor turned off')}>
            Turn off
          </Button>
        }
      >
        <Field label="Your password">
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
      </Dialog>
    </Card>
  );
}

function Sessions() {
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ id: string; ip: string | null; userAgent: string | null; createdAt: number; lastSeenAt: number; current: boolean }[]>('/account/sessions') });
  const { run } = useAction();
  const describe = (ua: string | null) => {
    if (!ua) return 'Unknown device';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
    return `${browser}${os ? ` on ${os}` : ''}`;
  };
  useEffect(() => undefined, []);
  return (
    <Card>
      <CardHeader
        icon={<Laptop className="h-5 w-5" />}
        title="Signed-in devices"
        action={
          (q.data?.length ?? 0) > 1 && (
            <Button size="sm" onClick={() => run('all', () => post('/account/sessions/revoke-others').then(() => q.refetch()), 'Signed out everywhere else')}>
              Sign out others
            </Button>
          )
        }
      />
      <div className="divide-y divide-border">
        {q.data?.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {describe(s.userAgent)} {s.current && <Badge tone="success">This device</Badge>}
              </div>
              <div className="text-xs text-muted">
                {s.ip ?? 'unknown IP'} · active {timeAgo(s.lastSeenAt)} · signed in {timeAgo(s.createdAt)}
              </div>
            </div>
            {!s.current && (
              <Button size="xs" variant="ghost" icon={<Trash className="h-3.5 w-3.5" />} onClick={() => run('rm', () => del(`/account/sessions/${s.id}`).then(() => q.refetch()))}>
                Sign out
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
