// Per-mailbox filter rules, evaluated on arrival.
import { all } from '../db/db';
import { parseJson } from '../lib/json';
import type { ThreadFolder } from '../../shared/constants';

export interface FilterConditions {
  match?: 'all' | 'any';
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  hasAttachment?: boolean;
  isList?: boolean;
}

export interface FilterActions {
  labelIds?: number[];
  folder?: ThreadFolder;
  markRead?: boolean;
  star?: boolean;
  forwardTo?: string;
  neverSpam?: boolean;
}

export interface FilterRow {
  id: number;
  mailbox_id: number;
  name: string;
  conditions: string;
  actions: string;
  position: number;
  enabled: number;
}

export interface FilterInput {
  fromAddr: string;
  fromName: string;
  recipients: string[];
  subject: string;
  text: string;
  hasAttachment: boolean;
  isList: boolean;
}

const contains = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.trim().toLowerCase());

export function filterMatches(c: FilterConditions, m: FilterInput): boolean {
  const tests: boolean[] = [];
  if (c.from) tests.push(contains(m.fromAddr, c.from) || contains(m.fromName, c.from));
  if (c.to) tests.push(m.recipients.some((r) => contains(r, c.to!)));
  if (c.subject) tests.push(contains(m.subject, c.subject));
  if (c.body) tests.push(contains(m.text.slice(0, 200_000), c.body));
  if (c.hasAttachment !== undefined) tests.push(m.hasAttachment === c.hasAttachment);
  if (c.isList !== undefined) tests.push(m.isList === c.isList);
  if (!tests.length) return false;
  return c.match === 'any' ? tests.some(Boolean) : tests.every(Boolean);
}

export async function loadFilters(db: D1Database, mailboxId: number): Promise<{ id: number; conditions: FilterConditions; actions: FilterActions }[]> {
  const rows = await all<FilterRow>(db, 'SELECT * FROM filters WHERE mailbox_id = ? AND enabled = 1 ORDER BY position, id', mailboxId);
  return rows.map((r) => ({ id: r.id, conditions: parseJson(r.conditions, {}), actions: parseJson(r.actions, {}) }));
}

// Combines the actions of every matching filter, in order.
export function applyFilters(filters: { conditions: FilterConditions; actions: FilterActions }[], m: FilterInput): FilterActions {
  const out: FilterActions = {};
  for (const f of filters) {
    if (!filterMatches(f.conditions, m)) continue;
    const a = f.actions;
    if (a.labelIds?.length) out.labelIds = [...new Set([...(out.labelIds ?? []), ...a.labelIds])];
    if (a.folder) out.folder = a.folder;
    if (a.markRead) out.markRead = true;
    if (a.star) out.star = true;
    if (a.forwardTo) out.forwardTo = a.forwardTo;
    if (a.neverSpam) out.neverSpam = true;
  }
  return out;
}
