import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, CircleCheck, CircleX, Cloud, Ellipsis, ExternalLink, HardDrive, Plug, Plus, RefreshCw, Send, Star, TriangleAlert, Webhook } from 'lucide-react';
import { del, get, patch, post, errorText } from '../../lib/api';
import { num, timeAgo } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { PROVIDER_INFO, tokenTemplateUrl, type ProviderType } from '../../../shared/constants';
import type { PermissionCheck, ProviderInfo } from '../../lib/types';
import { Button } from '../../components/ui/button';
import { Field, Input, PasswordInput, SegmentedControl, Select } from '../../components/ui/form';
import { Alert, Badge, Card, CardHeader, CopyButton, Meter, PageHeader, PageSpinner, StatusDot } from '../../components/ui/misc';
import { ConfirmDialog, Dialog, Menu, MenuItem, MenuSeparator } from '../../components/ui/overlay';
import { PermissionList } from '../setup/SetupPage';

export function IntegrationsPage() {
  useEffect(() => {
    if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' }), 300);
  }, []);
  return (
    <div className="space-y-10">
      <PageHeader title="Integrations" description="Sending providers, your Cloudflare connection and optional attachment storage." />
      <ProvidersSection />
      <CloudflareSection />
      <StorageSection />
    </div>
  );
}

const PROVIDER_ACCENT: Record<ProviderType, string> = { resend: '#111111', brevo: '#0b996e', mailjet: '#fea500', smtp: '#6366f1' };

function ProviderMark({ type, size = 36 }: { type: ProviderType; size?: number }) {
  const letter = { resend: 'R', brevo: 'B', mailjet: 'M', smtp: '@' }[type];
  return (
    <div className="flex shrink-0 items-center justify-center rounded-lg font-bold text-white" style={{ width: size, height: size, background: PROVIDER_ACCENT[type], fontSize: size * 0.45 }}>
      {letter}
    </div>
  );
}

