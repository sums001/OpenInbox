import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { frameDocument, sanitizeMail } from '../../lib/sanitize';
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
  const { doc, blocked } = useMemo(() => {
    const s = sanitizeMail(html, { allowImages, attachments });
    return { doc: frameDocument(s.html, { allowImages }), blocked: s.blockedImages };
  }, [html, allowImages, attachments]);

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
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] text-muted">
          <ImageOff className="h-4 w-4" />
          <span className="flex-1">Remote images are hidden to protect your privacy.</span>
          <Button size="xs" onClick={onAllowImages}>
            Show images
          </Button>
          {onTrustSender && (
            <Button size="xs" variant="ghost" onClick={onTrustSender}>
              Always from this sender
            </Button>
          )}
        </div>
      )}
      <div className="overflow-hidden rounded-lg bg-white">
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
