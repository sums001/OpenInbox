// Background jobs. The minute trigger stays cheap (indexed "is anything due?" queries); slower
// jobs run every 10 minutes or in the daily maintenance trigger.
import type { Env } from './env';
import { loadSettings } from './db/settings';
import { all } from './db/db';
import { processQueue } from './services/send';
import { wakeSnoozed } from './services/threads';
import { retryUnparsed } from './services/inbound';
import { refreshPendingDomains } from './services/providers';
import { cleanup, purgeOldTrash } from './services/retention';
import { checkDomainHealth } from './services/domains';
import { checkForUpdate } from './services/updates';
import { logError } from './lib/log';

async function safely(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logError(`cron.${name}`, e);
  }
}

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const settings = await loadSettings(env.DB);
  if (!settings.setupCompletedAt) return;
  if (controller.cron === '17 3 * * *') {
    await safely('purge', () => purgeOldTrash(env));
    await safely('cleanup', () => cleanup(env));
    await safely('updates', () => checkForUpdate(env, true));
    const domains = await all<{ id: number }>(env.DB, "SELECT id FROM domains WHERE status != 'disabled' LIMIT 5");
    for (const d of domains) await safely('health', () => checkDomainHealth(env, settings, d.id));
    return;
  }
  await safely('queue', () => processQueue(env));
  await safely('snooze', () => wakeSnoozed(env.DB));
  const minute = new Date(controller.scheduledTime).getUTCMinutes();
  if (minute % 10 === 0) {
    await safely('unparsed', () => retryUnparsed(env));
    await safely('domains', () => refreshPendingDomains(env));
  }
}
