import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CircleCheck,
  CircleX,
  Database,
  FileText,
  Gauge as GaugeIcon,
  Globe,
  HardDrive,
  Inbox,
  Mail,
  OctagonAlert,
  PartyPopper,
  Plug,
  RefreshCw,
  Rocket,
  Send,
  TriangleAlert,
  UserPlus,
  UsersRound,
  X,
} from 'lucide-react';
import { get } from '../../lib/api';
import { bytes, num, timeAgo } from '../../lib/format';
import type { CloudflareUsage, Overview } from '../../lib/types';
import { PROVIDER_INFO } from '../../../shared/constants';
import { BarChart, Gauge, Sparkline } from '../../components/charts';
import { Card, CardHeader, EmptyState, IconTile, Meter, PageHeader, PageSpinner, Skeleton, StatusDot } from '../../components/ui/misc';
import { Button } from '../../components/ui/button';
import { cn, storageGet, storageSet } from '../../lib/utils';
import { ActivityRow } from './ActivityPage';
import { useOverview } from './data';

export function OverviewPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const overview = useOverview(true);
  const usage = useQuery({ queryKey: ['admin', 'usage'], queryFn: () => get<CloudflareUsage>('/admin/usage'), staleTime: 5 * 60_000 });
  const [checklistHidden, setChecklistHidden] = useState(() => storageGet('oi.checklist.hidden', false));
  const o = overview.data;
  if (overview.isLoading) return <PageSpinner />;
  if (!o)
    return (
      <Card>
        <EmptyState
          icon={<CircleX />}
          tone="danger"
          title="Could not load the dashboard."
          action={
            <Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => overview.refetch()}>
              Try again
            </Button>
          }
        >
          The Worker answered with an error. Your mail is still being received.
        </EmptyState>
      </Card>
    );

  // The checklist stays until everything is done; once the required steps are, it can be hidden.
  const requiredLeft = o.checklist.some((c) => !c.done && !c.optional);
  const anyLeft = o.checklist.some((c) => !c.done);
  const showChecklist = requiredLeft || (anyLeft && !checklistHidden);
  const series = o.stats.series;
  const p = o.problems;
  const problems = p.unparsed + p.failed + p.domainErrors + p.providerErrors;
  const last14 = series.slice(-14);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Overview"
        description="Everything about your mail server at a glance."
        actions={
          <Button variant="primary" icon={<UserPlus className="h-[15px] w-[15px]" />} onClick={() => navigate('/admin/users?add=1')}>
            Invite people
          </Button>
        }
      />

      {params.get('welcome') && (
        <Card className="flex items-center gap-4 px-5 py-[18px]">
          <IconTile tone="success" size={44}>
            <PartyPopper />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">Welcome aboard!</div>
            <p className="mt-0.5 text-[13px] text-muted text-pretty">Your domain receives mail now. Follow the checklist below to start sending, and invite your team when you're ready.</p>
          </div>
          <button type="button" onClick={() => setParams({}, { replace: true })} className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-fg" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </Card>
      )}

      {o.update.available && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-primary/20 bg-primary-soft py-2.5 pr-3 pl-3.5 text-[13px] text-primary-text">
          <ArrowUpRight className="h-[15px] w-[15px] shrink-0" />
          <span className="min-w-0 flex-1 text-pretty">
            <b className="font-semibold">OpenInbox {o.update.latest} is available.</b> You're on {o.update.current}. Run the "Sync upstream" GitHub Action in your repository to update; Cloudflare redeploys automatically.
          </span>
          {o.update.url && (
            <a href={o.update.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
              Release notes
            </a>
          )}
        </div>
      )}

      {showChecklist && (
        <Checklist
          items={o.checklist}
          onHide={
            requiredLeft
              ? undefined
              : () => {
                  setChecklistHidden(true);
                  storageSet('oi.checklist.hidden', true);
                }
          }
        />
      )}

      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">At a glance</span>
        <span className="text-xs text-faint">Today since 00:00 UTC · updated {timeAgo(overview.dataUpdatedAt)}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile to="/admin/mailflow" icon={<Inbox />} label="Received today" value={o.stats.today.received} sub={`${num(o.stats.week.received)} this week`} spark={last14.map((d) => d.received)} color="var(--primary)" />
        <Tile to="/admin/mailflow" icon={<Send />} label="Sent today" value={o.stats.today.sent} sub={`${num(o.stats.week.sent)} this week`} spark={last14.map((d) => d.sent)} color="var(--lab-teal)" />
        <Tile
          to="/admin/mailflow"
          icon={<OctagonAlert />}
          label="Spam & rejected today"
          value={o.stats.today.spam + o.stats.today.rejected}
          sub={`${num(o.stats.today.spam)} spam · ${num(o.stats.today.rejected)} rejected`}
          spark={last14.map((d) => d.spam + d.rejected)}
          color="var(--lab-amber)"
        />
        <Tile icon={<Mail />} label="Unread" value={o.stats.unread} sub={`${num(o.stats.messages)} messages stored`} />
        <Tile to="/admin/inboxes" icon={<Inbox />} label="Inboxes" value={o.counts.mailboxes} sub={o.counts.aliases ? `${num(o.counts.aliases)} aliases` : 'No aliases'} />
        <Tile to="/admin/users" icon={<UsersRound />} label="Users" value={o.counts.users} sub={`${num(o.counts.providers)} sending ${o.counts.providers === 1 ? 'provider' : 'providers'}`} />
        <Tile to="/admin/domains" icon={<Globe />} label="Domains" value={o.counts.domains} sub={p.domainErrors ? `${p.domainErrors} ${p.domainErrors === 1 ? 'needs' : 'need'} attention` : 'All healthy'} />
        <Tile
          to="/admin/mailflow"
          icon={<TriangleAlert />}
          label="Problems"
          value={problems}
          bad={problems > 0}
          sub={
            problems
              ? [p.failed && `${p.failed} failed`, p.unparsed && `${p.unparsed} unreadable`, p.domainErrors && `${p.domainErrors} domain`, p.providerErrors && `${p.providerErrors} provider`].filter(Boolean).join(' · ')
              : 'All good'
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex-1">
              <div className="text-sm font-semibold">Mail traffic</div>
              <div className="text-[12.5px] text-muted">Last 30 days</div>
            </div>
            <div className="flex gap-3.5 text-xs text-muted">
              {(
                [
                  ['Received', 'var(--primary)'],
                  ['Sent', 'var(--lab-teal)'],
                  ['Spam', 'var(--lab-amber)'],
                ] as const
              ).map(([l, c]) => (
                <span key={l} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-[2px]" style={{ background: c }} />
                  {l}
                </span>
              ))}
            </div>
          </div>
          <div className="px-5 pt-[18px] pb-4">
            <BarChart
              data={series.map((d) => ({ label: new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), received: d.received, sent: d.sent, spam: d.spam }))}
              series={[
                { key: 'received', label: 'Received', color: 'var(--primary)' },
                { key: 'sent', label: 'Sent', color: 'var(--lab-teal)' },
                { key: 'spam', label: 'Spam', color: 'var(--lab-amber)' },
              ]}
            />
          </div>
        </Card>
        <Capacity overview={o} usage={usage.data} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Limits overview={o} usage={usage.data} loading={usage.isLoading} refresh={() => usage.refetch()} refreshing={usage.isFetching} />
        <Card>
          <CardHeader
            icon={<Globe />}
            title="Domains"
            action={
              <Link to="/admin/domains" className="text-[12.5px] font-medium text-primary-text hover:underline">
                Manage
              </Link>
            }
          />
          {o.domains.length === 0 ? (
            <div className="px-5 py-6 text-[13px] text-muted">No domains yet.</div>
          ) : (
            o.domains.map((d) => (
              <div key={d.id} className="flex items-center gap-2.5 border-b border-border px-5 py-3 text-[13px] last:border-b-0">
                <StatusDot tone={d.status === 'active' ? (d.sendingVerified ? 'success' : 'warning') : d.status === 'error' ? 'danger' : 'warning'} />
                <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                <span className="text-right text-[12.5px] text-muted">
                  {d.status === 'active' ? (d.sendingVerified ? 'Receiving and sending' : 'Receiving only') : d.status === 'error' ? 'Needs attention' : "Setup isn't finished"}
                </span>
              </div>
            ))
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          icon={<Activity />}
          title="Recent activity"
          action={
            <Link to="/admin/activity" className="text-[12.5px] font-medium text-primary-text hover:underline">
              View all
            </Link>
          }
        />
        {o.activity.length ? o.activity.map((a) => <ActivityRow key={a.id} entry={a} ip={false} relative />) : <div className="px-5 py-6 text-[13px] text-muted">Nothing yet.</div>}
      </Card>
    </div>
  );
}

