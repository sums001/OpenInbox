import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, ExternalLink, Globe, LoaderCircle, Plus, RefreshCw, Stethoscope, Trash, TriangleAlert, Wrench } from 'lucide-react';
import { del, get, patch, post, errorText } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import type { DomainInfo, DomainSetupStep, MailboxAdmin, ProviderInfo, ZoneInspection } from '../../lib/types';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input, Select } from '../../components/ui/form';
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader, PageSpinner, StatusDot } from '../../components/ui/misc';
import { ConfirmDialog, Dialog } from '../../components/ui/overlay';

export function DomainsPage() {
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => get<DomainInfo[]>('/admin/domains') });
  const mailboxes = useQuery({ queryKey: ['admin', 'mailboxes'], queryFn: () => get<MailboxAdmin[]>('/admin/mailboxes') });
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: () => get<ProviderInfo[]>('/admin/providers') });
  const [adding, setAdding] = useState(false);
  const invalidate = useInvalidate();
  const refresh = () => invalidate(['admin', 'domains'], ['admin', 'overview'], ['admin', 'providers']);
  if (domains.isLoading) return <PageSpinner />;

  return (
    <div>
      <PageHeader
        title="Domains"
        description="Domains in your Cloudflare account that OpenInbox receives mail for. Everything is set up through the Cloudflare API, and every step can be re-run safely."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add domain
          </Button>
        }
      />
      {domains.data?.length === 0 ? (
        <Card>
          <EmptyState icon={<Globe className="h-5 w-5" />} title="No domains yet" action={<Button variant="primary" onClick={() => setAdding(true)}>Add a domain</Button>} />
        </Card>
      ) : (
        <div className="space-y-5">
          {domains.data?.map((d) => (
            <DomainCard key={d.id} domain={d} mailboxes={mailboxes.data ?? []} providers={providers.data ?? []} onChanged={refresh} />
          ))}
        </div>
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
    <div className="space-y-2.5">
      {steps.map((s, i) => (
        <div key={s.id} className="flex gap-2.5">
          {s.status === 'done' ? (
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          ) : s.status === 'error' ? (
            <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          ) : running && i === active ? (
            <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
          ) : (
            <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-border-strong" />
          )}
          <div>
            <div className="text-[13px] font-medium">{s.label}</div>
            {s.message && <div className={cn('text-xs', s.status === 'error' ? 'text-danger' : 'text-muted')}>{s.message}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

async function runSteps(domainId: number, onSteps: (s: DomainSetupStep[]) => void, reset = false): Promise<{ done: boolean; error?: string }> {
  for (let i = 0; i < 6; i++) {
    const r = await post<{ steps: DomainSetupStep[]; done: boolean }>(`/admin/domains/${domainId}/setup${i === 0 && reset ? '?reset=1' : ''}`);
    onSteps(r.steps);
    if (r.done) return { done: true };
    const failed = r.steps.find((s) => s.status === 'error');
    if (failed) return { done: false, error: failed.message };
  }
  return { done: false };
}

function DomainCard({ domain: d, mailboxes, providers, onChanged }: { domain: DomainInfo; mailboxes: MailboxAdmin[]; providers: ProviderInfo[]; onChanged: () => void }) {
  const { run, busy } = useAction();
  const [steps, setSteps] = useState<DomainSetupStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const [appDomain, setAppDomain] = useState(false);
  const [removing, setRemoving] = useState(false);
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

  const tone = d.status === 'active' ? 'success' : d.status === 'error' ? 'danger' : 'warning';
  return (
    <Card>
      <CardHeader
        icon={<StatusDot tone={tone} />}
        title={d.name}
        description={
          <>
            {d.status === 'active' ? 'Receiving mail' : d.status === 'error' ? 'Needs attention' : d.status === 'disabled' ? 'Disabled' : 'Setup not finished'} · {d.addresses} address{d.addresses === 1 ? '' : 'es'}
            {d.healthCheckedAt ? ` · checked ${timeAgo(d.healthCheckedAt)}` : ''}
          </>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Stethoscope className="h-4 w-4" />} loading={busy === 'check'} onClick={() => run('check', () => post(`/admin/domains/${d.id}/check`).then(onChanged))}>
              Check health
            </Button>
            <Button size="sm" icon={<Wrench className="h-4 w-4" />} loading={busy === 'repair'} onClick={() => run('repair', () => post(`/admin/domains/${d.id}/repair`).then(onChanged), 'Repair finished')}>
              Repair
            </Button>
          </div>
        }
      />
      <div className="grid gap-6 p-5 lg:grid-cols-2">
        <div className="space-y-5">
          {!d.setup.done && (
            <div className="space-y-3 rounded-lg border border-warning/30 bg-warning-soft p-4">
              <div className="text-[13px] font-medium text-fg">Setup isn't finished</div>
              <StepList steps={shownSteps} running={running} />
              <Button size="sm" variant="primary" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={running} onClick={finish}>
                Finish setup
              </Button>
            </div>
          )}
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">Health</div>
            {health?.items?.length ? (
              <div className="divide-y divide-border rounded-lg border border-border">
                {health.items.map((h) => (
                  <div key={h.key} className="flex gap-2.5 px-3 py-2">
                    {h.status === 'ok' ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : h.status === 'warn' ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> : <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{h.label}</div>
                      <div className="break-words text-xs text-muted">{h.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[13px] text-muted">Not checked yet. Click "Check health".</div>
            )}
          </div>
          {!!health?.conflicts?.length && (
            <Alert tone="warning" title="Addresses that bypass OpenInbox">
              <div className="space-y-1.5">
                {health.conflicts.map((c) => (
                  <div key={c.address} className="flex items-center justify-between gap-2">
                    <span>
                      {c.address} → {c.action}
                    </span>
                    <Button size="xs" onClick={() => run('rule', () => post(`/admin/domains/${d.id}/disable-rule`, { address: c.address }).then(() => post(`/admin/domains/${d.id}/check`)).then(onChanged), 'Rule disabled')}>
                      Disable rule
                    </Button>
                  </div>
                ))}
              </div>
            </Alert>
          )}
        </div>
        <div className="space-y-5">
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
          <Field label="Send through" hint="Which provider sends mail from this domain. Others are used as fallbacks when it reaches its limit.">
            <Select value={d.providerId ?? ''} onChange={(e) => run('provider', () => patch(`/admin/domains/${d.id}`, { providerId: e.target.value ? Number(e.target.value) : null }).then(onChanged), 'Saved')}>
              <option value="">The default provider</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Web app address" hint="Open OpenInbox at an address on this domain instead of workers.dev.">
            {d.appHostname ? (
              <a href={`https://${d.appHostname}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                https://{d.appHostname} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <Button size="sm" onClick={() => setAppDomain(true)}>
                Use mail.{d.name}
              </Button>
            )}
          </Field>
          <div className="flex justify-end border-t border-border pt-4">
            <Button size="sm" variant="ghost" icon={<Trash className="h-4 w-4" />} onClick={() => setRemoving(true)} disabled={d.addresses > 0} title={d.addresses > 0 ? 'Delete the inboxes on this domain first' : undefined}>
              Remove domain
            </Button>
          </div>
        </div>
      </div>
      {appDomain && <AppDomainDialog domain={d} onClose={() => setAppDomain(false)} onDone={() => { setAppDomain(false); onChanged(); }} />}
      <ConfirmDialog
        open={removing}
        danger
        onClose={() => setRemoving(false)}
        title={`Remove ${d.name}?`}
        confirmLabel="Remove"
        loading={busy === 'remove'}
        onConfirm={() => run('remove', () => del(`/admin/domains/${d.id}`).then(() => { setRemoving(false); onChanged(); }), 'Domain removed')}
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
      footer={
        result ? (
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={!!busy} onClick={() => run('attach', async () => setResult((await post<{ url: string }>(`/admin/domains/${domain.id}/app-domain`, { subdomain: sub })).url))}>
              Attach
            </Button>
          </>
        )
      }
    >
      {result ? (
        <Alert tone="success" title="Attached">
          OpenInbox will answer at <a href={result} className="font-medium underline" target="_blank" rel="noreferrer">{result}</a> within a minute or two, once Cloudflare issues the certificate. Sign in again there (sessions are per address).
        </Alert>
      ) : (
        <Field label="Address" hint="Cloudflare creates the DNS record and certificate. The workers.dev address keeps working.">
          <div className="flex items-center overflow-hidden rounded-lg border border-border">
            <input className="h-9 min-w-0 flex-1 bg-surface px-3 text-sm outline-none" value={sub} onChange={(e) => setSub(e.target.value.trim())} />
            <span className="border-l border-border bg-surface-2 px-3 py-2 text-sm text-muted">.{domain.name}</span>
          </div>
        </Field>
      )}
    </Dialog>
  );
}

function AddDomainDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const zones = useQuery({ queryKey: ['admin', 'zones'], queryFn: () => get<{ id: string; name: string; status: string; connected: boolean }[]>('/admin/zones') });
  const available = (zones.data ?? []).filter((z) => !z.connected);
  const [zoneId, setZoneId] = useState('');
  const [replaceMx, setReplaceMx] = useState(false);
  const [steps, setSteps] = useState<DomainSetupStep[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!zoneId && available[0]) setZoneId(available[0].id);
  }, [available, zoneId]);
  const inspection = useQuery({ queryKey: ['admin', 'zone', zoneId], queryFn: () => get<ZoneInspection>(`/admin/zones/${zoneId}`), enabled: !!zoneId && !steps });
  const mx = inspection.data;

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const { id } = await post<{ id: number }>('/admin/domains', { zoneId, replaceMx });
      const r = await runSteps(id, setSteps);
      if (r.done) setDone(true);
      else if (r.error) setError(r.error);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={steps ? onAdded : onClose}
      title="Add a domain"
      description="Pick a domain from your Cloudflare account. OpenInbox enables Email Routing, routes its mail here and adds DMARC if missing."
      footer={
        done || steps ? (
          <Button variant="primary" onClick={onAdded}>
            {done ? 'Done' : 'Close'}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!zoneId || (mx?.mxState === 'other' && !replaceMx)} onClick={add}>
              Add and set up
            </Button>
          </>
        )
      }
    >
      {steps ? (
        <div className="space-y-4">
          <StepList steps={steps} running={busy} />
          {error && <Alert tone="danger">{error}</Alert>}
          {done && <Alert tone="success">Mail for this domain now arrives in OpenInbox. Create inboxes for it on the Inboxes page.</Alert>}
        </div>
      ) : zones.isLoading ? (
        <PageSpinner />
      ) : available.length === 0 ? (
        <Alert tone="neutral" title="No more domains">
          Every domain in your Cloudflare account is connected. Add a new domain to Cloudflare first, then come back.
        </Alert>
      ) : (
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Domain">
            <Select value={zoneId} onChange={(e) => { setZoneId(e.target.value); setReplaceMx(false); }}>
              {available.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </Select>
          </Field>
          {mx?.mxState === 'none' && <Alert tone="success">This domain does not receive mail yet.</Alert>}
          {mx?.mxState === 'cloudflare' && <Alert tone="success">Email Routing is already on for this domain.</Alert>}
          {mx?.mxState === 'other' && (
            <Alert tone="warning" title="This domain receives mail elsewhere">
              <div>MX records point to {mx.mx.map((m) => m.host).join(', ')}.</div>
              <div className="mt-2">
                <Checkbox checked={replaceMx} onChange={setReplaceMx} label="Replace them and move this domain's mail to OpenInbox" />
              </div>
            </Alert>
          )}
          {!!mx?.conflicts.length && <Alert tone="neutral">{mx.conflicts.map((c) => c.address).join(', ')} have their own routing rules and will bypass OpenInbox until disabled.</Alert>}
          <Input type="hidden" value={zoneId} readOnly />
          <Badge tone="neutral">You can re-run or repair setup from this page at any time.</Badge>
        </div>
      )}
    </Dialog>
  );
}
