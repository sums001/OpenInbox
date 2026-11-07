// Plain-text mail as HTML for the app page. No DOM, so it is unit-tested in the Worker runtime.

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]);
// URLs stop at quotes and angle brackets, so `<https://…>` and `"https://…"` link only the URL.
const LINKS = /\b(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])|(?<=^|\s)([\w.+-]+@[\w-]+\.[\w.-]+)/g;

// Plain text to safe HTML with links. Links are found in the raw text and every piece is
// escaped, quotes included, so nothing in the text can end up as markup or in an attribute.
export function textToSafeHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(LINKS)) {
    out += escapeHtml(text.slice(last, m.index));
    const [, url, email] = m;
    out += url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
      : `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}
