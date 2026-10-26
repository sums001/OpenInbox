import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, CircleCheck, CircleDashed, CircleX, Ellipsis, ExternalLink, Globe, ListChecks, LoaderCircle, Lock, Plus, RefreshCw, RotateCw, Trash2, TriangleAlert, Wrench, X } from 'lucide-react';
import { del, get, patch, post, errorText } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import type { DomainInfo, DomainSetupStep, MailboxAdmin, ProviderInfo, ZoneInspection } from '../../lib/types';
import { Button, IconButton } from '../../components/ui/button';
import { Checkbox, Field, Select } from '../../components/ui/form';
import { Alert, Card, EmptyState, IconTile, PageHeader, PageSpinner } from '../../components/ui/misc';
import { ConfirmDialog, Dialog, Menu, MenuItem } from '../../components/ui/overlay';

export function DomainsPage() {
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => get<DomainInfo[]>('/admin/domains') });
  const mailboxes = useQuery({ queryKey: ['admin', 'mailboxes'], queryFn: () => get<MailboxAdmin[]>('/admin/mailboxes') });
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: () => get<ProviderInfo[]>('/admin/providers') });
  const [adding, setAdding] = useState(false);
  const invalidate = useInvalidate();
  const refresh = () => invalidate(['admin', 'domains'], ['admin', 'overview'], ['admin', 'providers']);
  if (domains.isLoading) return <PageSpinner />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Domains"
        description="Domains in your Cloudflare account that receive mail here. Everything is set up through the Cloudflare API, and you can re-run or repair setup from this page at any time."
        actions={
          <Button variant="primary" icon={<Plus className="h-[15px] w-[15px]" />} onClick={() => setAdding(true)}>
            Add a domain
          </Button>
        }
      />
      {domains.data?.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Globe />}
            title="No domains yet"
            action={
              <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
                Add a domain
              </Button>
            }
          >
            Add a domain from your Cloudflare account to start receiving mail.
          </EmptyState>
        </Card>
      ) : (
        domains.data?.map((d) => <DomainCard key={d.id} domain={d} mailboxes={mailboxes.data ?? []} providers={providers.data ?? []} onChanged={refresh} />)
      )}
      {adding && (
        <AddDomainDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function StepList({ steps, running }: { steps: DomainSetupStep[]; running?: boolean }) {
  const active = steps.findIndex((s) => s.status !== 'done' && s.status !== 'skipped');
  return (
    <div className="flex flex-col">
      {steps.map((s, i) => {
        const state = s.status === 'done' || s.status === 'skipped' ? 'done' : s.status === 'error' ? 'err' : running && i === active ? 'run' : 'wait';
        const tile = { done: 'bg-success-soft text-success', err: 'bg-danger-soft text-danger', run: 'bg-primary-soft text-primary-text', wait: 'bg-surface-2 text-faint' }[state];
        return (
          <div key={s.id} className="relative flex gap-3 pb-3.5 last:pb-0">
            {i < steps.length - 1 && <span className="absolute top-[24px] bottom-0.5 left-[10.5px] w-px bg-border" />}
            <span className={cn('relative grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full [&>svg]:h-[13px] [&>svg]:w-[13px]', tile)}>
              {state === 'done' ? <Check /> : state === 'err' ? <X /> : state === 'run' ? <LoaderCircle className="animate-spin" /> : <CircleDashed />}
            </span>
            <div className="min-w-0 flex-1 pt-px leading-snug">
              <div className={cn('text-[13px]', state === 'run' || state === 'err' ? 'font-semibold' : 'font-[450]', state === 'wait' && 'text-faint')}>{s.label}</div>
              {s.message && <div className={cn('mt-0.5 text-xs break-words', state === 'err' ? 'text-danger' : 'text-muted')}>{s.message}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

async function runSteps(domainId: number, onSteps: (s: DomainSetupStep[]) => void, reset = false): Promise<{ done: boolean; error?: string; step?: string }> {
  for (let i = 0; i < 6; i++) {
    const r = await post<{ steps: DomainSetupStep[]; done: boolean }>(`/admin/domains/${domainId}/setup${i === 0 && reset ? '?reset=1' : ''}`);
    onSteps(r.steps);
    if (r.done) return { done: true };
    const failed = r.steps.find((s) => s.status === 'error');
    if (failed) return { done: false, error: failed.message, step: failed.label };
  }
  return { done: false };
}

function Status({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-[5px] whitespace-nowrap [&>svg]:h-[13px] [&>svg]:w-[13px]">
      {icon}
      {children}
    </span>
  );
}

function DomainCard({ domain: d, mailboxes, providers, onChanged }: { domain: DomainInfo; mailboxes: MailboxAdmin[]; providers: ProviderInfo[]; onChanged: () => void }) {
  const { run, busy } = useAction();
  const [steps, setSteps] = useState<DomainSetupStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const [appDomain, setAppDomain] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const health = d.health;
  const shownSteps = steps ?? d.setup.steps;

  const finish = async () => {
    setRunning(true);
    try {
      await runSteps(d.id, setSteps);
    } finally {
      setRunning(false);
      onChanged();
    }
  };

  // Sending is verified per provider; the domain sends once any provider has verified it.
  const sending = providers.flatMap((p) => p.domains.filter((x) => x.domainId === d.id));
  const sendState = sending.some((x) => x.status === 'verified') ? 'ok' : sending.some((x) => x.status === 'pending') ? 'pending' : 'off';
  const issues = health?.items.filter((h) => h.status !== 'ok') ?? [];
  const errors = issues.filter((h) => h.status === 'error');
  const tone = d.status === 'error' || errors.length ? 'danger' : !d.setup.done || d.status === 'pending' || issues.length ? 'warning' : d.status === 'active' ? 'success' : 'neutral';

  return (
    <Card className={cn(tone === 'warning' && 'border-[color-mix(in_oklch,var(--warning)_35%,var(--border))]', tone === 'danger' && 'border-[color-mix(in_oklch,var(--danger)_35%,var(--border))]')}>
      <div className="flex flex-wrap items-center gap-3.5 px-5 py-[18px]">
        <IconTile tone={tone} size={36}>
          <Globe />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{d.name}</div>
          <div className="mt-[3px] flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-muted">
            <Status icon={d.status === 'active' ? <CircleCheck className="text-success" /> : d.status === 'error' ? <CircleX className="text-danger" /> : <CircleDashed className="text-warning" />}>
              {d.status === 'active' ? 'Receiving mail' : d.status === 'error' ? 'Not receiving' : d.status === 'disabled' ? 'Disabled' : 'Receiving pending'}
            </Status>
            <Status icon={sendState === 'ok' ? <CircleCheck className="text-success" /> : sendState === 'pending' ? <CircleDashed className="text-warning" /> : <CircleX className="text-faint" />}>
              {sendState === 'ok' ? 'Sending' : sendState === 'pending' ? 'Sending pending' : 'Not sending'}
            </Status>
            {health && (
              <Status icon={!issues.length ? <CircleCheck className="text-success" /> : errors.length ? <CircleX className="text-danger" /> : <TriangleAlert className="text-warning" />}>
                {!issues.length ? 'DNS records' : `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`}
              </Status>
            )}
            <span>
              {d.addresses} address{d.addresses === 1 ? '' : 'es'}
              {d.healthCheckedAt ? ` · checked ${timeAgo(d.healthCheckedAt)}` : ''}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="xs" icon={<ListChecks />} onClick={() => setShowHealth((s) => !s)} className={cn(showHealth && 'bg-surface-2')}>
            DNS records
          </Button>
          <Button size="xs" icon={<Wrench />} loading={busy === 'repair'} onClick={() => run('repair', () => post(`/admin/domains/${d.id}/repair`).then(onChanged), 'Repair finished')}>
            Repair
          </Button>
          <Menu trigger={({ onClick }) => <IconButton label="More" onClick={onClick} icon={<Ellipsis />} />}>
            <MenuItem icon={<RefreshCw />} onClick={() => run('check', () => post(`/admin/domains/${d.id}/check`).then(onChanged), 'Checked')}>
              Check health now
            </MenuItem>
            <MenuItem icon={<Trash2 />} danger disabled={d.addresses > 0} onClick={() => setRemoving(true)}>
              {d.addresses > 0 ? 'Remove (delete its inboxes first)' : 'Remove domain'}
            </MenuItem>
          </Menu>
        </div>
      </div>

      {!d.setup.done && (
        <div className="mx-5 mb-[18px] flex flex-col gap-3 rounded-lg bg-warning-soft px-3.5 py-3">
          <div className="flex items-start gap-2.5 text-[12.5px]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span className="flex-1">
              <b className="font-semibold">Setup isn't finished.</b> You can re-run or repair setup from this page at any time.
            </span>
            <Button size="xs" variant="primary" icon={<RotateCw />} loading={running} onClick={finish}>
              Re-run setup
            </Button>
          </div>
          <div className="rounded-lg bg-surface px-3.5 py-3">
            <StepList steps={shownSteps} running={running} />
          </div>
        </div>
      )}

      {showHealth && (
        <div className="mx-5 mb-[18px] overflow-hidden rounded-lg border border-border">
          {health?.items?.length ? (
            health.items.map((h) => (
              <div key={h.key} className="flex gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0">
                {h.status === 'ok' ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : h.status === 'warn' ? <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> : <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />}
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{h.label}</div>
                  <div className="text-xs break-words text-muted">{h.detail}</div>
                </div>
              </div>
            ))
          ) : (
            <div className="flex items-center justify-between gap-3 px-3.5 py-3 text-[13px] text-muted">
              Not checked yet.
              <Button size="xs" loading={busy === 'check'} onClick={() => run('check', () => post(`/admin/domains/${d.id}/check`).then(onChanged))}>
                Check now
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-x-6 gap-y-[18px] border-t border-border px-5 pt-[18px] pb-5 md:grid-cols-2">
        <Field label="Send through" hint="Others are used as fallbacks when it reaches its limit.">
          <Select value={d.providerId ?? ''} onChange={(e) => run('provider', () => patch(`/admin/domains/${d.id}`, { providerId: e.target.value ? Number(e.target.value) : null }).then(onChanged), 'Saved')}>
            <option value="">The default provider</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Catch-all" hint="Mail to addresses that don't exist goes here instead of being rejected. Catch-alls attract spam.">
          <Select
            value={d.catchAllMailboxId ?? ''}
            onChange={(e) => run('catchall', () => patch(`/admin/domains/${d.id}`, { catchAllMailboxId: e.target.value ? Number(e.target.value) : null }).then(onChanged), 'Catch-all updated')}
          >
            <option value="">Off: reject unknown addresses</option>
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                Deliver to {m.address}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Use your own address for the web app" hint="Cloudflare creates the DNS record and certificate. The workers.dev address keeps working.">
          {d.appHostname ? (
            <div className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-[13px]">
              <a href={`https://${d.appHostname}`} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-1.5 truncate hover:underline">
                {d.appHostname}
                <ExternalLink className="h-3 w-3 shrink-0 text-faint" />
              </a>
              <span className="flex items-center gap-[5px] text-xs font-medium text-success">
                <Lock className="h-3 w-3" />
                Active
              </span>
            </div>
          ) : (
            <div>
              <Button size="sm" onClick={() => setAppDomain(true)}>
                Use mail.{d.name}
              </Button>
            </div>
          )}
        </Field>
        <Field label="Addresses that bypass OpenInbox" hint="Mail to these keeps going to its existing Email Routing rule.">
          {health?.conflicts?.length ? (
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-border px-2 py-[5px]">
              {health.conflicts.map((c) => (
                <span key={c.address} title={`${c.address} → ${c.action}`} className="inline-flex h-6 items-center gap-[5px] rounded-md bg-surface-2 pr-1 pl-2 text-[12.5px]">
                  {c.address}
                  <button
                    type="button"
                    aria-label={`Send ${c.address} to OpenInbox`}
                    title="Disable this rule so mail comes to OpenInbox"
                    className="grid h-4 w-4 place-items-center rounded text-faint hover:text-fg"
                    onClick={() => run('rule', () => post(`/admin/domains/${d.id}/disable-rule`, { address: c.address }).then(() => post(`/admin/domains/${d.id}/check`)).then(onChanged), 'Rule disabled')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="flex h-9 items-center rounded-lg border border-dashed border-border px-3 text-[13px] text-faint">None</div>
          )}
        </Field>
      </div>
      {appDomain && (
        <AppDomainDialog
          domain={d}
          onClose={() => setAppDomain(false)}
          onDone={() => {
            setAppDomain(false);
            onChanged();
          }}
        />
      )}
      <ConfirmDialog
        open={removing}
        danger
        icon={<Trash2 />}
        onClose={() => setRemoving(false)}
        title={`Remove ${d.name}?`}
        confirmLabel="Remove domain"
        loading={busy === 'remove'}
        onConfirm={() =>
          run(
            'remove',
            () =>
              del(`/admin/domains/${d.id}`).then(() => {
                setRemoving(false);
                onChanged();
              }),
            'Domain removed',
          )
        }
      >
        OpenInbox turns off its catch-all rule for this domain. Email Routing and DNS records stay as they are.
      </ConfirmDialog>
    </Card>
  );
}

function AppDomainDialog({ domain, onClose, onDone }: { domain: DomainInfo; onClose: () => void; onDone: () => void }) {
  const [sub, setSub] = useState('mail');
  const [result, setResult] = useState<string | null>(null);
  const { run, busy } = useAction();
  return (
    <Dialog
      open
      onClose={result ? onDone : onClose}
      title="Use your own address for the web app"
      description="Cloudflare creates the DNS record and certificate. The workers.dev address keeps working."
      footer={
        result ? (
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={!!busy} onClick={() => run('attach', async () => setResult((await post<{ url: string }>(`/admin/domains/${domain.id}/app-domain`, { subdomain: sub })).url))}>
              Attach
            </Button>
          </>
        )
      }
    >
      {result ? (
        <Alert tone="success" title="Attached">
          OpenInbox will answer at{' '}
          <a href={result} className="font-medium underline" target="_blank" rel="noreferrer">
            {result}
          </a>{' '}
          within a minute or two, once Cloudflare issues the certificate. Sign in again there (sessions are per address).
        </Alert>
      ) : (
        <Field label="Address">
          <div className="flex h-9 overflow-hidden rounded-lg border border-border text-[13px] focus-within:border-primary focus-within:ring-3 focus-within:ring-[var(--ring)]">
            <input className="min-w-0 flex-1 bg-surface px-3 outline-none" value={sub} onChange={(e) => setSub(e.target.value.trim())} aria-label="Subdomain" />
            <span className="flex items-center border-l border-border bg-surface-2 px-3 text-muted">.{domain.name}</span>
          </div>
        </Field>
      )}
    </Dialog>
  );
}

function AddDomainDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const zones = useQuery({ queryKey: ['admin', 'zones'], queryFn: () => get<{ id: string; name: string; status: string; connected: boolean }[]>('/admin/zones') });
  const all = zones.data ?? [];
  const available = all.filter((z) => !z.connected);
  const [zoneId, setZoneId] = useState('');
  const [replaceMx, setReplaceMx] = useState(false);
  const [domainId, setDomainId] = useState<number | null>(null);
  const [steps, setSteps] = useState<DomainSetupStep[] | null>(null);
  const [error, setError] = useState<{ message: string; step?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!zoneId && available[0]) setZoneId(available[0].id);
  }, [available, zoneId]);
  const inspection = useQuery({ queryKey: ['admin', 'zone', zoneId], queryFn: () => get<ZoneInspection>(`/admin/zones/${zoneId}`), enabled: !!zoneId && !steps });
  const mx = inspection.data;
  const zone = all.find((z) => z.id === zoneId);

  const setup = async (id: number) => {
    setBusy(true);
    setError(null);
    try {
      const r = await runSteps(id, setSteps);
      if (r.done) setDone(true);
      else if (r.error) setError({ message: r.error, step: r.step });
    } catch (e) {
      setError({ message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await post<{ id: number }>('/admin/domains', { zoneId, replaceMx });
      setDomainId(id);
      await setup(id);
    } catch (e) {
      setError({ message: errorText(e) });
      setBusy(false);
    }
  };

  if (steps)
    return (
      <Dialog
        open
        onClose={onAdded}
        title={done ? `${zone?.name ?? 'The domain'} is ready` : `Setting up ${zone?.name ?? 'the domain'}`}
        description={done ? 'Mail for this domain now arrives in OpenInbox. Create inboxes for it on the Inboxes page.' : 'Keep this open. It takes about 30 seconds.'}
        footer={
          <Button variant="primary" onClick={onAdded} disabled={busy}>
            {done ? 'Done' : 'Close'}
          </Button>
        }
      >
        <StepList steps={steps} running={busy} />
        {error && (
          <div className="mt-4 flex items-center gap-2.5 rounded-lg bg-danger-soft px-3 py-2.5 text-[12.5px]">
            <CircleX className="h-[15px] w-[15px] shrink-0 text-danger" />
            <span className="min-w-0 flex-1">
              <b className="font-semibold">Setup stopped</b>
              {error.step ? ` at “${error.step}”` : ''}. {error.message}
            </span>
            {domainId && (
              <Button size="xs" icon={<RotateCw />} onClick={() => setup(domainId)}>
                Retry
              </Button>
            )}
          </div>
        )}
      </Dialog>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a domain"
      description="Pick one of the zones on your Cloudflare account. OpenInbox turns on Email Routing, routes its mail here and adds DMARC if it's missing."
      footer={
        available.length ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!zoneId || (mx?.mxState === 'other' && !replaceMx)} onClick={add}>
              Set up {zone?.name ?? 'domain'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      {zones.isLoading ? (
        <PageSpinner />
      ) : available.length === 0 ? (
        <EmptyState icon={<Globe />} tone="warning" title="No more domains">
          Every zone on this Cloudflare account is already connected. Add a new domain to Cloudflare first, then come back.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {error && <Alert tone="danger">{error.message}</Alert>}
          {all.map((z) => {
            const on = z.id === zoneId;
            const desc = z.connected ? 'Already set up' : on ? (inspection.isLoading ? 'Checking mail records…' : mx?.mxState === 'none' ? 'This domain does not receive mail yet.' : mx?.mxState === 'cloudflare' ? 'Email Routing is already on for this domain.' : mx?.mxState === 'other' ? `MX points to ${mx.mx[0]?.host}` : '') : '';
            return (
              <button
                key={z.id}
                type="button"
                disabled={z.connected}
                onClick={() => {
                  setZoneId(z.id);
                  setReplaceMx(false);
                }}
                className={cn('flex items-center gap-3 rounded-[10px] border px-3.5 py-3 text-left transition-colors disabled:opacity-50', on ? 'border-primary bg-primary-soft' : 'border-border enabled:hover:bg-surface-2')}
              >
                <span className={cn('h-4 w-4 shrink-0 rounded-full', on ? 'border-[5px] border-primary' : 'border-[1.5px] border-border-strong')} />
                <span className="min-w-0 flex-1 leading-snug">
                  <span className="block text-[13.5px] font-medium">{z.name}</span>
                  {desc && <span className="block truncate text-xs text-muted">{desc}</span>}
                </span>
                {on && mx?.mxState === 'other' && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11.5px] font-medium text-warning">MX elsewhere</span>}
              </button>
            );
          })}
          {mx?.mxState === 'other' && (
            <div className="mt-2 flex flex-col gap-3 rounded-[10px] border border-[color-mix(in_oklch,var(--warning)_35%,var(--border))] p-3.5">
              <div className="text-[13px]">
                <b className="font-semibold text-warning">This domain receives mail elsewhere.</b> <span className="text-muted">Mail keeps going there until you replace these MX records.</span>
              </div>
              <div className="overflow-hidden rounded-lg border border-border font-mono text-[12.5px]">
                <div className="grid grid-cols-[60px_70px_1fr] bg-surface-2 px-3 py-2 font-sans text-xs font-medium text-faint">
                  <span>Type</span>
                  <span>Priority</span>
                  <span>Value</span>
                </div>
                {mx.mx.map((r) => (
                  <div key={r.host} className="grid grid-cols-[60px_70px_1fr] border-t border-border px-3 py-2">
                    <span>MX</span>
                    <span>{r.priority ?? '–'}</span>
                    <span className="truncate">{r.host}</span>
                  </div>
                ))}
              </div>
              <Checkbox checked={replaceMx} onChange={setReplaceMx} label="Replace them and move this domain's mail to OpenInbox" />
            </div>
          )}
          {!!mx?.conflicts.length && <Alert tone="neutral">{mx.conflicts.map((c) => c.address).join(', ')} have their own routing rules and will bypass OpenInbox until disabled.</Alert>}
          <p className="mt-1 text-xs text-faint">You can re-run or repair setup from this page at any time.</p>
        </div>
      )}
    </Dialog>
  );
}
