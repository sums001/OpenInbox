// What a mailbox signature may contain: formatting, links, images and the table layouts that
// signature generators produce. Shared by the web app (DOMPurify, on preview, save and send) and
// the Worker (HTMLRewriter, on save), so a signature stored through the API alone is cleaned too.

export const SIGNATURE_TAGS = [
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'small', 'big', 'sub', 'sup', 'font', 'span', 'div', 'p', 'br', 'hr',
  'blockquote', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'img', 'center',
];

export const SIGNATURE_ATTRS = [
  'href', 'src', 'alt', 'title', 'width', 'height', 'color', 'bgcolor', 'face', 'size', 'align', 'valign', 'border',
  'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'span', 'nowrap', 'hspace', 'vspace', 'dir', 'style',
];

// Dropped with everything inside them, not just unwrapped.
export const SIGNATURE_DROP_WITH_CONTENT = [
  'script', 'style', 'template', 'noscript', 'title', 'head', 'textarea', 'select', 'option', 'iframe', 'frame',
  'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'xmp', 'noembed', 'noframes', 'plaintext',
];

// Formatting only: nothing that can lift an element out of the page flow (position, z-index)
// or load something (url(), image(), image-set()). No "&" either: the Worker sees attribute
// values with character references still encoded, and a browser decodes "u&#114l(" to "url("
// (even without the semicolon) and "&#59;" to a new declaration.
const STYLE_PROPS =
  /^(color|background(-color)?|display|float|clear|box-sizing|table-layout|font(-(family|size|weight|style|variant))?|text-(decoration|align|transform|indent)|letter-spacing|line-height|vertical-align|white-space|word-break|overflow-wrap|list-style(-type)?|(margin|padding)(-(top|right|bottom|left))?|border(-[a-z-]+)?|(min-|max-)?(width|height))$/;
const STYLE_VALUE_BAD = /url\s*\(|image(-set)?\s*\(|element\s*\(|src\s*\(|expression|javascript:|@import|\\|[<>&]/i;

export function cleanSignatureStyle(style: string): string {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter((d) => {
      const colon = d.indexOf(':');
      return colon > 0 && STYLE_PROPS.test(d.slice(0, colon).trim().toLowerCase()) && !STYLE_VALUE_BAD.test(d.slice(colon + 1));
    })
    .join('; ');
}

// Browsers ignore whitespace and control characters inside a URL scheme, so check without them.
export function isSafeSignatureUrl(attr: 'href' | 'src', url: string): boolean {
  // eslint-disable-next-line no-control-regex
  const u = url.replace(/[\u0000- ]/g, '');
  return attr === 'href' ? /^(https?:|mailto:|tel:)/i.test(u) : /^(https?:|data:image\/(png|gif|jpe?g|webp);)/i.test(u);
}
