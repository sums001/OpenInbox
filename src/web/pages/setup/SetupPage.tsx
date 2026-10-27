import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ArrowLeft, Check, ChevronDown, CircleCheck, CircleDashed, CircleX, Cloud, Download, ExternalLink, KeyRound, LoaderCircle, Mail, RefreshCw, ShieldCheck, Sparkles, TriangleAlert, X } from 'lucide-react';
import { ApiError, errorText, get, post } from '../../lib/api';
import { cn, downloadBlob } from '../../lib/utils';
import { ACCOUNT_TOKENS_URL, tokenTemplateUrl, TOKEN_PERMISSIONS } from '../../../shared/constants';
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
  // "Check again" also looks for the Worker again instead of using what setup remembered.
  const force = useRef(false);
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => {
      const refresh = force.current;
      force.current = false;
      return get<SetupStatus>(`/setup/status${refresh ? '?refresh=1' : ''}`);
    },
    retry: false,
    // A new key reaches the Worker within seconds; check until it has.
    refetchInterval: (q) => (q.state.data?.checks.encryptionKey.state === 'activating' ? 2000 : false),
  });
  // A check the owner asked for (not the background polling). It shows for at least a moment, so
  // a fast answer still reads as "checked" instead of nothing happening.
  const [rechecking, setRechecking] = useState(false);
  const recheck = async (refresh?: boolean) => {
    force.current = !!refresh;
    setRechecking(true);
    try {
      await Promise.all([status.refetch(), new Promise((r) => setTimeout(r, 700))]);
    } finally {
      setRechecking(false);
    }
  };

  const steps: { id: Stage; label: string }[] = [
    { id: 'checks', label: 'Connect Cloudflare' },
    { id: 'admin', label: 'Create your account' },
    { id: 'domain', label: 'Set up mail' },
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
            checking={rechecking || status.isLoading}
            checkedAt={status.dataUpdatedAt}
            error={status.error}
            refetch={recheck}
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

type StepState = 'locked' | 'active' | 'working' | 'done' | 'warning' | 'error';

// One step of the first screen. Steps unlock in order; each shows a spinner while the server works
// on it.
function SetupStep({ n, title, state, summary, last, children }: { n: number; title: string; state: StepState; summary: ReactNode; last?: boolean; children?: ReactNode }) {
  const done = state === 'done' || state === 'warning';
  return (
    <li className="relative flex gap-4 px-5 py-4 sm:px-6" aria-current={state === 'active' || state === 'working' ? 'step' : undefined}>
      {!last && <span className={cn('absolute top-[46px] -bottom-3 left-[32px] w-0.5 rounded-full sm:left-[36px]', done ? 'bg-success/40' : 'bg-border')} />}
      <span
        className={cn(
          'relative flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
          state === 'locked' && 'bg-surface-3 text-faint',
          state === 'active' && 'bg-primary text-primary-fg',
          state === 'working' && 'bg-primary-soft text-primary-text',
          state === 'done' && 'bg-success text-white',
          state === 'warning' && 'bg-warning-soft text-warning',
          state === 'error' && 'bg-danger-soft text-danger',
        )}
      >
        {state === 'working' ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : state === 'done' ? (
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        ) : state === 'warning' ? (
          <TriangleAlert className="h-3.5 w-3.5" />
        ) : state === 'error' ? (
          <X className="h-3.5 w-3.5" strokeWidth={3} />
        ) : (
          n
        )}
      </span>
      <div className="min-w-0 flex-1 pt-[3px]">
        <div className={cn('text-sm font-semibold', state === 'locked' && 'text-faint')}>{title}</div>
        <div className={cn('mt-0.5 text-[13px]', state === 'locked' ? 'text-faint' : state === 'error' ? 'text-danger' : 'text-muted')} aria-live="polite">
          {summary}
        </div>
        {children}
      </div>
    </li>
  );
}

// Appears once something has been running for a while, so a slow Cloudflare call doesn't look stuck.
function SlowNote({ after, children }: { after: number; children: ReactNode }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), after * 1000);
    return () => clearTimeout(t);
  }, [after]);
  return show ? <div className="mt-1.5 text-xs text-faint animate-fade-in">{children}</div> : null;
}

