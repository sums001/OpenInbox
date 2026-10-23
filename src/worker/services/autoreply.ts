// Vacation auto-reply, with loop protection: never answer bulk or automated mail, mailer daemons,
// or the same sender more than once in 4 days.
import type { Env } from '../env';
import type { AppSettings } from '../db/settings';
import { first, run } from '../db/db';
import { DAY } from '../lib/time';
import type { AutoReply } from './mailboxes';
import type { ParsedMessage } from './inbound';
import { sendSystemReply } from './send';
import { isValidAddress } from '../mail/address';

const NO_REPLY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|bounces|notifications?)([+.-]|@)/i;

export function shouldAutoReply(reply: AutoReply, p: ParsedMessage, ownAddress: string, now = Date.now()): boolean {
  if (!reply.enabled) return false;
  if (reply.startAt && now < reply.startAt) return false;
  if (reply.endAt && now > reply.endAt) return false;
  if (p.isBulk || p.isAutoSubmitted) return false;
  const to = (p.replyTo ?? p.from).address;
  if (!to || !isValidAddress(to) || NO_REPLY.test(to) || to === ownAddress) return false;
  return true;
}

export async function maybeAutoReply(
  env: Env,
  settings: AppSettings,
  mailbox: { id: number; address: string; displayName: string },
  reply: AutoReply,
  p: ParsedMessage,
  threadId: number,
): Promise<void> {
  if (!shouldAutoReply(reply, p, mailbox.address)) return;
  const to = p.replyTo ?? p.from;
  const recent = await first<{ sent_at: number }>(env.DB, 'SELECT sent_at FROM autoreply_log WHERE mailbox_id = ? AND sender = ?', mailbox.id, to.address);
  if (recent && Date.now() - recent.sent_at < 4 * DAY) return;
  await run(
    env.DB,
    'INSERT INTO autoreply_log (mailbox_id, sender, sent_at) VALUES (?, ?, ?) ON CONFLICT (mailbox_id, sender) DO UPDATE SET sent_at = excluded.sent_at',
    mailbox.id,
    to.address,
    Date.now(),
  );
  await sendSystemReply(env, settings, {
    mailboxId: mailbox.id,
    threadId,
    from: { name: mailbox.displayName, address: mailbox.address },
    to,
    subject: reply.subject?.trim() || `Re: ${p.subject}`,
    text: reply.body,
    inReplyTo: p.messageId,
    references: p.references,
  });
}
