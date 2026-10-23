// Turns untrusted email HTML into a document for a sandboxed iframe. Three layers: DOMPurify
// removes active content, the iframe sandbox has no scripts, and the document's own CSP blocks
// remote loads (tracking pixels, fonts, CSS) until the user allows images.
import DOMPurify from 'dompurify';
import type { Attachment } from './types';

export interface SanitizedMail {
  html: string;
  blockedImages: number;
}

const FORBID_TAGS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'base', 'svg', 'math', 'video', 'audio', 'source', 'track', 'portal', 'noscript'];
const FORBID_ATTR = ['srcdoc', 'formaction', 'ping', 'autofocus', 'onerror', 'onload'];
const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function isRemote(url: string): boolean {
  return /^(https?:)?\/\//i.test(url.trim());
}

export function sanitizeMail(raw: string, opts: { allowImages: boolean; attachments: Attachment[] }): SanitizedMail {
  let blocked = 0;
  const cidMap = new Map(
    opts.attachments.filter((a) => a.contentId && a.stored).map((a) => [a.contentId!.toLowerCase(), `/api/attachments/${a.id}?inline=1`]),
  );
  // <style> in <head> would be dropped with the head; keep it.
  const headStyles = [...raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(raw);
  const body = bodyMatch ? bodyMatch[1] : raw.replace(/<head\b[\s\S]*?<\/head>/i, '');

  const rewriteUrl = (url: string): string | null => {
    const u = url.trim();
    if (/^cid:/i.test(u)) return cidMap.get(u.slice(4).replace(/^<|>$/g, '').toLowerCase()) ?? TRANSPARENT;
    if (isRemote(u) && !opts.allowImages) {
      blocked++;
      return null;
    }
    return u;
  };

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      const next = rewriteUrl(src);
      if (next === null) {
        el.setAttribute('data-oi-blocked', '1');
        el.setAttribute('src', TRANSPARENT);
      } else el.setAttribute('src', next);
      el.removeAttribute('srcset');
    }
    for (const attr of ['background', 'poster']) {
      const v = el.getAttribute(attr);
      if (v) {
        const next = rewriteUrl(v);
        if (next === null) el.removeAttribute(attr);
        else el.setAttribute(attr, next);
      }
    }
    const style = el.getAttribute('style');
    if (style && /url\(/i.test(style)) {
      el.setAttribute(
        'style',
        style.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, url: string) => {
          const next = rewriteUrl(url);
          return next === null ? 'none' : `url("${next}")`;
        }),
      );
    }
  });
  const clean = DOMPurify.sanitize(`${headStyles ? `<style>${headStyles}</style>` : ''}${body}`, {
    ADD_TAGS: ['style'],
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true,
    WHOLE_DOCUMENT: false,
  });
  DOMPurify.removeHook('afterSanitizeAttributes');
  // Remote url() inside <style> blocks are stopped by the frame CSP; count them for the banner.
  if (!opts.allowImages) blocked += [...clean.matchAll(/<style[\s\S]*?url\(\s*['"]?https?:/gi)].length;
  return { html: clean, blockedImages: blocked };
}

export function frameDocument(body: string, opts: { allowImages: boolean; dark?: boolean }): string {
  const origin = location.origin;
  const remote = opts.allowImages ? ' https: http:' : '';
  const csp = `default-src 'none'; img-src data: blob: ${origin}${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}; media-src 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>
html,body{margin:0;padding:0;background:#fff;color:#1f1f24}
body{padding:4px 2px;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{max-width:100%!important}
pre{white-space:pre-wrap}
a{color:#4338ca}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #d6d6de;color:#55555f}
img[data-oi-blocked]{display:none}
</style></head><body>${body}</body></html>`;
}

// Plain text to safe HTML with links, quoted lines dimmed.
export function textToSafeHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(text)
    .replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|\s)([\w.+-]+@[\w-]+\.[\w.-]+)/g, '$1<a href="mailto:$2">$2</a>');
}

// Splits plain text into the new part and the quoted history (lines starting with ">", or an
// "On ... wrote:" line), so the history can be collapsed.
export function splitQuoted(text: string): { main: string; quoted: string } {
  const lines = text.split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^On .{4,200} wrote:$/i.test(l) || (/^>/.test(l) && lines.slice(i).filter((x) => x.trim()).every((x) => /^>/.test(x.trim()) || /^On .+wrote:$/i.test(x.trim())))) {
      cut = i;
      break;
    }
    if (/^-{2,} ?Original Message ?-{2,}$/i.test(l) || /^_{10,}$/.test(l)) {
      cut = i;
      break;
    }
  }
  return { main: lines.slice(0, cut).join('\n').trimEnd(), quoted: lines.slice(cut).join('\n') };
}
