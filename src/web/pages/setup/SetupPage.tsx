import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ArrowLeft, Check, ChevronDown, CircleCheck, CircleDashed, CircleX, Cloud, Download, ExternalLink, KeyRound, LoaderCircle, Mail, RefreshCw, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { ApiError, errorText, get, post } from '../../lib/api';
import { cn, downloadBlob } from '../../lib/utils';
import { tokenTemplateUrl, TOKEN_PERMISSIONS } from '../../../shared/constants';
import type { DomainSetupStep, PermissionCheck, ZoneInspection } from '../../lib/types';
import { LogoMark } from '../../components/Logo';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input, PasswordInput, Select } from '../../components/ui/form';
import { Alert, Badge, Card, CopyButton } from '../../components/ui/misc';
import { PasswordStrength } from '../../components/PasswordStrength';

interface Check {
  ok: boolean;
  message: string;
  warning?: boolean;
  pending?: boolean;
}

type KeyState = 'missing' | 'activating' | 'generated' | 'set';

interface SetupStatus {
  setupComplete: boolean;
  checks: {
    database: Check;
    encryptionKey: Check & { state: KeyState };
    cloudflare: Check & { source: 'secret' | 'stored' | null };
    worker: Check & { name?: string; subdomain?: string | null; accountName?: string };
    zones: Check & { count: number };
  };
  permissions: PermissionCheck[];
  zones: { id: string; name: string; status: string }[];
}

type Stage = 'checks' | 'admin' | 'domain' | 'done';

export function SetupPage() {
  const [stage, setStage] = useState<Stage>('checks');
  const [claim, setClaim] = useState<{ domainId: number; address: string; domain: string } | null>(null);
  // The generated recovery key, kept only in this page's memory: the server shows it once.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => get<SetupStatus>('/setup/status'),
    retry: false,
    // A new key reaches the Worker within seconds; check until it has.
    refetchInterval: (q) => (q.state.data?.checks.encryptionKey.state === 'activating' ? 2000 : false),
  });

  const steps: { id: Stage; label: string }[] = [
    { id: 'checks', label: 'Check deployment' },
    { id: 'admin', label: 'Create admin email' },
    { id: 'domain', label: 'Connect domain' },
  ];
  const current = stage === 'done' ? 3 : steps.findIndex((s) => s.id === stage);

  return (
    <div className="min-h-full bg-bg">
      <div className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoMark size={48} />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Welcome to OpenInbox</h1>
          <p className="mt-1.5 max-w-md text-sm text-muted">Your own email on your own domains, running in your Cloudflare account. Setup takes about two minutes.</p>
        </div>
        <ol className="mb-6 flex items-center justify-center gap-2 text-[13px]">
          {steps.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                  i < current ? 'bg-success text-white' : i === current ? 'bg-primary text-primary-fg' : 'bg-surface-3 text-muted',
                )}
              >
                {i < current ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cn('hidden sm:inline', i === current ? 'font-medium text-fg' : 'text-muted')}>{s.label}</span>
              {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border-strong sm:w-10" />}
            </li>
          ))}
        </ol>

        {stage === 'checks' && (
          <ChecksStage
            status={status.data}
            loading={status.isFetching}
            error={status.error}
            refetch={() => status.refetch()}
            recoveryKey={recoveryKey}
            onRecoveryKey={setRecoveryKey}
            onContinue={() => setStage('admin')}
          />
        )}
        {stage === 'admin' && status.data && (
          <AdminStage
            zones={status.data.zones}
            keyState={status.data.checks.encryptionKey.state}
            onBack={() => setStage('checks')}
            onClaimed={(c) => {
              setClaim(c);
              setStage('domain');
            }}
          />
        )}
        {stage === 'domain' && claim && <DomainStage claim={claim} onDone={() => setStage('done')} />}
        {stage === 'done' && claim && <DoneStage address={claim.address} />}
      </div>
    </div>
  );
}

function CheckRow({ label, check, loading, children }: { label: string; check?: Check; loading: boolean; children?: ReactNode }) {
  const icon = loading && !check ? (
    <LoaderCircle className="h-5 w-5 animate-spin text-muted" />
  ) : check?.pending ? (
    <CircleDashed className="h-5 w-5 text-muted" />
  ) : check?.ok && !check.warning ? (
    <CircleCheck className="h-5 w-5 text-success" />
  ) : check?.ok ? (
    <TriangleAlert className="h-5 w-5 text-warning" />
  ) : (
    <CircleX className="h-5 w-5 text-danger" />
  );
  return (
    <div className="flex gap-3 px-5 py-3.5">
      <div className="mt-0.5">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[13px] text-muted">{check?.message ?? 'Checking…'}</div>
        {children}
      </div>
    </div>
  );
}

