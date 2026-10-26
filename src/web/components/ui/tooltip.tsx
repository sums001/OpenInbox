import { cloneElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

// A small dark tooltip below (or above) its child, with an optional shortcut. Shown after a short
// hover delay or on keyboard focus.
export function Tooltip({ content, shortcut, rich, children }: { content: ReactNode; shortcut?: string; rich?: boolean; children: ReactElement<Record<string, unknown>> }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (el: HTMLElement, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setRect(el.getBoundingClientRect()), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setRect(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!rect) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('mousedown', hide, true);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('mousedown', hide, true);
    };
  }, [rect]);

  const props = children.props as Record<string, ((e: React.SyntheticEvent<HTMLElement>) => void) | undefined>;
  const child = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseEnter?.(e);
      show(e.currentTarget, 450);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      props.onFocus?.(e);
      if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget, 0);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      props.onBlur?.(e);
      hide();
    },
  });

  const below = rect ? rect.bottom + 40 < window.innerHeight : true;
  return (
    <>
      {child}
      {rect &&
        content &&
        createPortal(
          <div
            role="tooltip"
            className={cn(
              'pointer-events-none fixed z-[70] -translate-x-1/2 bg-fg text-xs text-bg shadow-pop animate-fade-in',
              rich ? 'rounded-lg px-3 py-2.5' : 'flex h-[26px] items-center gap-2.5 rounded-md px-2 font-medium whitespace-nowrap',
            )}
            style={{ left: Math.min(Math.max(rect.left + rect.width / 2, 120), window.innerWidth - 120), ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }) }}
          >
            {content}
            {shortcut && <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-bg/20 px-1 font-mono text-[10.5px] leading-none">{shortcut}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
