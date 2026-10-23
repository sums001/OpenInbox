// OpenInbox Worker entry points: the API (fetch), inbound mail from Email Routing (email), and
// background jobs (scheduled).
import type { Env } from './env';
import { app } from './app';
import { handleEmail } from './services/inbound';
import { handleScheduled } from './cron';
import { logError } from './lib/log';

export default {
  fetch: app.fetch,

  async email(message, env, ctx) {
    try {
      await handleEmail(message, env, ctx);
    } catch (e) {
      // Rethrowing makes Email Routing answer with a temporary failure, so the sending server
      // retries later instead of the message being lost.
      logError('inbound.failed', e, { to: message.to, size: message.rawSize });
      throw e;
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;
