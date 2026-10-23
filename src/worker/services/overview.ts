// The admin dashboard's overview: mail stats, setup checklist, problems and recent activity.
// Everything here reads counters and small tables, never the messages table in bulk.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { all, first } from '../db/db';
import { dayKey, DAY } from '../lib/time';
import { parseJson } from '../lib/json';
import { allQuotaUse } from './quota';

export async function overview(env: Env, settings: AppSettings) {
  const db = env.DB;
  const since = dayKey(Date.now() - 29 * DAY);
  const [daily, counts, unread, problems, domains, providers, audit, quota, recentInbound] = await Promise.all([
    all<{ day: string; received: number; sent: number; spam: number; rejected: number }>(
      db,
      'SELECT day, SUM(received) AS received, SUM(sent) AS sent, SUM(spam) AS spam, SUM(rejected) AS rejected FROM daily_stats WHERE day >= ? GROUP BY day ORDER BY day',
      since,
    ),
    first<{ users: number; mailboxes: number; aliases: number; domains: number; providers: number; members: number; messages: number }>(
      db,
      `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM mailboxes) AS mailboxes,
              (SELECT COUNT(*) FROM addresses WHERE is_primary = 0) AS aliases, (SELECT COUNT(*) FROM domains) AS domains,
              (SELECT COUNT(*) FROM providers) AS providers, (SELECT COUNT(*) FROM users WHERE role = 'member') AS members,
              (SELECT value FROM counters WHERE key = 'messages') AS messages`,
    ),
    first<{ n: number | null }>(db, "SELECT SUM(unread_count) AS n FROM threads WHERE folder = 'inbox' AND unread_count > 0"),
    first<{ unparsed: number; failed: number; scheduled: number }>(
      db,
      "SELECT SUM(status = 'unparsed') AS unparsed, SUM(status = 'failed') AS failed, SUM(status = 'scheduled') AS scheduled FROM messages WHERE status IN ('unparsed', 'failed', 'scheduled')",
    ),
    all<{ id: number; name: string; status: string; health: string; app_hostname: string | null; catch_all_mailbox_id: number | null }>(
      db,
      'SELECT id, name, status, health, app_hostname, catch_all_mailbox_id FROM domains ORDER BY name',
    ),
    all<{ id: number; type: string; name: string; status: string; daily_limit: number | null; monthly_limit: number | null; is_default: number; last_error: string | null }>(
      db,
      'SELECT id, type, name, status, daily_limit, monthly_limit, is_default, last_error FROM providers ORDER BY is_default DESC, priority',
    ),
    all<{ id: number; action: string; target: string | null; created_at: number; name: string | null }>(
      db,
      'SELECT a.id, a.action, a.target, a.created_at, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 8',
    ),
    allQuotaUse(db),
    all<{ id: number; received_at: number; mail_from: string; rcpt_to: string; subject: string; status: string }>(
      db,
      'SELECT id, received_at, mail_from, rcpt_to, subject, status FROM inbound_log ORDER BY received_at DESC LIMIT 6',
    ),
  ]);
  const verified = await all<{ domain_id: number }>(db, "SELECT DISTINCT domain_id FROM provider_domains WHERE status = 'verified'");
  const verifiedIds = new Set(verified.map((v) => v.domain_id));

  // Fill missing days so charts have a continuous axis.
  const series: { day: string; received: number; sent: number; spam: number; rejected: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = dayKey(Date.now() - i * DAY);
    const row = daily.find((d) => d.day === day);
    series.push({ day, received: row?.received ?? 0, sent: row?.sent ?? 0, spam: row?.spam ?? 0, rejected: row?.rejected ?? 0 });
  }
  const sum = (days: number, key: 'received' | 'sent' | 'spam' | 'rejected') => series.slice(-days).reduce((n, d) => n + d[key], 0);

  const hasProvider = providers.length > 0;
  const checklist = [
    { id: 'domain', label: 'Receive mail on your domain', done: domains.some((d) => d.status === 'active'), href: '/admin/domains' },
    { id: 'provider', label: 'Connect a sending provider', done: hasProvider, href: '/admin/integrations' },
    { id: 'sending', label: 'Verify your domain for sending', done: domains.some((d) => verifiedIds.has(d.id)) || providers.some((p) => p.type === 'smtp'), href: '/admin/domains' },
    { id: 'users', label: 'Add your team or more inboxes', done: (counts?.mailboxes ?? 0) > 1 || (counts?.users ?? 0) > 1, href: '/admin/users', optional: true },
    { id: 'attachments', label: 'Enable attachments (R2)', done: settings.storageMode === 'r2', href: '/admin/integrations#storage', optional: true },
    { id: 'appdomain', label: 'Open the app on mail.yourdomain', done: domains.some((d) => !!d.app_hostname), href: '/admin/domains', optional: true },
  ];

  return {
    instanceName: settings.instanceName,
    stats: {
      today: { received: sum(1, 'received'), sent: sum(1, 'sent'), spam: sum(1, 'spam'), rejected: sum(1, 'rejected') },
      week: { received: sum(7, 'received'), sent: sum(7, 'sent'), spam: sum(7, 'spam'), rejected: sum(7, 'rejected') },
      month: { received: sum(30, 'received'), sent: sum(30, 'sent'), spam: sum(30, 'spam'), rejected: sum(30, 'rejected') },
      series,
      unread: unread?.n ?? 0,
      messages: counts?.messages ?? 0,
    },
    counts: {
      users: counts?.users ?? 0,
      mailboxes: counts?.mailboxes ?? 0,
      aliases: counts?.aliases ?? 0,
      domains: counts?.domains ?? 0,
      providers: counts?.providers ?? 0,
    },
    problems: {
      unparsed: problems?.unparsed ?? 0,
      failed: problems?.failed ?? 0,
      scheduled: problems?.scheduled ?? 0,
      domainErrors: domains.filter((d) => d.status === 'error').length,
      providerErrors: providers.filter((p) => p.status === 'error').length,
    },
    domains: domains.map((d) => {
      const h = parseJson<{ items?: { key: string; status: string }[] }>(d.health, {});
      return {
        id: d.id,
        name: d.name,
        status: d.status,
        sendingVerified: verifiedIds.has(d.id),
        appHostname: d.app_hostname,
        catchAll: !!d.catch_all_mailbox_id,
        health: (h.items ?? []).map((i) => ({ key: i.key, status: i.status })),
      };
    }),
    providers: providers.map((p) => {
      const u = quota.get(p.id) ?? { today: 0, month: 0 };
      return {
        id: p.id,
        type: p.type,
        name: p.name,
        status: p.status,
        isDefault: !!p.is_default,
        lastError: p.last_error,
        dailyLimit: p.daily_limit,
        monthlyLimit: p.monthly_limit,
        usedToday: u.today,
        usedMonth: u.month,
      };
    }),
    checklist,
    activity: audit.map((a) => ({ id: a.id, action: a.action, target: a.target, at: a.created_at, by: a.name })),
    recentInbound: recentInbound.map((r) => ({ id: r.id, at: r.received_at, from: r.mail_from, to: r.rcpt_to, subject: r.subject, status: r.status })),
    storageMode: settings.storageMode,
  };
}
