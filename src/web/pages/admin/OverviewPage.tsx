import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  ArrowUpRight,
  Check,
  CircleCheck,
  Cloud,
  Database,
  Globe,
  Inbox,
  MailOpen,
  RefreshCw,
  Rocket,
  Send,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  UsersRound,
  Zap,
} from 'lucide-react';
import { get } from '../../lib/api';
import { bytes, num, pct, timeAgo } from '../../lib/format';
import type { CloudflareUsage, Overview } from '../../lib/types';
import { PROVIDER_INFO } from '../../../shared/constants';
import { BarChart, Gauge, Sparkline } from '../../components/charts';
import { Alert, Badge, Card, CardHeader, Meter, PageHeader, PageSpinner, Skeleton, StatusDot } from '../../components/ui/misc';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import { actionLabel } from './ActivityPage';

export function OverviewPage() {
  const [params] = useSearchParams();
  const overview = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => get<Overview>('/admin/overview'), refetchInterval: 60_000 });
  const usage = useQuery({ queryKey: ['admin', 'usage'], queryFn: () => get<CloudflareUsage>('/admin/usage'), staleTime: 5 * 60_000 });
  const o = overview.data;
  if (overview.isLoading) return <PageSpinner />;
  if (!o) return <Alert tone="danger">Could not load the dashboard.</Alert>;

  const pending = o.checklist.filter((c) => !c.done && !c.optional);
  const series = o.stats.series;
  const problems = o.problems.unparsed + o.problems.failed + o.problems.domainErrors + o.problems.providerErrors;

  return (
    <div className="space-y-6">
      <PageHeader title={o.instanceName} description="Everything about your mail server at a glance." actions={<Badge tone={o.storageMode === 'r2' ? 'primary' : 'neutral'}>{o.storageMode === 'r2' ? 'Attachments on (R2)' : 'Text-only mode'}</Badge>} />

      {params.get('welcome') && (
        <div className="flex gap-4 rounded-xl border border-primary/20 bg-primary-soft p-5">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <div className="font-semibold text-fg">Welcome aboard!</div>
            <p className="mt-0.5 text-[13px] text-muted">Your domain receives mail now. Follow the checklist below to start sending, and invite your team when you're ready.</p>
          </div>
        </div>
      )}

      {o.update.available && (
        <Alert
          tone="primary"
          title={`OpenInbox ${o.update.latest} is available`}
          action={
            o.update.url && (
              <a href={o.update.url} target="_blank" rel="noreferrer" className="text-[13px] font-medium underline">
                Release notes
              </a>
            )
          }
        >
          You're on {o.update.current}. Run the "Sync upstream" GitHub Action in your repository to update; Cloudflare redeploys automatically.
        </Alert>
      )}

      {pending.length > 0 && <Checklist items={o.checklist} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Inbox />} label="Received today" value={o.stats.today.received} sub={`${num(o.stats.week.received)} this week`} spark={series.slice(-14).map((d) => d.received)} />
        <StatCard icon={<Send />} label="Sent today" value={o.stats.today.sent} sub={`${num(o.stats.week.sent)} this week`} spark={series.slice(-14).map((d) => d.sent)} color="var(--success)" />
        <StatCard icon={<MailOpen />} label="Unread" value={o.stats.unread} sub={`${num(o.stats.messages)} messages stored`} />
        <StatCard
          icon={<ShieldAlert />}
          label="Spam & rejected today"
          value={o.stats.today.spam + o.stats.today.rejected}
          sub={`${num(o.stats.month.spam)} spam · ${num(o.stats.month.rejected)} rejected (30 days)`}
          spark={series.slice(-14).map((d) => d.spam + d.rejected)}
          color="var(--warning)"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Mail traffic" description="Last 30 days" />
          <div className="px-5 pt-6 pb-4">
            <BarChart
              data={series.map((d) => ({ label: new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), received: d.received, sent: d.sent, spam: d.spam }))}
              series={[
                { key: 'received', label: 'Received', color: 'var(--primary)' },
                { key: 'sent', label: 'Sent', color: 'var(--success)' },
                { key: 'spam', label: 'Spam', color: 'var(--warning)' },
              ]}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="At a glance" />
          <div className="divide-y divide-border">
            <GlanceRow icon={<UsersRound />} label="Users" value={o.counts.users} to="/admin/users" />
            <GlanceRow icon={<Inbox />} label="Inboxes" value={o.counts.mailboxes} sub={o.counts.aliases ? `${o.counts.aliases} aliases` : undefined} to="/admin/inboxes" />
            <GlanceRow icon={<Globe />} label="Domains" value={o.counts.domains} to="/admin/domains" />
            <GlanceRow icon={<Zap />} label="Sending providers" value={o.counts.providers} to="/admin/integrations" />
            <GlanceRow
              icon={problems ? <TriangleAlert className="text-warning" /> : <CircleCheck className="text-success" />}
              label="Problems"
              value={problems}
              sub={problems ? [o.problems.failed && `${o.problems.failed} failed sends`, o.problems.unparsed && `${o.problems.unparsed} unreadable`, o.problems.domainErrors && `${o.problems.domainErrors} domain issues`].filter(Boolean).join(' · ') : 'All good'}
              to="/admin/mailflow"
            />
          </div>
        </Card>
      </div>

      <LimitsSection overview={o} usage={usage.data} loading={usage.isLoading} refresh={() => usage.refetch()} refreshing={usage.isFetching} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Domains" action={<Link to="/admin/domains" className="text-[13px] text-primary hover:underline">Manage</Link>} />
          {o.domains.length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted">No domains yet.</div>
          ) : (
            <div className="divide-y divide-border">
              {o.domains.map((d) => (
                <div key={d.id} className="flex items-center gap-3 px-5 py-3">
                  <StatusDot tone={d.status === 'active' ? 'success' : d.status === 'error' ? 'danger' : 'warning'} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{d.name}</div>
                    <div className="text-xs text-muted">
                      {d.status === 'active' ? 'Receiving' : d.status === 'error' ? 'Needs attention' : 'Setup pending'} · {d.sendingVerified ? 'sending verified' : 'sending not set up'}
                      {d.catchAll ? ' · catch-all on' : ''}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {d.health.map((h) => (
                      <span key={h.key} title={h.key} className={cn('h-2 w-2 rounded-full', h.status === 'ok' ? 'bg-success' : h.status === 'warn' ? 'bg-warning' : 'bg-danger')} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent activity" action={<Link to="/admin/activity" className="text-[13px] text-primary hover:underline">View all</Link>} />
          <div className="divide-y divide-border">
            {o.recentInbound.slice(0, 3).map((r) => (
              <div key={`in-${r.id}`} className="flex items-center gap-3 px-5 py-2.5">
                <Inbox className="h-4 w-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1 truncate text-[13px]">
                  <span className="text-muted">{r.status === 'rejected' ? 'Rejected' : r.status === 'spam' ? 'Spam' : 'Mail'} from </span>
                  {r.from || 'unknown'} <span className="text-muted">to</span> {r.to}
                </div>
                <span className="shrink-0 text-xs text-faint">{timeAgo(r.at)}</span>
              </div>
            ))}
            {o.activity.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-5 py-2.5">
                <Check className="h-4 w-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1 truncate text-[13px]">
                  {actionLabel(a.action)} {a.target && <span className="text-muted">· {a.target}</span>}
                </div>
                <span className="shrink-0 text-xs text-faint">{timeAgo(a.at)}</span>
              </div>
            ))}
            {!o.activity.length && !o.recentInbound.length && <div className="px-5 py-6 text-sm text-muted">Nothing yet.</div>}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Checklist({ items }: { items: Overview['checklist'] }) {
  const done = items.filter((i) => i.done).length;
  return (
    <Card>
      <CardHeader icon={<Rocket className="h-5 w-5 text-primary" />} title="Finish setting up" description={`${done} of ${items.length} done`} />
      <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
        {items.map((i) => (
          <Link key={i.id} to={i.href} className="flex items-center gap-3 bg-surface px-5 py-3.5 transition-colors hover:bg-surface-2">
            <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border', i.done ? 'border-success bg-success text-white' : 'border-border-strong')}>{i.done && <Check className="h-3 w-3" />}</span>
            <span className={cn('flex-1 text-[13px]', i.done ? 'text-muted line-through' : 'font-medium')}>{i.label}</span>
            {i.optional && !i.done && <span className="text-[11px] text-faint">optional</span>}
            {!i.done && <ArrowUpRight className="h-3.5 w-3.5 text-faint" />}
          </Link>
        ))}
      </div>
    </Card>
  );
}

function StatCard({ icon, label, value, sub, spark, color }: { icon: React.ReactNode; label: string; value: number; sub?: string; spark?: number[]; color?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-[13px] text-muted [&>svg]:h-4 [&>svg]:w-4">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{num(value)}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
      {spark && <Sparkline values={spark} className="mt-3" color={color} />}
    </Card>
  );
}

function GlanceRow({ icon, label, value, sub, to }: { icon: React.ReactNode; label: string; value: number; sub?: string; to: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-2">
      <span className="text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {sub && <div className="truncate text-xs text-muted">{sub}</div>}
      </div>
      <span className="text-sm font-semibold">{num(value)}</span>
    </Link>
  );
}

function LimitRow({ label, used, limit, detail }: { label: string; used: number; limit: number | null; detail?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="text-muted">
          {limit !== null ? (
            <>
              <span className="font-medium text-fg">{num(Math.max(0, limit - used))}</span> left of {num(limit)}
            </>
          ) : (
            `${num(used)} used · no cap`
          )}
        </span>
      </div>
      {limit !== null && <Meter value={used} max={limit} />}
      {detail && <div className="text-xs text-faint">{detail}</div>}
    </div>
  );
}

function LimitsSection({ overview: o, usage, loading, refresh, refreshing }: { overview: Overview; usage?: CloudflareUsage; loading: boolean; refresh: () => void; refreshing: boolean }) {
  const s = o.storage;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader
          title="Limits left today"
          description="Free-tier quotas reset at 00:00 UTC. Sending caps are your providers' free plans unless you changed them."
          action={
            <Button size="xs" variant="ghost" icon={<RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />} onClick={refresh}>
              Refresh
            </Button>
          }
        />
        <div className="grid gap-6 p-5 md:grid-cols-2">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-faint">
              <Send className="h-3.5 w-3.5" /> Sending
            </div>
            {o.providers.length === 0 && (
              <div className="text-[13px] text-muted">
                No sending provider yet. <Link to="/admin/integrations" className="text-primary hover:underline">Connect one</Link>.
              </div>
            )}
            {o.providers.map((p) => (
              <div key={p.id} className="space-y-3">
                <LimitRow label={`${p.name}${p.isDefault ? ' (default)' : ''}`} used={p.usedToday} limit={p.dailyLimit} detail={PROVIDER_INFO[p.type]?.freeTier} />
                {p.monthlyLimit !== null && <LimitRow label="This month" used={p.usedMonth} limit={p.monthlyLimit} />}
              </div>
            ))}
          </div>
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-faint">
              <Cloud className="h-3.5 w-3.5" /> Cloudflare (whole account)
            </div>
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : usage?.available ? (
              <>
                {usage.workerRequests && <LimitRow label="Worker requests" used={usage.workerRequests.used} limit={usage.workerRequests.limit} detail={usage.workerRequests.thisApp != null ? `${num(usage.workerRequests.thisApp)} by OpenInbox` : undefined} />}
                {usage.d1RowsRead && <LimitRow label="D1 rows read" used={usage.d1RowsRead.used} limit={usage.d1RowsRead.limit} />}
                {usage.d1RowsWritten && <LimitRow label="D1 rows written" used={usage.d1RowsWritten.used} limit={usage.d1RowsWritten.limit} />}
              </>
            ) : (
              <div className="text-[13px] text-muted">{usage?.reason ?? 'Usage unavailable.'}</div>
            )}
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Database capacity" description="D1 free plan: 500 MB per database" icon={<Database className="h-5 w-5" />} />
        <div className="flex flex-col items-center gap-4 p-5">
          <Gauge value={s.d1Bytes ?? 0} max={s.d1Limit} label={`${bytes(s.d1Bytes)} of ${bytes(s.d1Limit)}`} sub={s.daysUntilFull !== null ? `About ${num(s.daysUntilFull)} days until full at the current rate` : `${num(s.messages)} messages stored`} />
          <div className="w-full space-y-2 text-[13px]">
            <div className="flex justify-between">
              <span className="text-muted">Raw .eml kept in D1</span>
              <span>{bytes(s.rawBytesInD1)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Used</span>
              <span>{pct(s.d1Bytes ?? 0, s.d1Limit)}%</span>
            </div>
            {usage?.r2 && (
              <div className="space-y-1.5 border-t border-border pt-3">
                <LimitRow label="R2 storage (attachments)" used={usage.r2.storageBytes} limit={usage.r2.limitBytes} detail={`${bytes(usage.r2.storageBytes)} · ${num(usage.r2.objects)} objects`} />
              </div>
            )}
            {o.storageMode === 'text' && (
              <div className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
                Attachments are listed but not stored in text-only mode. <Link to="/admin/integrations#storage" className="text-primary hover:underline">Enable R2</Link> to keep them.
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
