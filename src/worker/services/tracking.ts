// Open and click tracking of mail people send, from the web app or the Inbox API (not system mail
// such as auto-replies), when an admin turns it on for the instance: applied to the copy that is sent (the stored body stays as written), and
// recorded by the public /api/t endpoints.
import type { AppSettings } from '../db/settings';
import { all, first, placeholders } from '../db/db';
import { randomToken } from '../lib/crypto';
import { newId } from '../lib/ids';
import { parseJson } from '../lib/json';
import { textToHtml } from '../mail/html';
import { applyTracking, classifyHit, summarize, type EventCount, type HitSource, type TrackingSummary } from '../mail/tracking';

// Per message, so a link hammered by a bot can't fill the database.
const MAX_EVENTS = 300;

interface TrackedRow {
  message_id: number | null; // null once the message was deleted: links still redirect
  token: string;
  links: string;
  sent_at: number | null;
  events: number;
}

// The HTML to send with the pixel and redirected links, or null without an app URL to point them
// at. A plain-text message gets an HTML part, since a pixel and links need one. A retried message
// keeps its token.
export async function trackedHtml(db: D1Database, settings: AppSettings, messageId: number, body: { text: string; html: string | null }, now: number): Promise<string | null> {
  if (!settings.appUrl) return null;
  await db.prepare('INSERT INTO tracked_messages (message_id, token) VALUES (?, ?) ON CONFLICT (message_id) DO NOTHING').bind(messageId, randomToken(18)).run();
  const t = await first<TrackedRow>(db, 'SELECT * FROM tracked_messages WHERE message_id = ?', messageId);
  if (!t) return null;
  const { html, links } = await applyTracking(body.html || textToHtml(body.text), { base: settings.appUrl.replace(/\/$/, ''), token: t.token });
  await db.prepare('UPDATE tracked_messages SET links = ?, sent_at = ? WHERE message_id = ?').bind(JSON.stringify(links), now, messageId).run();
  return html;
}

export interface Hit {
  method: string;
  userAgent: string;
  ip: string | null;
  country: string | null;
  org: string;
}

// Looks up a hit on a public tracking URL: null for an unknown token or link, else the link's URL
// (for a click) and a function that records the event, to run after the response. A hit costs one
// indexed row read, plus two writes until the message's cap is reached.
export async function lookupHit(db: D1Database, token: string, kind: 'open' | 'click', link: number | null): Promise<{ url: string | null; record: (hit: Hit) => Promise<void> } | null> {
  const t = await first<TrackedRow>(db, 'SELECT * FROM tracked_messages WHERE token = ?', token);
  if (!t) return null;
  const url = kind === 'click' ? (parseJson<string[]>(t.links, [])[link ?? -1] ?? null) : null;
  if (kind === 'click' && !url) return null;
  const now = Date.now();
  const record = async (hit: Hit) => {
    if (t.message_id === null || t.events >= MAX_EVENTS) return;
    const claimed = await db.prepare('UPDATE tracked_messages SET events = events + 1 WHERE token = ? AND events < ?').bind(token, MAX_EVENTS).run();
    if (!claimed.meta.changes) return;
    const source: HitSource = classifyHit({ kind, method: hit.method, userAgent: hit.userAgent, org: hit.org, msSinceSent: t.sent_at ? now - t.sent_at : null });
    await db
      .prepare('INSERT INTO tracking_events (id, message_id, kind, link, source, ip, user_agent, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(newId(), t.message_id, kind, link, source, hit.ip, hit.userAgent.slice(0, 300), hit.country, now)
      .run();
  };
  return { url, record };
}

export async function trackingSummaries(db: D1Database, messageIds: number[]): Promise<Map<number, TrackingSummary>> {
  const out = new Map<number, TrackingSummary>();
  if (!messageIds.length) return out;
  const tracked = await all<TrackedRow>(db, `SELECT * FROM tracked_messages WHERE message_id IN (${placeholders(messageIds.length)})`, ...messageIds);
  if (!tracked.length) return out;
  const counts = await all<EventCount & { message_id: number }>(
    db,
    `SELECT message_id, kind, source, link, COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last
       FROM tracking_events WHERE message_id IN (${placeholders(tracked.length)}) GROUP BY message_id, kind, source, link`,
    ...tracked.map((t) => t.message_id),
  );
  for (const t of tracked) {
    if (t.message_id === null) continue;
    out.set(t.message_id, summarize(parseJson<string[]>(t.links, []), counts.filter((c) => c.message_id === t.message_id)));
  }
  return out;
}

export interface TrackingEvent {
  kind: 'open' | 'click';
  source: HitSource;
  url: string | null;
  ip: string | null;
  userAgent: string | null;
  country: string | null;
  at: number;
}

export async function trackingEvents(db: D1Database, messageId: number): Promise<{ summary: TrackingSummary | null; events: TrackingEvent[] }> {
  const summary = (await trackingSummaries(db, [messageId])).get(messageId) ?? null;
  if (!summary) return { summary: null, events: [] };
  const rows = await all<{ kind: 'open' | 'click'; source: HitSource; link: number | null; ip: string | null; user_agent: string | null; country: string | null; created_at: number }>(
    db,
    'SELECT kind, source, link, ip, user_agent, country, created_at FROM tracking_events WHERE message_id = ? ORDER BY created_at DESC LIMIT ?',
    messageId,
    MAX_EVENTS,
  );
  return {
    summary,
    events: rows.map((r) => ({
      kind: r.kind,
      source: r.source,
      url: r.link === null ? null : (summary.links[r.link]?.url ?? null),
      ip: r.ip,
      userAgent: r.user_agent,
      country: r.country,
      at: r.created_at,
    })),
  };
}
