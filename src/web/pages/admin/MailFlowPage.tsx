import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Cloud, OctagonAlert, RefreshCw, RotateCw, Search, TriangleAlert, Waypoints } from 'lucide-react';
import { get, post } from '../../lib/api';
import { bytes, fullDate, timeAgo } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Alert, Card, EmptyState, PageHeader, PageSpinner, Tabs, type Tone } from '../../components/ui/misc';

interface InboundEntry {
  id: number;
  at: number;
  from: string;
  to: string;
  subject: string;
  size: number;
  status: 'delivered' | 'spam' | 'duplicate' | 'rejected' | 'unparsed' | 'error';
  reason: string | null;
}

interface CfEvent {
  domain: string;
  datetime: string;
  from: string;
  to: string;
  subject: string;
  status: string;
  action: string;
  errorDetail: string | null;
  spf: string;
  dkim: string;
  dmarc: string;
}

interface Failure {
  id: number;
  threadId: number;
  mailbox: string;
  kind: 'failed' | 'unparsed';
  subject: string;
  from: string;
  to: { address: string }[];
  error: string | null;
  attempts: number;
  retryAt: number | null;
  at: number;
}

const STATUS_TONE: Record<string, Tone> = { delivered: 'success', spam: 'warning', duplicate: 'neutral', rejected: 'danger', unparsed: 'warning', error: 'danger', dropped: 'neutral' };
const PILL: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  primary: 'bg-primary-soft text-primary-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

function Outcome({ status }: { status: string }) {
  return (
    <span className={cn('inline-flex h-5 items-center gap-[5px] rounded-full px-[7px] text-[11.5px] font-medium capitalize', PILL[STATUS_TONE[status] ?? 'danger'])}>
      <span className="h-[5px] w-[5px] rounded-full bg-current" />
      {status}
    </span>
  );
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

const grid = 'grid grid-cols-[64px_minmax(0,1fr)_88px] items-center gap-3.5 px-[18px] md:grid-cols-[76px_minmax(0,2.2fr)_minmax(0,1.6fr)_100px_minmax(0,1.4fr)]';

export function MailFlowPage() {
  const [tab, setTab] = useState<'inbound' | 'cloudflare' | 'failures'>('inbound');
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const failures = useQuery({ queryKey: ['admin', 'failures'], queryFn: () => get<Failure[]>('/admin/failures') });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Mail flow" description="What happened to recent mail: deliveries, rejections, spam, and sends that need attention." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'inbound', label: 'Inbound log' },
          { value: 'cloudflare', label: 'Cloudflare Email Routing' },
          { value: 'failures', label: 'Problems', count: failures.data?.length, tone: 'danger' },
        ]}
      >
        {tab !== 'failures' && (
          <div className="flex h-[30px] w-full items-center gap-2 rounded-[7px] border border-border bg-surface px-2.5 focus-within:border-primary sm:w-60">
            <Search className="h-3.5 w-3.5 text-faint" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by address or subject" aria-label="Filter by address or subject" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
          </div>
        )}
        {tab === 'inbound' && (
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Outcome" className="select-chevron h-[30px] rounded-[7px] border border-border bg-surface pr-8 pl-2.5 text-[12.5px] text-muted outline-none">
            <option value="">All outcomes</option>
            {['delivered', 'spam', 'rejected', 'duplicate', 'unparsed'].map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        )}
      </Tabs>
      {tab === 'inbound' && <InboundLog status={status} filter={filter} />}
      {tab === 'cloudflare' && <CloudflareLog filter={filter} />}
      {tab === 'failures' && <Failures data={failures.data} loading={failures.isLoading} />}
    </div>
  );
}

const matches = (q: string, ...fields: string[]) => !q || fields.some((f) => f?.toLowerCase().includes(q));

function InboundLog({ status, filter }: { status: string; filter: string }) {
  const log = useQuery({ queryKey: ['admin', 'mailflow', status], queryFn: () => get<InboundEntry[]>(`/admin/mailflow${status ? `?status=${status}` : ''}`), refetchInterval: 30_000 });
  const q = filter.trim().toLowerCase();
  const rows = useMemo(() => (log.data ?? []).filter((e) => matches(q, e.from, e.to, e.subject)), [log.data, q]);
  if (log.isLoading) return <PageSpinner />;
  if (!log.data?.length)
    return (
      <Card>
        <EmptyState icon={<Waypoints />} title="No mail yet">
          Deliveries, rejections and spam show up here as mail arrives.
        </EmptyState>
      </Card>
    );
  return (
    <Card className="overflow-hidden">
      <div className={cn(grid, 'h-9 border-b border-border bg-surface-2 text-xs font-medium text-faint')}>
        <span>Time</span>
        <span>From → To</span>
        <span className="max-md:hidden">Subject</span>
        <span>Outcome</span>
        <span className="max-md:hidden">Reason</span>
      </div>
      {rows.map((e) => (
        <div key={e.id} className={cn(grid, 'min-h-10 border-b border-border py-1.5 text-[12.5px]')}>
          <span className="font-mono text-xs text-muted tabular-nums" title={fullDate(e.at)}>
            {clock(e.at)}
          </span>
          <span className="truncate">
            {e.from || '–'} <span className="text-faint">→</span> <span className="text-muted">{e.to}</span>
          </span>
          <span className="truncate text-muted max-md:hidden">{e.subject || '–'}</span>
          <span>
            <Outcome status={e.status} />
          </span>
          <span className="truncate text-faint max-md:hidden" title={e.reason ?? undefined}>
            {e.reason ?? bytes(e.size)}
          </span>
        </div>
      ))}
      <div className="flex h-10 items-center justify-center text-[12.5px] text-faint">
        {rows.length === log.data.length ? `${log.data.length} recent events` : `${rows.length} of ${log.data.length} recent events`}
      </div>
    </Card>
  );
}

