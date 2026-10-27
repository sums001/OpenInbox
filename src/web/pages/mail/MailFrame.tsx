import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { frameDocument, sanitizeMail } from '../../lib/sanitize';
import { useIsDark } from '../../lib/theme';
import { cn } from '../../lib/utils';
import type { Attachment } from '../../lib/types';
import { Button } from '../../components/ui/button';

// Sanitized HTML mail in a sandboxed iframe without scripts. allow-same-origin (without
// allow-scripts) only lets the parent measure the content height.
export function MailFrame({
  html,
  attachments,
  allowImages,
  onAllowImages,
  onTrustSender,
}: {
  html: string;
  attachments: Attachment[];
  allowImages: boolean;
  onAllowImages: () => void;
  onTrustSender?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const dark = useIsDark();
  // In the dark theme, plain mail takes the app's colors; mail with its own design stays on white.
  const { doc, blocked, darkened } = useMemo(() => {
    const s = sanitizeMail(html, { allowImages, attachments, dark });
    return { doc: frameDocument(s.html, { allowImages, dark: s.darkened }), blocked: s.blockedImages, darkened: s.darkened };
  }, [html, allowImages, attachments, dark]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const d = el.contentDocument;
      if (!d?.documentElement) return;
      setHeight(Math.max(60, Math.min(d.documentElement.scrollHeight, 20_000)));
    };
    const onLoad = () => {
      measure();
      const d = el.contentDocument;
      if (d?.body) {
        observer = new ResizeObserver(measure);
        observer.observe(d.body);
        d.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
      }
    };
    el.addEventListener('load', onLoad);
    return () => {
      el.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [doc]);

  return (
    <div>
      {blocked > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2.5 rounded-lg bg-surface-2 py-2 pr-2 pl-3 text-[12.5px] text-muted">
          <ImageOff className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Remote images are hidden to protect your privacy.</span>
          <Button size="xs" className="h-[26px] shadow-none" onClick={onAllowImages}>
            Show images
          </Button>
          {onTrustSender && (
            <button type="button" className="h-[26px] px-2 font-medium text-primary-text hover:underline" onClick={onTrustSender}>
              Always show from this sender
            </button>
          )}
        </div>
      )}
      <div className={cn('overflow-hidden rounded-lg', !darkened && 'bg-white dark:px-3 dark:py-2')}>
        <iframe
          ref={frame}
          title="Message"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={doc}
          className="block w-full border-0"
          style={{ height }}
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