function ChecksStage({
  status,
  loading,
  error,
  refetch,
  recoveryKey,
  onRecoveryKey,
  onContinue,
}: {
  status?: SetupStatus;
  loading: boolean;
  error: unknown;
  refetch: () => void;
  recoveryKey: string | null;
  onRecoveryKey: (key: string) => void;
  onContinue: () => void;
}) {
  const qc = useQueryClient();
  const [showPerms, setShowPerms] = useState(false);
  const [changingToken, setChangingToken] = useState(false);
  const [replacingKey, setReplacingKey] = useState(false);
  const c = status?.checks;
  const missing = status?.permissions.filter((p) => !p.ok && !p.untested) ?? [];
  const missingRequired = missing.filter((p) => !p.optional);
  const missingOptional = missing.filter((p) => p.optional);
  const untested = status?.permissions.filter((p) => p.untested) ?? [];
  const keyState = c?.encryptionKey.state;
  const ready = !!c && c.database.ok && c.encryptionKey.ok && c.cloudflare.ok && c.worker.ok && c.zones.ok && missingRequired.length === 0;
  const needsToken = !!c && c.database.ok && keyState !== 'activating' && !c.cloudflare.ok;
  const canChangeToken = !!c && c.cloudflare.ok && c.cloudflare.source === 'stored';
  const saved = (key: string | null) => {
    if (key) onRecoveryKey(key);
    refetch();
  };

  useEffect(() => {
    if (status?.setupComplete) qc.invalidateQueries({ queryKey: ['session'] });
  }, [status?.setupComplete, qc]);

  if (error && !status) {
    return <Alert tone="danger" title="Setup is unavailable" action={<Button size="sm" onClick={refetch}>Retry</Button>}>{errorText(error)}</Alert>;
  }

  return (
    <div className="space-y-4">
      <Card className="divide-y divide-border overflow-hidden">
        <CheckRow label="Database" check={c?.database} loading={loading} />
        <CheckRow label="Recovery key" check={c?.encryptionKey} loading={loading}>
          {recoveryKey && keyState !== 'set' && <RecoveryKey value={recoveryKey} />}
          {!recoveryKey && keyState === 'generated' && !replacingKey && (
            <button type="button" className="mt-1 text-[13px] text-primary hover:underline" onClick={() => setReplacingKey(true)}>
              Didn't save the key? Create a new one
            </button>
          )}
          {!recoveryKey && keyState === 'generated' && replacingKey && (
            <TokenForm
              newKey
              onSaved={(key) => {
                setReplacingKey(false);
                saved(key);
              }}
              onCancel={() => setReplacingKey(false)}
            />
          )}
        </CheckRow>
        <CheckRow label="Cloudflare connection" check={c?.cloudflare} loading={loading}>
          {needsToken && <TokenForm createsKey={keyState === 'missing'} onSaved={saved} />}
          {canChangeToken && !changingToken && (
            <button type="button" className="mt-1 text-[13px] text-primary hover:underline" onClick={() => setChangingToken(true)}>
              Use a different token
            </button>
          )}
          {canChangeToken && changingToken && (
            <TokenForm
              onSaved={(key) => {
                setChangingToken(false);
                saved(key);
              }}
              onCancel={() => setChangingToken(false)}
            />
          )}
          {c?.cloudflare.ok && c.cloudflare.source === 'secret' && (
            <div className="mt-1 text-xs text-faint">From the CF_API_TOKEN secret. Change it in the Worker's Settings → Variables and Secrets.</div>
          )}
        </CheckRow>
        <CheckRow label="This Worker" check={c?.worker} loading={loading} />
        <CheckRow label="Your domains" check={c?.zones} loading={loading}>
          {c?.zones.ok && <div className="mt-2 flex flex-wrap gap-1.5">{status?.zones.map((z) => <Badge key={z.id}>{z.name}</Badge>)}</div>}
          {c?.cloudflare.ok && !c.zones.ok && c.zones.count === 0 && (
            <a href="https://dash.cloudflare.com/?to=/:account/add-site" target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[13px] text-primary hover:underline">
              Add a domain to Cloudflare <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </CheckRow>
        {!!status?.permissions.length && (
          <div className="px-5 py-3.5">
            <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => setShowPerms((s) => !s)}>
              {missingRequired.length ? <CircleX className="h-5 w-5 text-danger" /> : untested.length ? <CircleDashed className="h-5 w-5 text-muted" /> : missingOptional.length ? <TriangleAlert className="h-5 w-5 text-warning" /> : <ShieldCheck className="h-5 w-5 text-success" />}
              <div className="flex-1">
                <div className="text-sm font-medium">Token permissions</div>
                <div className="text-[13px] text-muted">
                  {missingRequired.length
                    ? `${missingRequired.length} required permission(s) missing.`
                    : untested.length
                      ? 'No problems so far. Domain permissions are checked once a domain is in the account.'
                      : missingOptional.length
                        ? `All required permissions present. ${missingOptional.length} optional one(s) missing; some extras will be unavailable.`
                        : 'All permissions present.'}
                </div>
              </div>
              <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', showPerms && 'rotate-180')} />
            </button>
            {(showPerms || missingRequired.length > 0) && <PermissionList permissions={status.permissions} />}
          </div>
        )}
      </Card>
      <div className="flex items-center justify-between">
        <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={refetch} loading={loading}>
          Check again
        </Button>
        <Button variant="primary" size="lg" disabled={!ready} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}

export function PermissionList({ permissions }: { permissions: PermissionCheck[] }) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border">
      {permissions.map((p) => (
        <div key={p.key} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-0">
          {p.ok ? <Check className="h-4 w-4 text-success" /> : p.untested ? <CircleDashed className="h-4 w-4 text-faint" /> : p.optional ? <TriangleAlert className="h-4 w-4 text-warning" /> : <CircleX className="h-4 w-4 text-danger" />}
          <div className="min-w-0 flex-1">
            <div className="text-[13px]">
              <span className="text-muted">{p.scope} →</span> <span className="font-medium">{p.name}</span> <span className="text-muted">· {p.access}</span>
              {p.optional && <span className="ml-1.5 text-xs text-faint">(optional)</span>}
            </div>
            <div className="text-xs text-muted">
              {p.why}
              {p.untested && <span className="text-faint"> · checked once you add a domain</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// The recovery key the deploy used to ask for: shown once, right after connecting the token
// generated it.
function RecoveryKey({ value }: { value: string }) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-warning/40 bg-warning-soft p-4">
      <div className="flex items-start gap-2 text-[13px]">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div>
          <div className="font-medium text-fg">Save your recovery key now</div>
          <div className="mt-0.5 text-muted">
            It is shown only this once. You paste it in the next step, and you need it to get back in if you lose your password. Keep it in a password manager.
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <code data-testid="recovery-key" className="min-w-0 flex-1 break-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-[13px] select-all">
          {value}
        </code>
        <div className="flex gap-1">
          <CopyButton text={value} />
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
            onClick={() =>
              downloadBlob(
                new Blob([`OpenInbox recovery key (ENCRYPTION_KEY) for ${location.host}\n\n${value}\n`], { type: 'text/plain' }),
                'openinbox-recovery-key.txt',
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Download
          </button>
        </div>
      </div>
    </div>
  );
}

function TokenForm({ onSaved, onCancel, newKey = false, createsKey = false }: { onSaved: (recoveryKey: string | null) => void; onCancel?: () => void; newKey?: boolean; createsKey?: boolean }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await post<{ recoveryKey: string | null }>('/setup/token', { token, newKey });
      onSaved(r.recoveryKey);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border border-border bg-surface-2 p-4">
      <p className="text-[13px] text-muted">
        {newKey
          ? 'Paste your Cloudflare API token again to prove this deployment is yours. A new recovery key replaces the old one.'
          : 'OpenInbox uses a Cloudflare API token to set up Email Routing and DNS for you. Create one with these permissions, then paste it here. It is stored encrypted.'}
        {createsKey && ' Connecting also creates your recovery key.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={tokenTemplateUrl()} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-fg hover:bg-primary-hover">
          <Cloud className="h-4 w-4" /> Create token <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
          Open API tokens page <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <ul className="grid gap-x-4 gap-y-0.5 text-xs text-muted sm:grid-cols-2">
        {TOKEN_PERMISSIONS.map((p) => (
          <li key={p.key}>
            {p.scope} · {p.name} · {p.access}
            {p.optional && ' (optional)'}
          </li>
        ))}
      </ul>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Input type="password" placeholder="Paste your API token" value={token} onChange={(e) => setToken(e.target.value)} required />
        <Button type="submit" variant="primary" loading={busy}>
          Connect
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function AdminStage({
  zones,
  keyState,
  onBack,
  onClaimed,
}: {
  zones: SetupStatus['zones'];
  keyState: KeyState;
  onBack: () => void;
  onClaimed: (c: { domainId: number; address: string; domain: string }) => void;
}) {
  const [zoneId, setZoneId] = useState(zones.find((z) => z.status === 'active')?.id ?? zones[0]?.id ?? '');
  const [localPart, setLocalPart] = useState('admin');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [replaceMx, setReplaceMx] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const zone = zones.find((z) => z.id === zoneId);
  const inspection = useQuery({ queryKey: ['zone', zoneId], queryFn: () => get<ZoneInspection>(`/setup/zones/${zoneId}`), enabled: !!zoneId, retry: false });
  const mx = inspection.data;
  const needsConfirm = mx?.mxState === 'other';

  useEffect(() => setReplaceMx(false), [zoneId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The passwords do not match.');
    if (needsConfirm && !replaceMx) return setError(`Confirm that OpenInbox should take over mail for ${zone?.name}.`);
    setBusy(true);
    setError('');
    try {
      const r = await post<{ domainId: number }>('/setup/claim', { zoneId, localPart, displayName: name, password, setupKey, replaceMx });
      onClaimed({ domainId: r.domainId, address: `${localPart.toLowerCase()}@${zone?.name}`, domain: zone?.name ?? '' });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Card className="p-6">
      <form onSubmit={submit} className="space-y-5">
        <div>
          <h2 className="text-base font-semibold">Create your admin email</h2>
          <p className="mt-1 text-[13px] text-muted">This address is your first inbox and your sign-in. You can add more domains, inboxes and people later.</p>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Domain" id="zone">
          <Select id="zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
                {z.status !== 'active' ? ` (${z.status})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        {inspection.isLoading && <div className="text-[13px] text-muted">Looking at {zone?.name}…</div>}
        {mx && mx.mxState === 'none' && <Alert tone="success">{mx.name} does not receive mail yet. OpenInbox will set it up.</Alert>}
        {mx && mx.mxState === 'cloudflare' && <Alert tone="success">{mx.name} already uses Cloudflare Email Routing. OpenInbox will route its mail.</Alert>}
        {mx && mx.mxState === 'other' && (
          <Alert tone="warning" title={`${mx.name} receives mail somewhere else`}>
            <div>Its MX records point to {mx.mx.map((m) => m.host).join(', ')}. Continuing replaces them, so all mail for {mx.name} goes to OpenInbox instead.</div>
            <div className="mt-2">
              <Checkbox checked={replaceMx} onChange={setReplaceMx} label={`Yes, move mail for ${mx.name} to OpenInbox`} />
            </div>
          </Alert>
        )}
        {mx && mx.conflicts.length > 0 && (
          <Alert tone="neutral" title="Existing routing rules">
            {mx.conflicts.map((c) => c.address).join(', ')} {mx.conflicts.length === 1 ? 'has its own rule' : 'have their own rules'} in Email Routing and will keep bypassing OpenInbox. You can disable them later from the domain page.
          </Alert>
        )}
        {inspection.error ? <Alert tone="danger">{errorText(inspection.error)}</Alert> : null}
        <Field label="Your email address" id="local">
          <div className="flex items-center overflow-hidden rounded-lg border border-border bg-surface focus-within:border-primary focus-within:ring-3 focus-within:ring-[var(--ring)]">
            <input id="local" className="h-9 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none" value={localPart} onChange={(e) => setLocalPart(e.target.value.trim())} required />
            <span className="border-l border-border bg-surface-2 px-3 py-2 text-sm text-muted">@{zone?.name}</span>
          </div>
        </Field>
        <Field label="Your name" id="name" hint="Shown as the sender name on mail you send.">
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Jane Doe" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password" id="password">
            <PasswordInput id="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          </Field>
          <Field label="Confirm password" id="confirm">
            <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
        </div>
        <PasswordStrength password={password} />
        <div className="rounded-lg border border-border bg-surface-2 p-4">
          <Field
            label={
              <span className="inline-flex items-center gap-1.5">
                <KeyRound className="h-4 w-4 text-primary" /> Recovery key
              </span>
            }
            id="key"
            hint={
              keyState === 'set'
                ? 'Paste the ENCRYPTION_KEY set for this Worker. It proves the deployment is yours.'
                : 'Paste the recovery key from the previous step to confirm you saved it. Lost it? Go back and create a new one.'
            }
          >
            <PasswordInput id="key" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} required placeholder={keyState === 'set' ? 'ENCRYPTION_KEY' : 'Recovery key'} />
          </Field>
        </div>
        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={onBack}>
            Back
          </Button>
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!zoneId}>
            Create and set up
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DomainStage({ claim, onDone }: { claim: { domainId: number; address: string; domain: string }; onDone: () => void }) {
  const [steps, setSteps] = useState<DomainSetupStep[]>([]);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  const run = useMemo(
    () => async () => {
      setRunning(true);
      setError('');
      try {
        for (let i = 0; i < 6; i++) {
          const r = await post<{ steps: DomainSetupStep[]; done: boolean }>(`/admin/domains/${claim.domainId}/setup`);
          setSteps(r.steps);
          if (r.done) {
            onDone();
            return;
          }
          const failed = r.steps.find((s) => s.status === 'error');
          if (failed) {
            setError(failed.message ?? 'A step failed.');
            return;
          }
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : errorText(err));
      } finally {
        setRunning(false);
      }
    },
    [claim.domainId, onDone],
  );

  // Start once (StrictMode runs effects twice in development).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
  }, [run]);

  const shown: DomainSetupStep[] = steps.length
    ? steps
    : [
        { id: 'routing', label: 'Turn on Email Routing', status: 'pending' },
        { id: 'catchall', label: 'Route all mail for the domain to OpenInbox', status: 'pending' },
        { id: 'dmarc', label: 'Add a DMARC record', status: 'pending' },
        { id: 'verify', label: 'Check that mail can arrive', status: 'pending' },
      ];
  const firstPending = shown.findIndex((s) => s.status !== 'done' && s.status !== 'skipped');

  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">Setting up {claim.domain}</h2>
      <p className="mt-1 text-[13px] text-muted">Your account {claim.address} is ready. Now connecting the domain through the Cloudflare API.</p>
      <div className="mt-5 space-y-3">
        {shown.map((s, i) => (
          <div key={s.id} className="flex gap-3">
            <div className="mt-0.5">
              {s.status === 'done' ? (
                <CircleCheck className="h-5 w-5 text-success" />
              ) : s.status === 'error' ? (
                <CircleX className="h-5 w-5 text-danger" />
              ) : i === firstPending && running ? (
                <LoaderCircle className="h-5 w-5 animate-spin text-primary" />
              ) : (
                <div className="h-5 w-5 rounded-full border-2 border-border-strong" />
              )}
            </div>
            <div>
              <div className="text-sm font-medium">{s.label}</div>
              {s.message && <div className={cn('text-[13px]', s.status === 'error' ? 'text-danger' : 'text-muted')}>{s.message}</div>}
            </div>
          </div>
        ))}
      </div>
      {error && (
        <div className="mt-5 space-y-3">
          <Alert tone="danger" title="Setup stopped">
            {error}
          </Alert>
          <div className="flex gap-2">
            <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} onClick={run} loading={running}>
              Retry
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Skip for now
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function DoneStage({ address }: { address: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Navigate first: once the session refreshes, the setup routes are replaced by the app.
  const go = () => {
    navigate('/admin?welcome=1', { replace: true });
    qc.invalidateQueries({ queryKey: ['session'] });
  };
  return (
    <Card className="p-8 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-soft">
        <Sparkles className="h-7 w-7 text-success" />
      </div>
      <h2 className="mt-4 text-lg font-semibold">You're all set</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
        Mail sent to <span className="font-medium text-fg">{address}</span> now arrives in OpenInbox. Next, connect a sending provider (Resend, Brevo, Mailjet or SMTP) so you can send and reply.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <Button variant="primary" size="lg" icon={<Mail className="h-4 w-4" />} onClick={go}>
          Open the dashboard
        </Button>
      </div>
    </Card>
  );
}
