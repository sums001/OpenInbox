import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Cloud, RefreshCw, RotateCcw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { get, post } from '../../lib/api';
import { bytes, fullDate, timeAgo } from '../../lib/format';
import { useAction, useInvalidate } from '../../lib/hooks';
import { Button } from '../../components/ui/button';
import { Alert, Badge, Card, EmptyState, PageHeader, PageSpinner, Tabs } from '../../components/ui/misc';

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

const STATUS_TONE = { delivered: 'success', spam: 'warning', duplicate: 'neutral', rejected: 'danger', unparsed: 'warning', error: 'danger' } as const;

export function MailFlowPage() {
  const [tab, setTab] = useState<'inbound' | 'cloudflare' | 'failures'>('inbound');
  const failures = useQuery({ queryKey: ['admin', 'failures'], queryFn: () => get<Failure[]>('/admin/failures') });
  return (
    <div>
      <PageHeader title="Mail flow" description="What happened to recent mail: deliveries, rejections, spam, and sends that need attention." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'inbound', label: 'Inbound log' },
          { value: 'cloudflare', label: 'Cloudflare Email Routing' },
          { value: 'failures', label: 'Problems', count: failures.data?.length },
        ]}
      />
      <div className="pt-5">
        {tab === 'inbound' && <InboundLog />}
        {tab === 'cloudflare' && <CloudflareLog />}
        {tab === 'failures' && <Failures data={failures.data} loading={failures.isLoading} />}
      </div>
    </div>
  );
}

function InboundLog() {
  const [status, setStatus] = useState('');
  const log = useQuery({ queryKey: ['admin', 'mailflow', status], queryFn: () => get<InboundEntry[]>(`/admin/mailflow${status ? `?status=${status}` : ''}`), refetchInterval: 30_000 });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {['', 'delivered', 'spam', 'rejected', 'duplicate', 'unparsed'].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${status === s ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-fg'}`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>
      <Card className="overflow-hidden">
        {log.isLoading ? (
          <PageSpinner />
        ) : !log.data?.length ? (
          <EmptyState title="No mail yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-border bg-surface-2 text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">From</th>
                  <th className="px-4 py-2 font-medium">To</th>
                  <th className="px-4 py-2 font-medium">Subject</th>
                  <th className="px-4 py-2 font-medium">Size</th>
                  <th className="px-4 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {log.data.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2 whitespace-nowrap text-muted" title={fullDate(e.at)}>
                      {timeAgo(e.at)}
                    </td>
                    <td className="max-w-48 truncate px-4 py-2">{e.from || '–'}</td>
                    <td className="max-w-48 truncate px-4 py-2">{e.to}</td>
                    <td className="max-w-64 truncate px-4 py-2 text-muted">{e.subject || '–'}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-muted">{bytes(e.size)}</td>
                    <td className="px-4 py-2">
                      <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
                      {e.reason && <div className="mt-0.5 max-w-64 truncate text-xs text-muted">{e.reason}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function CloudflareLog() {
  const log = useQuery({ queryKey: ['admin', 'mailflow', 'cf'], queryFn: () => get<{ available: boolean; reason?: string; events: CfEvent[] }>('/admin/mailflow/cloudflare') });
  if (log.isLoading) return <PageSpinner />;
  if (!log.data?.available) return <Alert tone="warning">{log.data?.reason ?? 'Unavailable.'}</Alert>;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        <Cloud className="mr-1 inline h-4 w-4" />
        Cloudflare's own log for the last 24 hours, including mail it rejected before OpenInbox saw it. "dropped" is normal: OpenInbox stores the mail instead of forwarding it.
      </p>
      <Card className="overflow-hidden">
        {!log.data.events.length ? (
          <EmptyState title="No events in the last 24 hours" />
        ) : (
          <div className="divide-y divide-border">
            {log.data.events.map((e, i) => (
              <div key={i} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
                <span className="w-20 shrink-0 text-xs text-muted">{timeAgo(Date.parse(e.datetime))}</span>
                <span className="min-w-40 flex-1 truncate">
                  {e.from} → {e.to}
                </span>
                <span className="hidden max-w-56 truncate text-muted md:block">{e.subject}</span>
                <div className="flex gap-1">
                  {(['spf', 'dkim', 'dmarc'] as const).map((k) => (
                    <Badge key={k} tone={e[k] === 'pass' ? 'success' : e[k] === 'none' ? 'neutral' : 'warning'}>
                      {k.toUpperCase()} {e[k]}
                    </Badge>
                  ))}
                </div>
                <Badge tone={e.status === 'delivered' || e.status === 'dropped' ? 'neutral' : 'danger'}>{e.status}</Badge>
                {e.errorDetail && <div className="w-full text-xs text-danger">{e.errorDetail}</div>}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => log.refetch()}>
        Refresh
      </Button>
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
        <EmptyState icon={<CircleCheck className="h-5 w-5 text-success" />} title="No problems">
          Failed sends and unreadable messages show up here.
        </EmptyState>
      </Card>
    );
  return (
    <Card className="divide-y divide-border">
      {data.map((f) => (
        <div key={f.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
          {f.kind === 'failed' ? <CircleX className="mt-0.5 h-4 w-4 text-danger" /> : <ShieldAlert className="mt-0.5 h-4 w-4 text-warning" />}
          <div className="min-w-60 flex-1">
            <div className="text-sm font-medium">{f.subject || '(no subject)'}</div>
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
            <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={busy === String(f.id)} onClick={() => run(String(f.id), async () => {
              const r = await post<{ status: string; error?: string }>(`/admin/failures/${f.id}/retry`);
              await invalidate(['admin', 'failures'], ['admin', 'overview']);
              if (r.status !== 'sent') throw new Error(r.error ?? 'Still failing.');
            }, 'Sent')}>
              Retry now
            </Button>
          )}
        </div>
      ))}
    </Card>
  );
}