function CloudflareLog({ filter }: { filter: string }) {
  const log = useQuery({ queryKey: ['admin', 'mailflow', 'cf'], queryFn: () => get<{ available: boolean; reason?: string; events: CfEvent[] }>('/admin/mailflow/cloudflare') });
  const q = filter.trim().toLowerCase();
  if (log.isLoading) return <PageSpinner />;
  if (!log.data?.available) return <Alert tone="warning">{log.data?.reason ?? 'Unavailable.'}</Alert>;
  const rows = log.data.events.filter((e) => matches(q, e.from, e.to, e.subject));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 text-[12.5px] text-muted">
        <Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 text-pretty">Cloudflare's own log for the last 24 hours, including mail it rejected before OpenInbox saw it. "dropped" is normal: OpenInbox stores the mail instead of forwarding it.</span>
        <Button size="xs" variant="ghost" icon={<RefreshCw className={cn(log.isFetching && 'animate-spin')} />} onClick={() => log.refetch()}>
          Refresh
        </Button>
      </div>
      <Card className="overflow-hidden">
        {!log.data.events.length ? (
          <EmptyState icon={<Waypoints />} title="No events in the last 24 hours">
            Deliveries, rejections and spam show up here as mail arrives.
          </EmptyState>
        ) : (
          <>
            <div className={cn(grid, 'h-9 border-b border-border bg-surface-2 text-xs font-medium text-faint')}>
              <span>Time</span>
              <span>From → To</span>
              <span className="max-md:hidden">Subject</span>
              <span>Outcome</span>
              <span className="max-md:hidden">Authentication</span>
            </div>
            {rows.map((e, i) => (
              <div key={i} className={cn(grid, 'min-h-10 border-b border-border py-1.5 text-[12.5px]')}>
                <span className="font-mono text-xs text-muted tabular-nums" title={e.datetime}>
                  {clock(Date.parse(e.datetime))}
                </span>
                <span className="truncate">
                  {e.from} <span className="text-faint">→</span> <span className="text-muted">{e.to}</span>
                  {e.errorDetail && <span className="block truncate text-xs text-danger">{e.errorDetail}</span>}
                </span>
                <span className="truncate text-muted max-md:hidden">{e.subject}</span>
                <span>
                  <Outcome status={e.status} />
                </span>
                <span className="flex gap-2 truncate text-xs max-md:hidden">
                  {(['spf', 'dkim', 'dmarc'] as const).map((k) => (
                    <span key={k} className={e[k] === 'pass' ? 'text-success' : e[k] === 'none' ? 'text-faint' : 'text-warning'}>
                      {k.toUpperCase()} {e[k]}
                    </span>
                  ))}
                </span>
              </div>
            ))}
            <div className="flex h-10 items-center justify-center text-[12.5px] text-faint">Showing the last 24 hours · {log.data.events.length} events</div>
          </>
        )}
      </Card>
    </div>
  );
}

function Failures({ data, loading }: { data?: Failure[]; loading: boolean }) {
  const { run, busy } = useAction();
  const invalidate = useInvalidate();
  if (loading) return <PageSpinner />;
  if (!data?.length)
    return (
      <Card>
        <EmptyState icon={<CircleCheck />} tone="success" title="No problems">
          Bounces, complaints, failed sends and unreadable messages would appear here.
        </EmptyState>
      </Card>
    );
  return (
    <Card className="overflow-hidden">
      {data.map((f) => (
        <div key={f.id} className="flex flex-wrap items-start gap-3 border-b border-border px-5 py-3.5 last:border-b-0">
          <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-[7px]', f.kind === 'failed' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning')}>
            {f.kind === 'failed' ? <CircleX className="h-3.5 w-3.5" /> : <OctagonAlert className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-60 flex-1">
            <div className="text-[13px] font-semibold">{f.subject || '(no subject)'}</div>
            <div className="text-xs text-muted">
              {f.kind === 'failed' ? `To ${f.to.map((t) => t.address).join(', ')} from ${f.mailbox}` : `Received by ${f.mailbox}`} · {timeAgo(f.at)} · {f.attempts} attempt{f.attempts === 1 ? '' : 's'}
            </div>
            {f.error && <div className="mt-1 text-xs text-danger">{f.error}</div>}
            {f.retryAt && (
              <div className="mt-1 flex items-center gap-1 text-xs text-muted">
                <TriangleAlert className="h-3 w-3" /> Retrying automatically {timeAgo(f.retryAt)}
              </div>
            )}
          </div>
          {f.kind === 'failed' && (
            <Button
              size="xs"
              icon={<RotateCw />}
              loading={busy === String(f.id)}
              onClick={() =>
                run(
                  String(f.id),
                  async () => {
                    const r = await post<{ status: string; error?: string }>(`/admin/failures/${f.id}/retry`);
                    await invalidate(['admin', 'failures'], ['admin', 'overview']);
                    if (r.status !== 'sent') throw new Error(r.error ?? 'Still failing.');
                  },
                  'Sent',
                )
              }
            >
              Retry now
            </Button>
          )}
        </div>
      ))}
    </Card>
  );
}
