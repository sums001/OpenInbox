import { useInfiniteQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { fullDate, timeAgo } from '../../lib/format';
import { Button } from '../../components/ui/button';
import { Card, EmptyState, PageHeader, PageSpinner } from '../../components/ui/misc';

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

export function ActivityPage() {
  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit'],
    queryFn: ({ pageParam }) => get<AuditEntry[]>(`/admin/audit${pageParam ? `?before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].at : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  return (
    <div>
      <PageHeader title="Activity" description="Sign-ins and changes to users, inboxes, domains, credentials and settings." />
      <Card className="overflow-hidden">
        {q.isLoading ? (
          <PageSpinner />
        ) : !rows.length ? (
          <EmptyState title="No activity yet" />
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-[13px]">
                <span className="w-24 shrink-0 text-xs text-muted" title={fullDate(r.at)}>
                  {timeAgo(r.at)}
                </span>
                <span className="font-medium">{r.by ?? 'System'}</span>
                <span className="text-muted">{actionLabel(r.action)}</span>
                {r.target && <span className="truncate">{r.target}</span>}
                <span className="ml-auto text-xs text-faint">{r.ip}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
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