function Checklist({ items, onHide }: { items: Overview['checklist']; onHide?: () => void }) {
  const done = items.filter((i) => i.done).length;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3.5 px-5 py-4">
        <IconTile tone="primary" size={34}>
          <Rocket />
        </IconTile>
        <div className="flex-1">
          <div className="text-sm font-semibold">Finish setting up</div>
          <div className="text-[12.5px] text-muted">
            {done} of {items.length} done
          </div>
        </div>
        <Meter value={done} max={items.length} tone="primary" className="w-[180px] max-sm:hidden" />
        {onHide && (
          <button type="button" onClick={onHide} className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-fg" aria-label="Hide the checklist" title="Hide the checklist">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {/* Hairline grid: the gaps show the border color between cells. */}
      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {items.map((i, n) => (
          <Link key={i.id} to={i.href} className="group flex items-start gap-3 bg-surface px-[18px] py-3.5 transition-colors hover:bg-surface-2">
            {i.done ? (
              <CircleCheck className="mt-px h-[18px] w-[18px] shrink-0 text-success" />
            ) : (
              <span className="mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong text-[10px] font-semibold text-faint">{n + 1}</span>
            )}
            <div className="min-w-0 flex-1">
              <div className={cn('text-[13px] font-medium', i.done ? 'text-muted line-through decoration-faint' : 'text-fg')}>{i.label}</div>
              <div className={cn('text-xs', i.done ? 'text-success' : 'text-faint')}>{i.done ? 'Done' : i.optional ? 'Optional' : 'To do'}</div>
            </div>
            {!i.done && <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary-text" />}
          </Link>
        ))}
        {/* Fill the last row so the hairline grid has no empty gray cells. */}
        {Array.from({ length: (3 - (items.length % 3)) % 3 }, (_, k) => (
          <div key={k} className="hidden bg-surface lg:block" />
        ))}
      </div>
    </Card>
  );
}

function Tile({ icon, label, value, sub, spark, color, bad, to }: { icon: ReactNode; label: string; value: number; sub?: string; spark?: number[]; color?: string; bad?: boolean; to?: string }) {
  const body = (
    <>
      <div className="flex items-center gap-[7px] text-[12.5px] text-muted [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:text-faint">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-end gap-2.5">
        <div className="min-w-0 flex-1">
          <div className={cn('text-2xl leading-tight font-semibold tracking-[-0.02em] tabular-nums', bad && 'text-danger')}>{num(value)}</div>
          {sub && <div className="truncate text-xs text-faint">{sub}</div>}
        </div>
        {spark && spark.length > 1 && <Sparkline values={spark} color={color} className="max-sm:hidden" />}
      </div>
    </>
  );
  const cls = cn('flex flex-col gap-0.5 rounded-xl border bg-surface px-4 pt-3.5 pb-3 shadow-card', bad ? 'border-[color-mix(in_oklch,var(--danger)_35%,var(--border))]' : 'border-border');
  return to ? (
    <Link to={to} className={cn(cls, 'transition-colors hover:border-border-strong')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Capacity({ overview: o, usage }: { overview: Overview; usage?: CloudflareUsage }) {
  const navigate = useNavigate();
  const s = o.storage;
  return (
    <Card className="flex flex-col">
      <CardHeader icon={<Database />} title="Database capacity" description="D1 free plan: 500 MB per database" />
      <div className="flex flex-col items-center px-5 pt-5 pb-3">
        <Gauge value={s.d1Bytes ?? 0} max={s.d1Limit} label={`${bytes(s.d1Bytes)} of ${bytes(s.d1Limit)}`} />
        {s.daysUntilFull !== null && <div className="mt-2 text-center text-xs text-faint">About {num(s.daysUntilFull)} days until full at the current rate</div>}
      </div>
      <div className="mt-auto border-t border-border text-[13px]">
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-[11px]">
          <FileText className="h-[15px] w-[15px] text-faint" />
          <span className="flex-1">Raw .eml kept in D1</span>
          <span className="text-muted tabular-nums">{bytes(s.rawBytesInD1)}</span>
        </div>
        <div className="flex items-center gap-2.5 py-[9px] pr-3 pl-5">
          <HardDrive className="h-[15px] w-[15px] text-faint" />
          <span className="min-w-0 flex-1">
            R2 storage (attachments)
            {o.storageMode !== 'r2' && <span className="text-faint"> · Off</span>}
          </span>
          {o.storageMode === 'r2' ? (
            <span className="text-muted tabular-nums">{usage?.r2 ? bytes(usage.r2.storageBytes) : 'On'}</span>
          ) : (
            <Button size="xs" onClick={() => navigate('/admin/integrations#storage')}>
              Enable R2
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function LimitRow({ label, used, limit, sub }: { label: string; used: number; limit: number | null; sub?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <span className="text-[12.5px] text-muted tabular-nums">
          <b className="font-semibold text-fg">{num(used)}</b> / {limit !== null ? num(limit) : 'no cap'}
        </span>
      </div>
      <Meter value={used} max={limit ?? 0} />
      {sub && <div className="truncate text-xs text-faint">{sub}</div>}
    </div>
  );
}

function Limits({ overview: o, usage, loading, refresh, refreshing }: { overview: Overview; usage?: CloudflareUsage; loading: boolean; refresh: () => void; refreshing: boolean }) {
  return (
    <Card>
      <CardHeader
        icon={<GaugeIcon />}
        title="Limits left today"
        description="Free-tier quotas reset at 00:00 UTC."
        action={
          <Button size="xs" variant="ghost" icon={<RefreshCw className={cn(refreshing && 'animate-spin')} />} onClick={refresh}>
            Refresh
          </Button>
        }
      />
      <div className="grid gap-x-7 gap-y-4 px-5 pt-[18px] pb-5 md:grid-cols-2">
        {o.providers.length === 0 && (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Plug className="h-4 w-4 text-faint" />
            No sending provider yet.
            <Link to="/admin/integrations" className="font-medium text-primary-text hover:underline">
              Connect one
            </Link>
          </div>
        )}
        {o.providers.map((p) => (
          <LimitRow
            key={p.id}
            label={`${p.name}${p.isDefault ? ' · default' : ''}`}
            used={p.usedToday}
            limit={p.dailyLimit}
            sub={p.monthlyLimit !== null ? `${num(p.usedMonth)} / ${num(p.monthlyLimit)} this month` : (PROVIDER_INFO[p.type]?.freeTier ?? 'No monthly cap')}
          />
        ))}
        {loading ? (
          <>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </>
        ) : usage?.available ? (
          <>
            {usage.workerRequests && <LimitRow label="Worker requests" used={usage.workerRequests.used} limit={usage.workerRequests.limit} sub={usage.workerRequests.thisApp != null ? `${num(usage.workerRequests.thisApp)} by OpenInbox · Cloudflare free plan` : 'Cloudflare free plan'} />}
            {usage.d1RowsRead && <LimitRow label="D1 rows read" used={usage.d1RowsRead.used} limit={usage.d1RowsRead.limit} sub="Cloudflare free plan" />}
            {usage.d1RowsWritten && <LimitRow label="D1 rows written" used={usage.d1RowsWritten.used} limit={usage.d1RowsWritten.limit} sub="Cloudflare free plan" />}
          </>
        ) : (
          <div className="text-[13px] text-muted">{usage?.reason ?? 'Cloudflare usage is unavailable.'}</div>
        )}
      </div>
    </Card>
  );
}
