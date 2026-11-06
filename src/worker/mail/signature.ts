// Server-side signature cleaning with HTMLRewriter (no DOM in the Worker). Signatures are shown
// to every member of a shared mailbox and go out in sent mail, so they are cleaned on save
// whatever client sent them.
import { cleanSignatureStyle, isSafeSignatureUrl, SIGNATURE_ATTRS, SIGNATURE_DROP_WITH_CONTENT, SIGNATURE_TAGS } from '../../shared/signature';

const TAGS = new Set(SIGNATURE_TAGS);
const ATTRS = new Set(SIGNATURE_ATTRS);
const DROP = new Set(SIGNATURE_DROP_WITH_CONTENT);

export async function sanitizeSignature(html: string): Promise<string> {
  if (!html.trim()) return '';
  const rewriter = new HTMLRewriter()
    .on('*', {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROP.has(tag)) {
          el.remove();
          return;
        }
        if (!TAGS.has(tag)) {
          el.removeAndKeepContent();
          return;
        }
        // Browsers use the first of duplicate attributes and setAttribute changes only the first,
        // so rebuild the attributes from the first of each name.
        const first = new Map<string, string>();
        for (const [name, value] of [...el.attributes]) {
          const n = name.toLowerCase();
          if (!first.has(n)) first.set(n, value);
          el.removeAttribute(name);
        }
        for (const [n, value] of first) {
          if (!ATTRS.has(n) || ((n === 'href' || n === 'src') && !isSafeSignatureUrl(n, value))) continue;
          const v = n === 'style' ? cleanSignatureStyle(value) : value;
          if (v) el.setAttribute(n, v);
        }
        if (tag === 'a') {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      },
    })
    .onDocument({
      comments(c) {
        c.remove();
      },
    });
  return rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })).text();
}
