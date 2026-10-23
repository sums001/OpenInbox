// HTML to plain text (for search, snippets and HTML-only mail) and snippet helpers.
// Regex based: cheap enough for the inbound CPU budget, and good enough for indexing.

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', laquo: '«', raquo: '»',
  zwnj: '', zwj: '', shy: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      } catch {
        return '';
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|tr|ul|ol|table|h[1-6]|blockquote|section|article|header|footer)\s*>/gi, '\n')
      .replace(/<(p|div|tr|table|h[1-6]|blockquote|section|article|header|footer)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v\u00a0\u200b]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A one-line preview: drops quoted replies and signature separators, collapses whitespace.
export function makeSnippet(text: string, max = 180): string {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('>')) continue;
    if (/^On .+wrote:$/i.test(t) || /^-{2,}\s*$/.test(t) || /^_{5,}$/.test(t)) break;
    if (t) lines.push(t);
    if (lines.join(' ').length > max) break;
  }
  const s = lines.join(' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Plain text to simple HTML (used when composing from text, e.g. auto-replies).
export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
