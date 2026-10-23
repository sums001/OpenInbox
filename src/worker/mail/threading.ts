// Threading helpers. Threads match on any Message-ID in In-Reply-To or References (providers
// such as Resend/SES replace our Message-ID, but replies copy References, where we append ours),
// falling back to normalized subject plus participants within 30 days.

// "<a@x> <b@y>" -> ["a@x", "b@y"], without angle brackets.
export function parseIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
  if (ids.length) return [...new Set(ids)];
  // Some senders omit the brackets.
  return [...new Set(value.split(/[\s,]+/).filter((t) => t.includes('@')))];
}

export function parseMessageId(value: string | null | undefined): string | null {
  return parseIdList(value)[0] ?? null;
}

const PREFIX = /^\s*(?:(?:re|fw|fwd|aw|wg|sv|vs|antw|rif|r|tr|ref|res|enc|odp|ynt|atb|vb|doorst)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*)+/i;

// "Re: Fwd: [list] Hello  world" -> "[list] hello world"
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(PREFIX, '').trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').toLowerCase().slice(0, 300);
}

export function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
  return /^\s*fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

// The References header for a reply: the parent's References plus its Message-ID, then our own
// Message-ID last (so replies carry an ID we know even after the provider replaces ours).
export function buildReferences(parentRefs: string[], parentId: string | null, ownId: string): string[] {
  const refs = [...parentRefs];
  if (parentId && !refs.includes(parentId)) refs.push(parentId);
  // Keep the header bounded: the root plus the most recent ids.
  const trimmed = refs.length > 20 ? [refs[0], ...refs.slice(-19)] : refs;
  return [...trimmed.filter((r) => r !== ownId), ownId];
}

export function newMessageId(domain: string): string {
  return `${crypto.randomUUID()}@${domain}`;
}