function ProvidersSection() {
  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: () => get<ProviderInfo[]>('/admin/providers') });
  const [connect, setConnect] = useState<ProviderType | null>(null);
  const invalidate = useInvalidate();
  const refresh = () => invalidate(['admin', 'providers'], ['admin', 'overview'], ['admin', 'domains']);
  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Send className="h-4 w-4" /> Sending providers
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          Cloudflare receives your mail; a provider sends it. Connect one or more: OpenInbox verifies your domains with them, writes their DNS records, tracks their free limits, and falls back to the next provider when one is full.
        </p>
      </div>
      {providers.isLoading ? (
        <PageSpinner />
      ) : (
        <div className="space-y-4">
          {providers.data?.map((p) => <ProviderCard key={p.id} provider={p} onChanged={refresh} />)}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(PROVIDER_INFO) as ProviderType[]).map((t) => (
          <button key={t} type="button" onClick={() => setConnect(t)} className="flex items-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface p-4 text-left transition-colors hover:border-primary hover:bg-primary-soft/40">
            <ProviderMark type={t} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Plus className="h-3.5 w-3.5" /> {PROVIDER_INFO[t].label}
              </div>
              <div className="truncate text-xs text-muted">{PROVIDER_INFO[t].freeTier}</div>
            </div>
          </button>
        ))}
      </div>
      {connect && (
        <ConnectDialog
          type={connect}
          onClose={() => setConnect(null)}
          onConnected={() => {
            setConnect(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

function ProviderCard({ provider: p, onChanged }: { provider: ProviderInfo; onChanged: () => void }) {
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => get<{ id: number; name: string }[]>('/admin/domains') });
  const unconfigured = (domains.data ?? []).filter((d) => !p.domains.some((x) => x.domainId === d.id));
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-4 px-5 py-4">
        <ProviderMark type={p.type} size={40} />
        <div className="min-w-48 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{p.name}</span>
            {p.isDefault && (
              <Badge tone="primary">
                <Star className="h-3 w-3" /> Default
              </Badge>
            )}
            <Badge tone={p.status === 'connected' ? 'success' : p.status === 'error' ? 'danger' : 'neutral'}>{p.status}</Badge>
          </div>
          <div className="text-xs text-muted">
            {Object.entries(p.config)
              .filter(([k]) => k !== 'password' && k !== 'apiSecret')
              .map(([k, v]) => `${k}: ${v}`)
              .join(' · ')}
            {p.checkedAt ? ` · checked ${timeAgo(p.checkedAt)}` : ''}
          </div>
          {p.lastError && <div className="mt-1 text-xs text-danger">{p.lastError}</div>}
        </div>
        <div className="w-56 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted">Today</span>
            <span>
              {num(p.usedToday)}
              {p.dailyLimit !== null && ` / ${num(p.dailyLimit)}`}
            </span>
          </div>
          {p.dailyLimit !== null && <Meter value={p.usedToday} max={p.dailyLimit} />}
          {p.monthlyLimit !== null && (
            <>
              <div className="flex justify-between text-xs">
                <span className="text-muted">This month</span>
                <span>
                  {num(p.usedMonth)} / {num(p.monthlyLimit)}
                </span>
              </div>
              <Meter value={p.usedMonth} max={p.monthlyLimit} />
            </>
          )}
        </div>
        <Menu
          trigger={({ onClick }) => (
            <Button variant="ghost" size="icon" onClick={onClick} aria-label="Provider actions">
              <Ellipsis className="h-4 w-4" />
            </Button>
          )}
        >
          <MenuItem icon={<RefreshCw />} onClick={() => run('test', async () => {
            const r = await post<{ ok: boolean; message: string }>(`/admin/providers/${p.id}/test`);
            onChanged();
            if (!r.ok) throw new Error(r.message);
          }, 'Connection works')}>
            Test connection
          </MenuItem>
          {!p.isDefault && (
            <MenuItem icon={<Star />} onClick={() => run('default', () => patch(`/admin/providers/${p.id}`, { isDefault: true }).then(onChanged), 'Default provider changed')}>
              Make default
            </MenuItem>
          )}
          <MenuItem onClick={() => setEditing(true)}>Edit limits and credentials</MenuItem>
          {p.type !== 'smtp' && (
            <MenuItem icon={<Webhook />} onClick={() => run('webhook', async () => {
              const r = await post<{ ok: boolean }>(`/admin/providers/${p.id}/webhook`);
              onChanged();
              if (!r.ok) throw new Error('The provider did not accept the webhook. Register it in their dashboard instead.');
            }, 'Delivery webhook registered')}>
              {p.webhook ? 'Re-register delivery webhook' : 'Register delivery webhook'}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem danger onClick={() => setRemoving(true)}>
            Remove
          </MenuItem>
        </Menu>
      </div>
      {p.type !== 'smtp' && (
        <div className="border-t border-border">
          {p.domains.map((d) => (
            <div key={d.domainId} className="border-b border-border last:border-0">
              <div className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                <StatusDot tone={d.status === 'verified' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'} />
                <span className="text-[13px] font-medium">{d.name}</span>
                <span className="text-xs text-muted">{d.status === 'verified' ? 'Verified for sending' : d.lastError || 'Waiting for verification'}</span>
                <div className="flex-1" />
                <Button size="xs" variant="ghost" onClick={() => setExpanded(expanded === d.domainId ? null : d.domainId)}>
                  {expanded === d.domainId ? 'Hide' : 'DNS records'}
                </Button>
                {d.status !== 'verified' && (
                  <Button size="xs" loading={busy === `check-${d.domainId}`} onClick={() => run(`check-${d.domainId}`, () => post(`/admin/providers/${p.id}/domains/${d.domainId}/check`).then(onChanged))}>
                    Check now
                  </Button>
                )}
                <Button size="xs" variant="ghost" loading={busy === `sync-${d.domainId}`} onClick={() => run(`sync-${d.domainId}`, () => post(`/admin/providers/${p.id}/domains/${d.domainId}`).then(onChanged), 'DNS records written')}>
                  Rewrite DNS
                </Button>
              </div>
              {expanded === d.domainId && (
                <div className="overflow-x-auto px-5 pb-3">
                  <table className="w-full text-xs">
                    <thead className="text-left text-faint">
                      <tr>
                        <th className="py-1 pr-3 font-medium">Type</th>
                        <th className="py-1 pr-3 font-medium">Name</th>
                        <th className="py-1 pr-3 font-medium">Value</th>
                        <th className="py-1 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.records.map((r, i) => (
                        <tr key={i} className="border-t border-border align-top">
                          <td className="py-1.5 pr-3 font-mono">{r.type}</td>
                          <td className="py-1.5 pr-3 font-mono">{r.name}</td>
                          <td className="max-w-md py-1.5 pr-3 font-mono break-all">
                            {r.priority !== undefined ? `${r.priority} ` : ''}
                            {r.content}
                          </td>
                          <td className="py-1.5">{r.status ?? '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
          {unconfigured.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-5 py-2.5">
              <StatusDot tone="neutral" />
              <span className="text-[13px] font-medium">{d.name}</span>
              <span className="text-xs text-muted">Not set up with {p.name}</span>
              <div className="flex-1" />
              <Button size="xs" variant="primary" loading={busy === `sync-${d.id}`} onClick={() => run(`sync-${d.id}`, () => post(`/admin/providers/${p.id}/domains/${d.id}`).then(onChanged), 'Domain set up')}>
                Set up sending
              </Button>
            </div>
          ))}
        </div>
      )}
      {p.type === 'smtp' && (
        <div className="border-t border-border px-5 py-3 text-xs text-muted">
          SMTP has no domain API: publish your SMTP provider's SPF and DKIM records for each domain yourself. Domain health shows whether SPF includes them.
        </div>
      )}
      {editing && <EditProviderDialog provider={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />}
      <ConfirmDialog
        open={removing}
        danger
        onClose={() => setRemoving(false)}
        title={`Remove ${p.name}?`}
        confirmLabel="Remove"
        loading={busy === 'remove'}
        onConfirm={() => run('remove', () => del(`/admin/providers/${p.id}`).then(() => { setRemoving(false); onChanged(); }), 'Provider removed')}
      >
        OpenInbox stops sending through it. DNS records stay in place. Domains set to send through it must be switched first.
      </ConfirmDialog>
    </Card>
  );
}

function credentialFields(type: ProviderType) {
  if (type === 'smtp')
    return [
      { key: 'host', label: 'SMTP server', placeholder: 'smtp.example.com' },
      { key: 'port', label: 'Port', placeholder: '587' },
      { key: 'username', label: 'Username', placeholder: '' },
      { key: 'password', label: 'Password', placeholder: '', secret: true },
    ];
  if (type === 'mailjet')
    return [
      { key: 'apiKey', label: 'API key', placeholder: '' },
      { key: 'apiSecret', label: 'Secret key', placeholder: '', secret: true },
    ];
  return [{ key: 'apiKey', label: 'API key', placeholder: type === 'resend' ? 're_...' : 'xkeysib-...', secret: true }];
}

const KEY_HELP: Record<ProviderType, { href: string; text: string }> = {
  resend: { href: 'https://resend.com/api-keys', text: 'Create a key with Full access in Resend → API Keys (full access lets OpenInbox verify domains for you).' },
  brevo: { href: 'https://app.brevo.com/settings/keys/api', text: 'Create an API key in Brevo → SMTP & API → API Keys.' },
  mailjet: { href: 'https://app.mailjet.com/account/apikeys', text: 'Find your API key and secret key in Mailjet → Account settings → API Key Management.' },
  smtp: { href: '', text: 'Use port 587 (STARTTLS) or 465 (TLS). Port 25 is blocked on Cloudflare Workers.' },
};

function ConnectDialog({ type, onClose, onConnected }: { type: ProviderType; onClose: () => void; onConnected: () => void }) {
  const info = PROVIDER_INFO[type];
  const [values, setValues] = useState<Record<string, string>>({ port: '587' });
  const [security, setSecurity] = useState<'starttls' | 'tls'>('starttls');
  const [daily, setDaily] = useState(info.dailyLimit?.toString() ?? '');
  const [monthly, setMonthly] = useState(info.monthlyLimit?.toString() ?? '');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ note?: string; domains: { domainId: number; status: string; error?: string; message?: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const config: Record<string, unknown> = { ...values };
      if (type === 'smtp') {
        config.port = Number(values.port);
        config.security = security;
      }
      const r = await post<{ note?: string; domains: { domainId: number; status: string; error?: string }[] }>('/admin/providers', {
        type,
        config,
        dailyLimit: daily ? Number(daily) : null,
        monthlyLimit: monthly ? Number(monthly) : null,
      });
      setResult(r);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={result ? onConnected : onClose}
      title={`Connect ${info.label}`}
      description={info.website ? `Free tier: ${info.freeTier}.` : undefined}
      footer={
        result ? (
          <Button variant="primary" onClick={onConnected}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="connect-provider" loading={busy}>
              Connect
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <Alert tone="success" title={`${info.label} connected`}>
            {result.note ?? 'Credentials work. Domain setup results:'}
          </Alert>
          {result.domains.map((d) => (
            <div key={d.domainId} className="flex items-center gap-2 text-sm">
              {d.status === 'verified' ? <CircleCheck className="h-4 w-4 text-success" /> : d.status === 'failed' ? <CircleX className="h-4 w-4 text-danger" /> : <TriangleAlert className="h-4 w-4 text-warning" />}
              <span>{d.status === 'verified' ? 'Verified' : d.status === 'failed' ? d.error ?? 'Failed' : 'DNS written; waiting for the provider to verify (usually a few minutes)'}</span>
            </div>
          ))}
        </div>
      ) : (
        <form id="connect-provider" onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <p className="text-[13px] text-muted">
            {KEY_HELP[type].text}{' '}
            {KEY_HELP[type].href && (
              <a href={KEY_HELP[type].href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                Open <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
          {credentialFields(type).map((f) => (
            <Field key={f.key} label={f.label} id={f.key}>
              {f.secret ? (
                <PasswordInput id={f.key} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} required={f.key !== 'password'} />
              ) : (
                <Input id={f.key} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} required={f.key !== 'username'} />
              )}
            </Field>
          ))}
          {type === 'smtp' && (
            <Field label="Security">
              <SegmentedControl value={security} onChange={setSecurity} options={[{ value: 'starttls', label: 'STARTTLS (587)' }, { value: 'tls', label: 'TLS (465)' }]} />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Daily limit" hint="Leave empty for no cap.">
              <Input type="number" min={0} value={daily} onChange={(e) => setDaily(e.target.value)} />
            </Field>
            <Field label="Monthly limit">
              <Input type="number" min={0} value={monthly} onChange={(e) => setMonthly(e.target.value)} />
            </Field>
          </div>
          {info.hasDomainApi && <p className="text-xs text-muted">After connecting, OpenInbox registers each of your domains with {info.label} and writes the DNS records it asks for.</p>}
        </form>
      )}
    </Dialog>
  );
}

function EditProviderDialog({ provider: p, onClose, onSaved }: { provider: ProviderInfo; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(p.name);
  const [daily, setDaily] = useState(p.dailyLimit?.toString() ?? '');
  const [monthly, setMonthly] = useState(p.monthlyLimit?.toString() ?? '');
  const [priority, setPriority] = useState(String(p.priority));
  const [config, setConfig] = useState<Record<string, string>>(Object.fromEntries(Object.entries(p.config).map(([k, v]) => [k, String(v)])));
  const [secret, setSecret] = useState('');
  const { run, busy } = useAction();
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${p.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={!!busy}
            onClick={() =>
              run('save', async () => {
                await patch(`/admin/providers/${p.id}`, {
                  name,
                  dailyLimit: daily ? Number(daily) : null,
                  monthlyLimit: monthly ? Number(monthly) : null,
                  priority: Number(priority) || 0,
                  config: p.type === 'smtp' ? { ...config, port: Number(config.port) } : config,
                });
                if (secret) await post(`/admin/providers/${p.id}/webhook-secret`, { secret });
                onSaved();
              }, 'Saved')
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Daily limit">
            <Input type="number" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </Field>
          <Field label="Monthly limit">
            <Input type="number" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
          </Field>
          <Field label="Fallback order" hint="Lower goes first.">
            <Input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="text-xs font-medium text-muted">Credentials (leave masked values to keep them)</div>
          {credentialFields(p.type).map((f) => (
            <Field key={f.key} label={f.label}>
              <Input value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
            </Field>
          ))}
          {p.type === 'smtp' && (
            <Field label="Security">
              <Select value={config.security ?? 'starttls'} onChange={(e) => setConfig({ ...config, security: e.target.value })}>
                <option value="starttls">STARTTLS</option>
                <option value="tls">TLS</option>
              </Select>
            </Field>
          )}
        </div>
        {p.type === 'resend' && (
          <Field label="Webhook signing secret" hint="Only if you registered the webhook yourself in the Resend dashboard (whsec_…).">
            <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="whsec_..." />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

interface CloudflareInfo {
  connected: boolean;
  message?: string;
  source: 'secret' | 'stored' | null;
  account?: { id: string | null; name: string | null };
  worker?: { name: string | null; subdomain: string | null; d1Id: string | null };
  permissions: PermissionCheck[];
}

function CloudflareSection() {
  const cf = useQuery({ queryKey: ['admin', 'cloudflare'], queryFn: () => get<CloudflareInfo>('/admin/cloudflare') });
  const [token, setToken] = useState('');
  const { run, busy } = useAction();
  const data = cf.data;
  return (
    <section className="space-y-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Cloud className="h-4 w-4" /> Cloudflare
      </h2>
      <Card>
        {cf.isLoading ? (
          <PageSpinner />
        ) : (
          <div className="grid gap-6 p-5 lg:grid-cols-2">
            <div className="space-y-3 text-[13px]">
              <div className="flex items-center gap-2">
                {data?.connected ? <CircleCheck className="h-5 w-5 text-success" /> : <CircleX className="h-5 w-5 text-danger" />}
                <span className="text-sm font-medium">{data?.connected ? 'API token connected' : data?.message ?? 'No API token'}</span>
              </div>
              <dl className="grid grid-cols-[120px_1fr] gap-y-1.5">
                <dt className="text-muted">Token source</dt>
                <dd>{data?.source === 'secret' ? 'CF_API_TOKEN secret' : data?.source === 'stored' ? 'Pasted in OpenInbox (encrypted)' : '–'}</dd>
                <dt className="text-muted">Account</dt>
                <dd>{data?.account?.name ?? '–'}</dd>
                <dt className="text-muted">Worker</dt>
                <dd>{data?.worker?.name ? `${data.worker.name}${data.worker.subdomain ? ` (${data.worker.name}.${data.worker.subdomain}.workers.dev)` : ''}` : '–'}</dd>
                <dt className="text-muted">D1 database</dt>
                <dd className="truncate font-mono text-xs">{data?.worker?.d1Id ?? '–'}</dd>
              </dl>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === 'detect'} onClick={() => run('detect', () => post('/admin/cloudflare/detect').then(() => cf.refetch()), 'Worker detected')}>
                  Detect again
                </Button>
              </div>
              {data?.source !== 'secret' && (
                <form
                  className="space-y-2 border-t border-border pt-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run('token', () => post('/admin/cloudflare/token', { token }).then(() => { setToken(''); cf.refetch(); }), 'Token saved');
                  }}
                >
                  <Field label="Replace API token">
                    <div className="flex gap-2">
                      <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="New Cloudflare API token" required />
                      <Button type="submit" loading={busy === 'token'}>
                        Save
                      </Button>
                    </div>
                  </Field>
                  <a href={tokenTemplateUrl()} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline">
                    Create a token with every permission filled in <ExternalLink className="h-3 w-3" />
                  </a>
                </form>
              )}
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-faint">Permissions</div>
              {data?.permissions.length ? <PermissionList permissions={data.permissions} /> : <div className="mt-2 text-[13px] text-muted">Unavailable.</div>}
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}

interface StorageInfo {
  mode: 'text' | 'r2';
  configured: boolean;
  bucket: string | null;
  accessKeyId: string | null;
  r2Enabled: boolean | null;
  bucketPermission: boolean;
  accountId: string | null;
  summary: { d1Bytes: number | null; messages: number };
}

function StorageSection() {
  const storage = useQuery({ queryKey: ['admin', 'storage'], queryFn: () => get<StorageInfo>('/admin/storage') });
  const [bucket, setBucket] = useState('openinbox-mail');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const { run, busy } = useAction();
  const invalidate = useInvalidate();
  const s = storage.data;
  const refresh = () => invalidate(['admin', 'storage'], ['admin', 'overview'], ['session']);
  const dash = s?.accountId ? `https://dash.cloudflare.com/${s.accountId}/r2` : 'https://dash.cloudflare.com/?to=/:account/r2';

  return (
    <section id="storage" className="space-y-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <HardDrive className="h-4 w-4" /> Attachments (R2)
      </h2>
      <Card>
        <CardHeader
          title={s?.mode === 'r2' ? 'Attachments are on' : 'Text-only mode'}
          description={
            s?.mode === 'r2'
              ? `New mail is kept in full in the R2 bucket "${s.bucket}". You can attach files when composing.`
              : 'Mail text and HTML are stored in D1; attachments are listed but not stored (except on small messages). Turn on R2 to keep every attachment and send files.'
          }
          icon={s?.mode === 'r2' ? <CircleCheck className="h-5 w-5 text-success" /> : <Plug className="h-5 w-5" />}
          action={
            s?.configured ? (
              <SegmentedControl
                value={s.mode}
                onChange={(mode) => run('mode', () => post('/admin/storage/mode', { mode }).then(refresh), mode === 'r2' ? 'Attachments on' : 'Text-only mode on')}
                options={[{ value: 'text', label: 'Text-only' }, { value: 'r2', label: 'R2' }]}
              />
            ) : undefined
          }
        />
        {storage.isLoading ? (
          <PageSpinner />
        ) : (
          <div className="space-y-5 p-5">
            {s?.configured && (
              <div className="flex flex-wrap items-center gap-3 text-[13px]">
                <Badge tone="success">
                  <Check className="h-3 w-3" /> Connected
                </Badge>
                <span className="text-muted">Bucket {s.bucket} · key {s.accessKeyId}</span>
                <Button size="xs" loading={busy === 'test'} onClick={() => run('test', async () => {
                  const r = await post<{ ok: boolean; message?: string }>('/admin/storage/test');
                  if (!r.ok) throw new Error(r.message);
                }, 'R2 works')}>
                  Test
                </Button>
              </div>
            )}
            <ol className="space-y-5">
              <SetupStep n={1} title="Enable R2 on your Cloudflare account" done={s?.r2Enabled === true}>
                R2 has a free tier (10 GB), but Cloudflare asks for a payment method before turning it on.{' '}
                <a href={dash} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                  Open R2 <ExternalLink className="h-3 w-3" />
                </a>
                {s?.r2Enabled === false && <div className="mt-1 text-warning">R2 is not enabled on this account yet.</div>}
              </SetupStep>
              <SetupStep n={2} title="Create a bucket">
                <div className="mt-2 flex flex-wrap gap-2">
                  <Input value={bucket} onChange={(e) => setBucket(e.target.value.toLowerCase())} className="max-w-60" />
                  {s?.bucketPermission ? (
                    <Button size="sm" loading={busy === 'bucket'} onClick={() => run('bucket', () => post('/admin/storage/bucket', { bucket }), `Bucket ${bucket} is ready`)}>
                      Create it for me
                    </Button>
                  ) : (
                    <span className="self-center text-xs text-muted">Create it in the R2 dashboard (the token lacks R2 permission), then enter its name here.</span>
                  )}
                </div>
              </SetupStep>
              <SetupStep n={3} title="Create an R2 API token and paste its S3 keys">
                In R2 → Manage API tokens, create a token with <b>Object Read & Write</b> for this bucket, then copy the Access Key ID and Secret Access Key.{' '}
                <a href={`${dash}/api-tokens`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                  Open <ExternalLink className="h-3 w-3" />
                </a>
                <form
                  className="mt-3 grid gap-3 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run('connect', () => post('/admin/storage/r2', { bucket, accessKeyId: keyId, secretAccessKey: secret }).then(() => { setSecret(''); refresh(); }), 'Attachments are on');
                  }}
                >
                  <Input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="Access Key ID" required />
                  <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Secret Access Key" required />
                  <div className="sm:col-span-2">
                    <Button type="submit" variant="primary" loading={busy === 'connect'}>
                      Test and turn on attachments
                    </Button>
                  </div>
                </form>
              </SetupStep>
            </ol>
            <p className="text-xs text-muted">
              The keys are stored encrypted in D1 and used through R2's S3 API, so redeploys never undo this. Mail that arrived in text-only mode stays text-only.
            </p>
          </div>
        )}
      </Card>
    </section>
  );
}

function SetupStep({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', done ? 'bg-success text-white' : 'bg-surface-3 text-muted')}>{done ? <Check className="h-3.5 w-3.5" /> : n}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-[13px] text-muted">{children}</div>
      </div>
    </li>
  );
}

export { CopyButton };
