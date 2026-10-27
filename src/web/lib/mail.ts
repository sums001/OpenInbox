// Mail helpers for the web app: views, reply recipients, quoting, sender labels.
import { FOLDERS } from '../../shared/constants';
import { displayName, fullDate } from './format';
import type { Address, Mailbox, Message } from './types';

export type View = (typeof FOLDERS)[number] | 'scheduled' | 'assigned' | `label-${number}` | 'search';

export const VIEW_LABELS: Record<string, string> = {
  inbox: 'Inbox',
  starred: 'Starred',
  snoozed: 'Snoozed',
  sent: 'Sent',
  drafts: 'Drafts',
  scheduled: 'Scheduled',
  archive: 'Archive',
  allmail: 'All mail',
  spam: 'Spam',
  trash: 'Trash',
  assigned: 'Assigned to me',
  search: 'Search',
};

export function viewQuery(view: string): string {
  if (view.startsWith('label-')) return `view=label&label=${view.slice(6)}`;
  return `view=${view}`;
}

export function ownAddresses(mailboxes: Mailbox[]): Set<string> {
  return new Set(mailboxes.flatMap((m) => m.addresses.map((a) => a.address.toLowerCase())));
}

export function participantLabel(list: Address[], own: Set<string>, max = 3): string {
  const people = [...new Map(list.map((a) => [a.address.toLowerCase(), a])).values()];
  // One person: the full name. Several: first names, like most mail clients.
  if (people.length === 1) return own.has(people[0].address.toLowerCase()) ? 'me' : displayName(people[0]);
  const names = people.map((a) => (own.has(a.address.toLowerCase()) ? 'me' : displayName(a).split(' ')[0] || a.address));
  const unique = [...new Set(names.reverse())].reverse();
  if (unique.length <= max) return unique.join(', ');
  return `${unique.slice(0, max - 1).join(', ')} … ${unique[unique.length - 1]}`;
}

// The address a reply should come from: the one the message was delivered to, if it's ours.
export function replyFrom(m: Message, mailbox: Mailbox | undefined): string {
  const own = new Set(mailbox?.addresses.map((a) => a.address.toLowerCase()) ?? []);
  const candidates = [m.deliveredTo, ...m.to.map((a) => a.address), ...m.cc.map((a) => a.address)].filter((x): x is string => !!x);
  if (m.direction === 'out') return m.from.address;
  return candidates.find((c) => own.has(c.toLowerCase())) ?? mailbox?.address ?? '';
}

export function replyRecipients(m: Message, all: boolean, own: Set<string>): { to: Address[]; cc: Address[] } {
  if (m.direction === 'out') return { to: m.to, cc: all ? m.cc : [] };
  const to = [m.replyTo ?? m.from];
  if (!all) return { to, cc: [] };
  const seen = new Set(to.map((a) => a.address.toLowerCase()));
  const cc = [...m.to, ...m.cc].filter((a) => {
    const k = a.address.toLowerCase();
    if (own.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { to, cc };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function quoteHtml(m: Message): string {
  const header = `On ${fullDate(m.sentAt)}, ${esc(displayName(m.from))} &lt;${esc(m.from.address)}&gt; wrote:`;
  const body = m.html ? m.html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '') : `<p>${esc(m.text).replace(/\n/g, '<br>')}</p>`;
  return `<p></p><p>${header}</p><blockquote>${body}</blockquote>`;
}

export function forwardHtml(m: Message): string {
  const line = (k: string, v: string) => `${k}: ${esc(v)}<br>`;
  const list = (a: Address[]) => a.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');
  const body = m.html ? m.html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '') : `<p>${esc(m.text).replace(/\n/g, '<br>')}</p>`;
  return `<p></p><p>---------- Forwarded message ----------<br>${line('From', list([m.from]))}${line('Date', fullDate(m.sentAt))}${line('Subject', m.subject)}${line('To', list(m.to))}${m.cc.length ? line('Cc', list(m.cc)) : ''}</p>${body}`;
}

export function snoozePresets(now = new Date()): { label: string; at: number }[] {
  const at = (d: Date, h: number, m = 0) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x;
  };
  const laterToday = new Date(now.getTime() + 3 * 3_600_000);
  const tomorrow = at(new Date(now.getTime() + 86_400_000), 8);
  const sat = new Date(now);
  sat.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7 || 7));
  const mon = new Date(now);
  mon.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  return [
    { label: 'Later today', at: laterToday.getTime() },
    { label: 'Tomorrow morning', at: tomorrow.getTime() },
    { label: 'This weekend', at: at(sat, 9).getTime() },
    { label: 'Next week', at: at(mon, 8).getTime() },
  ];
}