function ResultLine({ check, children }: { check: Check; children?: ReactNode }) {
  return (
    <div className="flex gap-2.5 py-1.5">
      {check.ok && !check.warning ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : check.ok ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> : <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
      <div className="min-w-0 flex-1 text-[13px]">
        <div className={check.ok ? 'text-fg' : 'text-danger'}>{check.message}</div>
        {children}
      </div>
    </div>
  );
}

// While a check runs, step 4 lists what it is looking up.
function PendingLines({ items }: { items: string[] }) {
  return (
    <div className="mt-2 rounded-lg border border-border px-3 py-1">
      {items.map((label) => (
        <div key={label} className="flex items-center gap-2.5 py-1.5 text-[13px] text-muted">
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-primary" />
          {label}
        </div>
      ))}
    </div>
  );
}

function ChecksStage({
  status,
  checking,
  checkedAt,
  error,
  refetch,
  recoveryKey,
  onRecoveryKey,
  onContinue,
}: {
  status?: SetupStatus;
  checking: boolean;
  checkedAt: number;
  error: unknown;
  refetch: (force?: boolean) => Promise<unknown>;
  recoveryKey: string | null;
  onRecoveryKey: (key: string) => void;
  onContinue: () => void;
}) {
  const qc = useQueryClient();
  const [showPerms, setShowPerms] = useState(false);
  const [changingToken, setChangingToken] = useState(false);
  const [replacingKey, setReplacingKey] = useState(false);
  // Which token form is waiting on the server.
  const [connecting, setConnecting] = useState<'token' | 'change' | 'newKey' | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const c = status?.checks;
  const missing = status?.permissions.filter((p) => !p.ok && !p.untested) ?? [];
  const missingRequired = missing.filter((p) => !p.optional);
  const missingOptional = missing.filter((p) => p.optional);
  const untested = status?.permissions.filter((p) => p.untested) ?? [];
  const keyState = c?.encryptionKey.state;
  const activating = keyState === 'activating';
  // A key generated on this page that the owner hasn't confirmed saving yet.
  const freshKey = !!recoveryKey && !keySaved;

  const dbState: StepState = !c || checking ? 'working' : c.database.ok ? 'done' : 'error';
  const cfState: StepState = !c
    ? 'locked'
    : connecting === 'token' || connecting === 'change' || (checking && c.cloudflare.ok)
      ? 'working'
      : !c.database.ok
        ? 'locked'
        : c.cloudflare.ok || activating
          ? 'done'
          : c.cloudflare.source
            ? 'error'
            : 'active';
  const keyStepState: StepState = !c
    ? 'locked'
    : keyState === 'set'
      ? c.encryptionKey.warning
        ? 'warning'
        : 'done'
      : activating || connecting === 'newKey'
        ? 'working'
        : keyState === 'generated'
          ? freshKey
            ? 'active'
            : 'done'
          : 'locked';
  const keyDone = keyStepState === 'done' || keyStepState === 'warning';
  // The recovery key only exists once a token is connected, so its step appears then.
  const showKeyStep = !!c && (c.cloudflare.ok || activating || keyState === 'generated' || connecting === 'newKey');
  const cfDone = cfState === 'done' || (checking && !!c?.cloudflare.ok);
  const findState: StepState =
    !cfDone || !keyDone
      ? 'locked'
      : checking
        ? 'working'
        : !c!.worker.ok || !c!.zones.ok || missingRequired.length
          ? 'error'
          : missingOptional.length
            ? 'warning'
            : 'done';
  const ready = findState === 'done' || findState === 'warning';
  const canChangeToken = !!c && c.cloudflare.ok && c.cloudflare.source === 'stored' && !checking;
  const problems = !c
    ? 0
    : [!c.database.ok, !!c.cloudflare.source && !c.cloudflare.ok, cfDone && keyDone && !c.worker.ok, cfDone && keyDone && !c.zones.ok].filter(Boolean).length +
      (cfDone && keyDone ? missingRequired.length : 0);

  const busy = (form: 'token' | 'change' | 'newKey') => (on: boolean) => setConnecting(on ? form : null);
  const saved = (key: string | null) => {
    if (key) {
      onRecoveryKey(key);
      setKeySaved(false);
    }
    return refetch();
  };

  useEffect(() => {
    if (status?.setupComplete) qc.invalidateQueries({ queryKey: ['session'] });
  }, [status?.setupComplete, qc]);

  if (error && !status) {
    return <Alert tone="danger" title="Setup is unavailable" action={<Button size="sm" onClick={() => refetch()}>Retry</Button>}>{errorText(error)}</Alert>;
  }

  const permSummary = missingRequired.length
    ? `${missingRequired.length} required permission${missingRequired.length === 1 ? '' : 's'} missing. Edit the token in Cloudflare, then check again.`
    : untested.length
      ? 'No problems so far. Domain permissions are checked once a domain is in the account.'
      : missingOptional.length
        ? `${missingOptional.length} optional permission${missingOptional.length === 1 ? '' : 's'} missing; some extras will be unavailable.`
        : 'The token has every permission OpenInbox uses.';

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <ol className="py-1">
          <SetupStep n={1} title="Check this deployment" state={dbState} summary={c && !checking ? c.database.message : 'Checking the database…'} />

          <SetupStep
            n={2}
            title="Connect Cloudflare"
            state={cfState}
            summary={
              connecting === 'token' || connecting === 'change'
                ? 'Checking the token with Cloudflare and looking for this Worker…'
                : !c
                  ? 'Waiting for the deployment check…'
                  : cfState === 'working'
                    ? 'Verifying the token with Cloudflare…'
                    : activating
                      ? 'Token connected.'
                      : cfState === 'locked'
                        ? 'An API token lets OpenInbox set up Email Routing and DNS for your domains.'
                        : c.cloudflare.ok || c.cloudflare.source
                          ? c.cloudflare.message
                          : 'Create an API token in Cloudflare and paste it here. OpenInbox uses it to set up Email Routing and DNS for you, and it proves this deployment is yours.'
            }
          >
            {(cfState === 'active' || cfState === 'error' || connecting === 'token') && (
              <TokenForm createsKey={keyState === 'missing'} onBusy={busy('token')} onSaved={saved} />
            )}
            {(connecting === 'token' || connecting === 'change') && <SlowNote after={8}>Still waiting for Cloudflare. This can take a few more seconds.</SlowNote>}
            {canChangeToken && !changingToken && !connecting && (
              <button type="button" className="mt-1 text-[13px] text-primary-text hover:underline" onClick={() => setChangingToken(true)}>
                Use a different token
              </button>
            )}
            {canChangeToken && changingToken && (
              <TokenForm
                onBusy={busy('change')}
                onSaved={async (key) => {
                  await saved(key);
                  setChangingToken(false);
                }}
                onCancel={() => setChangingToken(false)}
              />
            )}
            {c?.cloudflare.ok && c.cloudflare.source === 'secret' && (
              <div className="mt-1 text-xs text-faint">From the CF_API_TOKEN secret. Change it in the Worker's Settings → Variables and Secrets.</div>
            )}
          </SetupStep>

          {showKeyStep && (
            <SetupStep
              n={3}
              title="Save your recovery key"
              state={keyStepState}
              summary={
                keyState === 'missing' || !c
                  ? 'Created for you once Cloudflare is connected. You need it to get back in if you lose your password.'
                  : activating
                    ? 'Saving the key to this Worker as ENCRYPTION_KEY. Cloudflare usually takes a few seconds.'
                    : freshKey
                      ? 'Shown only this once. Keep it in a password manager; you paste it in the next step.'
                      : c.encryptionKey.message
              }
            >
              {activating && <SlowNote after={20}>Taking longer than usual. Keep this page open; it carries on by itself.</SlowNote>}
              {recoveryKey && (freshKey || showKey) && <RecoveryKey value={recoveryKey} />}
              {freshKey && (
                <Button variant="primary" size="sm" className="mt-3" icon={<Check className="h-4 w-4" />} onClick={() => setKeySaved(true)}>
                  I've saved it
                </Button>
              )}
              {recoveryKey && !freshKey && (
                <button type="button" className="mt-1 text-[13px] text-primary-text hover:underline" onClick={() => setShowKey((s) => !s)}>
                  {showKey ? 'Hide the key' : 'Show the key again'}
                </button>
              )}
              {!recoveryKey && keyState === 'generated' && !replacingKey && (
                <button type="button" className="mt-1 text-[13px] text-primary-text hover:underline" onClick={() => setReplacingKey(true)}>
                  Didn't save the key? Create a new one
                </button>
              )}
              {!recoveryKey && keyState === 'generated' && replacingKey && (
                <TokenForm
                  newKey
                  onBusy={busy('newKey')}
                  onSaved={async (key) => {
                    await saved(key);
                    setReplacingKey(false);
                  }}
                  onCancel={() => setReplacingKey(false)}
                />
              )}
            </SetupStep>
          )}

          <SetupStep
            n={showKeyStep ? 4 : 3}
            title="Find your domains"
            state={findState}
            last
            summary={
              findState === 'locked'
                ? 'Finds this Worker, the domains in your account and what the token is allowed to do.'
                : findState === 'working'
                  ? 'Looking things up in your Cloudflare account…'
                  : findState === 'error'
                    ? 'Fix the problem below, then check again.'
                    : 'Everything OpenInbox needs is in place.'
            }
          >
            {findState === 'working' && <PendingLines items={['Finding this Worker', 'Listing the domains in your account', 'Checking what the token is allowed to do']} />}
            {findState === 'working' && <SlowNote after={6}>Cloudflare is taking a moment to answer.</SlowNote>}
            {findState !== 'working' && findState !== 'locked' && (
              <div className="mt-2 rounded-lg border border-border px-3 py-1">
                <ResultLine check={c!.worker} />
                <ResultLine check={c!.zones}>
                  {c!.zones.ok && <div className="mt-1.5 flex flex-wrap gap-1.5">{status!.zones.map((z) => <Badge key={z.id}>{z.name}</Badge>)}</div>}
                  {!c!.zones.ok && c!.zones.count === 0 && (
                    <a href="https://dash.cloudflare.com/?to=/:account/add-site" target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary-text hover:underline">
                      Add a domain to Cloudflare <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </ResultLine>
                {!!status?.permissions.length && (
                  <div className="py-1.5">
                    <button type="button" className="flex w-full items-start gap-2.5 text-left text-[13px]" onClick={() => setShowPerms((s) => !s)} aria-expanded={showPerms || missingRequired.length > 0}>
                      {missingRequired.length ? (
                        <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                      ) : missingOptional.length ? (
                        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                      ) : (
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                      )}
                      <span className={cn('flex-1', missingRequired.length ? 'text-danger' : 'text-fg')}>{permSummary}</span>
                      <ChevronDown className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform', (showPerms || missingRequired.length > 0) && 'rotate-180')} />
                    </button>
                    {(showPerms || missingRequired.length > 0) && <PermissionList permissions={status.permissions} />}
                  </div>
                )}
              </div>
            )}
          </SetupStep>
        </ol>
      </Card>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1">
          <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={() => refetch(true)} loading={checking} disabled={!!connecting || checking}>
            {checking ? 'Checking…' : 'Check again'}
          </Button>
          {!checking && c && (
            <span key={checkedAt} className="flex min-w-0 animate-fade-in items-center gap-1.5 truncate text-xs text-faint" role="status">
              {problems ? <CircleX className="h-3.5 w-3.5 shrink-0 text-danger" /> : <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />}
              <span className="truncate">
                {problems ? `${problems} ${problems === 1 ? 'problem' : 'problems'} found` : ready ? 'All checks passed' : 'No problems found'} · {new Date(checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </span>
          )}
        </div>
        <Button variant="primary" size="lg" disabled={!ready || checking} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}

export function PermissionList({ permissions, compact }: { permissions: PermissionCheck[]; compact?: boolean }) {
  // Two columns of one-line rows; the reason each is needed shows on hover.
  if (compact)
    return (
      <div className="grid gap-x-5 sm:grid-cols-2">
        {permissions.map((p) => (
          <div key={p.key} className="flex h-[30px] items-center gap-2 text-[12.5px]" title={p.why}>
            {p.ok ? <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" /> : p.untested ? <CircleDashed className="h-3.5 w-3.5 shrink-0 text-faint" /> : p.optional ? <CircleX className="h-3.5 w-3.5 shrink-0 text-faint" /> : <CircleX className="h-3.5 w-3.5 shrink-0 text-danger" />}
            <span className={cn('min-w-0 flex-1 truncate', p.ok ? 'text-fg' : 'text-muted')}>
              {p.name}
              {p.optional && ' (optional)'}
            </span>
            <span className="shrink-0 text-[11.5px] text-faint">{p.access}</span>
          </div>
        ))}
      </div>
    );
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

function TokenForm({
  onSaved,
  onBusy,
  onCancel,
  newKey = false,
  createsKey = false,
}: {
  onSaved: (recoveryKey: string | null) => Promise<unknown>;
  onBusy?: (busy: boolean) => void;
  onCancel?: () => void;
  newKey?: boolean;
  createsKey?: boolean;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPerms, setShowPerms] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onBusy?.(true);
    setError('');
    try {
      const r = await post<{ recoveryKey: string | null }>('/setup/token', { token, newKey });
      // Stay busy until the page has the new status, so the step doesn't flash back to the form.
      await onSaved(r.recoveryKey);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };
  const paste = (
    <div className="flex flex-wrap gap-2">
      <Input
        type="password"
        aria-label="Cloudflare API token"
        placeholder="Paste your API token"
        className="min-w-0 flex-1 basis-56"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        disabled={busy}
        required
      />
      <Button type="submit" variant="primary" loading={busy}>
        {busy ? 'Checking…' : 'Connect'}
      </Button>
      {onCancel && (
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      )}
    </div>
  );
  return (
    <form onSubmit={submit} className="mt-3 rounded-lg border border-border bg-surface-2 p-3.5 sm:p-4">
      {newKey ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">Paste your Cloudflare API token again to prove this deployment is yours. A new recovery key replaces the old one.</p>
          {paste}
        </div>
      ) : (
        <ol className="space-y-4">
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-muted ring-1 ring-border">1</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Create a token</div>
              <div className="mt-0.5 text-[12.5px] text-muted">The link opens Cloudflare with the permissions filled in. Choose your account and domains, then create the token and copy it.</div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <a href={tokenTemplateUrl()} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-fg hover:bg-primary-hover">
                  <Cloud className="h-4 w-4" /> Create token <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <button type="button" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg" onClick={() => setShowPerms((s) => !s)} aria-expanded={showPerms}>
                  What it can do <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showPerms && 'rotate-180')} />
                </button>
                <a href={ACCOUNT_TOKENS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
                  API tokens page <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              {showPerms && (
                <ul className="mt-2.5 grid gap-x-4 gap-y-0.5 text-xs text-muted sm:grid-cols-2">
                  {TOKEN_PERMISSIONS.map((p) => (
                    <li key={p.key}>
                      {p.scope} · {p.name} · {p.access}
                      {p.optional && ' (optional)'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-muted ring-1 ring-border">2</span>
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <div className="text-[13px] font-medium">Paste it here</div>
                <div className="mt-0.5 text-[12.5px] text-muted">
                  It is stored encrypted and never shown again.{createsKey && ' Connecting also creates your recovery key.'}
                </div>
              </div>
              {paste}
            </div>
          </li>
        </ol>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
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
        {inspection.isLoading && (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Checking where mail for {zone?.name} goes now…
          </div>
        )}
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
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!zoneId || inspection.isLoading}>
            {busy ? 'Creating your account…' : 'Create and set up'}
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
