// Background jobs. The minute trigger stays cheap (indexed "is anything due?" queries); slower
// jobs run every 10 minutes or in the daily maintenance trigger.
import type { Env } from './env';
import { loadSettings } from './db/settings';
import { all } from './db/db';
import { processQueue } from './services/send';
import { wakeSnoozed } from './services/threads';
import { retryUnparsed } from './services/inbound';
import { reparseQueued } from './services/reparse';
import { refreshPendingDomains, upgradeWebhooks } from './services/providers';
import { importProviderSent } from './services/provider-sent';
import { cleanup, purgeOldTrash } from './services/retention';
import { checkDomainHealth } from './services/domains';
import { checkForUpdate } from './services/updates';
import { logError } from './lib/log';
import { refreshSenderLogos } from './services/sender-logos';

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
  // Mail other apps sent through a provider: up to 5 requests for the content.
  await safely('provider-sent', () => importProviderSent(env));
  const minute = new Date(controller.scheduledTime).getUTCMinutes();
  if (minute % 10 === 0) {
    await safely('unparsed', () => retryUnparsed(env));
    await safely('reparse', () => reparseQueued(env));
    await safely('domains', () => refreshPendingDomains(env));
    await safely('webhooks', () => upgradeWebhooks(env, settings));
  }
  // Up to 25 lookups, so on their own minute: they don't share the free plan's 50 subrequests
  // per invocation with the 10-minute jobs above.
  if (minute % 10 === 5 && settings.senderLogos === 'on') await safely('sender-logos', () => refreshSenderLogos(env));
}
