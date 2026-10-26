import type { ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Activity, AtSign, Forward, Globe, HardDrive, Inbox, Key, KeyRound, LogIn, Plug, Rocket, Settings, ShieldCheck, Trash2, UserPlus, UserRound } from 'lucide-react';
import { get } from '../../lib/api';
import { fullDate, timeAgo } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Avatar, Card, EmptyState, PageHeader, PageSpinner } from '../../components/ui/misc';

interface AuditEntry {
  id: number;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  at: number;
  by: string | null;
}

const LABELS: Record<string, string> = {
  'setup.claimed': 'Claimed this instance',
  'auth.login': 'Signed in',
  'auth.owner_recovered': 'Recovered the owner account',
  'account.password_changed': 'Changed their password',
  'account.2fa_enabled': 'Turned on two-factor',
  'account.2fa_disabled': 'Turned off two-factor',
  'account.sessions_revoked': 'Signed out other sessions',
  'user.created': 'Added a user',
  'user.updated': 'Updated a user',
  'user.deleted': 'Deleted a user',
  'user.password_reset': 'Reset a password',
  'user.2fa_reset': 'Reset two-factor',
  'mailbox.created': 'Created an inbox',
  'mailbox.deleted': 'Deleted an inbox',
  'mailbox.members_changed': 'Changed inbox members',
  'alias.created': 'Added an alias',
  'domain.added': 'Added a domain',
  'domain.removed': 'Removed a domain',
  'domain.app_domain': 'Attached the app to a domain',
  'provider.connected': 'Connected a sending provider',
  'provider.removed': 'Removed a sending provider',
  'cloudflare.token_replaced': 'Replaced the Cloudflare token',
  'storage.r2_enabled': 'Turned on attachments (R2)',
  'storage.mode': 'Changed the storage mode',
  'settings.updated': 'Changed settings',
  'crypto.reencrypted': 'Re-encrypted stored secrets',
  'forwarding.added': 'Added a forwarding address',
};

export function actionLabel(action: string): string {
  return LABELS[action] ?? action;
}

// "Maya Chen added a user": the label reads as a sentence after the name.
export function actionPhrase(action: string): string {
  const l = actionLabel(action);
  return LABELS[action] ? l[0].toLowerCase() + l.slice(1) : l;
}

const ICONS: Record<string, ReactNode> = {
  setup: <Rocket />,
  auth: <LogIn />,
  account: <ShieldCheck />,
  user: <UserRound />,
  mailbox: <Inbox />,
  alias: <AtSign />,
  domain: <Globe />,
  provider: <Plug />,
  cloudflare: <KeyRound />,
  storage: <HardDrive />,
  settings: <Settings />,
  crypto: <Key />,
  forwarding: <Forward />,
};

// Green for additions, red for removals, indigo for sign-in and security, grey for changes.
function actionTile(action: string): { icon: ReactNode; cls: string } {
  const [area] = action.split('.');
  if (/deleted|removed|disabled/.test(action)) return { icon: <Trash2 />, cls: 'bg-danger-soft text-danger' };
  if (/created|added|connected|enabled|claimed/.test(action)) return { icon: action === 'user.created' ? <UserPlus /> : (ICONS[area] ?? <Activity />), cls: 'bg-success-soft text-success' };
  if (area === 'auth' || area === 'account' || /2fa|password/.test(action)) return { icon: ICONS[area] ?? <ShieldCheck />, cls: 'bg-primary-soft text-primary-text' };
  return { icon: ICONS[area] ?? <Activity />, cls: 'bg-surface-2 text-muted' };
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function ActivityRow({ entry: r, ip = true, relative }: { entry: Pick<AuditEntry, 'action' | 'target' | 'at' | 'by'> & { ip?: string | null }; ip?: boolean; relative?: boolean }) {
  const tile = actionTile(r.action);
  return (
    <div className={cn('grid min-h-[50px] items-center gap-3 border-b border-border px-5 py-2 text-[13px] last:border-b-0', ip ? 'grid-cols-[28px_26px_minmax(0,1fr)_auto] md:grid-cols-[28px_26px_minmax(0,1fr)_130px_70px]' : 'grid-cols-[28px_26px_minmax(0,1fr)_auto]')}>
      <Avatar name={r.by ?? 'System'} address={r.by ?? 'system'} size={28} />
      <span className={cn('grid h-[26px] w-[26px] place-items-center rounded-[7px] [&>svg]:h-[13px] [&>svg]:w-[13px]', tile.cls)}>{tile.icon}</span>
      <span className="min-w-0 truncate">
        <b className="font-semibold">{r.by ?? 'System'}</b> <span className="text-muted">{actionPhrase(r.action)}</span> {r.target && <span className="font-medium">{r.target}</span>}
      </span>
      {ip && <span className="hidden truncate font-mono text-[11.5px] text-faint md:block">{r.ip}</span>}
      <span className="text-right text-xs text-faint tabular-nums" title={fullDate(r.at)}>
        {relative ? timeAgo(r.at) : new Date(r.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
      </span>
    </div>
  );
}

export function ActivityPage() {
  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit'],
    queryFn: ({ pageParam }) => get<AuditEntry[]>(`/admin/audit${pageParam ? `?before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].at : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  const days: { day: string; items: AuditEntry[] }[] = [];
  for (const r of rows) {
    const day = dayLabel(r.at);
    if (days[days.length - 1]?.day === day) days[days.length - 1].items.push(r);
    else days.push({ day, items: [r] });
  }
  return (
    <div>
      <PageHeader title="Activity" description="Sign-ins and changes to users, inboxes, domains, credentials and settings." />
      {q.isLoading ? (
        <PageSpinner />
      ) : !rows.length ? (
        <Card>
          <EmptyState icon={<Activity />} title="No activity yet">
            Sign-ins and changes to users, inboxes, domains and settings are listed here.
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {days.map((d) => (
            <div key={d.day} className="flex flex-col gap-2">
              <div className="pl-0.5 text-xs font-medium text-faint">{d.day}</div>
              <Card className="overflow-hidden">
                {d.items.map((r) => (
                  <ActivityRow key={r.id} entry={r} />
                ))}
              </Card>
            </div>
          ))}
        </div>
      )}
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
