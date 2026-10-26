import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleCheck, CircleX, Info, LoaderCircle, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './button';
import { IconTile, type Tone } from './misc';

// Modal dialog: portal, Escape to close, focus moves inside, click outside closes.
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  footerStart,
  icon,
  tone = 'neutral',
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  // Left side of the footer: a note or a step counter.
  footerStart?: ReactNode;
  // An icon tile above the title, for confirmations.
  icon?: ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const focusable = panel.current?.querySelector<HTMLElement>('input, textarea, select, button[data-autofocus], [autofocus]');
      (focusable ?? panel.current)?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: 'max-w-[420px]', md: 'max-w-[520px]', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-scrim animate-fade-in">
      <div className="flex min-h-full items-center justify-center p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" className={cn('w-full overflow-hidden rounded-[14px] border border-border bg-surface shadow-pop outline-none animate-pop-in', width)}>
          <div className={cn('flex items-start gap-4', icon ? 'px-[22px] pt-[22px]' : 'pt-5 pr-4 pl-[22px]')}>
            <div className="min-w-0 flex-1">
              {icon && (
                <IconTile tone={tone} size={40} className="mb-3.5">
                  {icon}
                </IconTile>
              )}
              <h2 className="text-base font-semibold text-fg">{title}</h2>
              {description && <p className="mt-0.5 text-[13px] text-muted text-pretty">{description}</p>}
            </div>
            {!icon && (
              <button type="button" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-fg" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {children ? <div className="px-[22px] pt-4 pb-5">{children}</div> : <div className="h-5" />}
          {footer && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2 px-[22px] py-3.5">
              {footerStart && <div className="mr-auto flex items-center gap-1.5 text-[12.5px] text-muted">{footerStart}</div>}
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  danger,
  loading,
  icon,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      icon={icon}
      tone={danger ? 'danger' : 'primary'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children && <div className="text-[13px] text-muted text-pretty">{children}</div>}
    </Dialog>
  );
}

// Dropdown menu anchored to its trigger.
export function Menu({ trigger, children, align = 'end', className }: { trigger: (props: { onClick: () => void; open: boolean }) => ReactNode; children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div ref={root} className="relative inline-block">
      {trigger({ onClick: () => setOpen((o) => !o), open })}
      {open && (
        <div
          className={cn(
            'absolute z-40 mt-1 min-w-[220px] rounded-[10px] border border-border bg-surface p-[5px] shadow-pop animate-fade-in',
            align === 'end' ? 'right-0' : 'left-0',
            className,
          )}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  disabled,
  hint,
  checked,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  // Right-aligned: a shortcut key or a time.
  hint?: ReactNode;
  checked?: boolean;
}) {
  const short = typeof hint === 'string' && hint.length <= 3;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] whitespace-nowrap transition-colors disabled:opacity-50',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-fg hover:bg-surface-2',
      )}
    >
      {icon && <span className={cn('flex [&>svg]:h-[15px] [&>svg]:w-[15px]', danger ? 'text-danger' : 'text-muted')}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className={cn('text-faint tabular-nums', short ? 'font-mono text-[11px] font-medium' : 'text-xs')}>{hint}</span>}
      {checked && <Check className="h-3.5 w-3.5 text-primary-text" />}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="mx-0.5 my-[5px] h-px bg-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-[5px] pb-1 text-[11.5px] font-medium text-faint">{children}</div>;
}

// Toasts ---------------------------------------------------------------------------------------

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info' | 'pending';
  message: ReactNode;
  action?: { label: string; onClick: () => void };
  duration: number;
}

type Push = (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => number;
const ToastContext = createContext<Push>(() => 0);
const DismissContext = createContext<(id: number) => void>(() => {});

function ToastItem({ toast: t, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  // A pending toast counts down to the moment its action stops being possible.
  const [left, setLeft] = useState(Math.ceil(t.duration / 1000));
  useEffect(() => {
    if (t.tone !== 'pending' || t.duration <= 0) return;
    const end = Date.now() + t.duration;
    const id = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 250);
    return () => clearInterval(id);
  }, [t.tone, t.duration]);
  const Icon = t.tone === 'success' ? CircleCheck : t.tone === 'error' ? CircleX : t.tone === 'pending' ? LoaderCircle : Info;
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto relative flex min-h-11 items-center gap-3 overflow-hidden rounded-[10px] border bg-surface py-2 pr-2 pl-3.5 text-[13px] text-fg shadow-pop animate-slide-up',
        t.tone === 'error' ? 'border-danger/35' : 'border-border',
      )}
    >
      <Icon className={cn('h-[15px] w-[15px] shrink-0', t.tone === 'success' ? 'text-success' : t.tone === 'error' ? 'text-danger' : t.tone === 'pending' ? 'animate-spin text-muted' : 'text-primary-text')} />
      <div className="min-w-0 flex-1 font-medium">{t.message}</div>
      {t.action && (
        <button
          type="button"
          className={cn('flex h-7 items-center gap-2 rounded-md px-2.5 font-medium', t.tone === 'pending' ? 'bg-surface-2 font-semibold hover:bg-surface-3' : 'text-primary-text hover:bg-surface-2')}
          onClick={() => {
            t.action!.onClick();
            dismiss(t.id);
          }}
        >
          {t.action.label}
          {t.tone === 'pending' && <span className="font-normal text-faint tabular-nums">{left}s</span>}
        </button>
      )}
      {t.tone !== 'pending' && (
        <button type="button" onClick={() => dismiss(t.id)} className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-fg" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {t.tone === 'pending' && t.duration > 0 && <div className="absolute bottom-0 left-0 h-0.5 bg-primary" style={{ animation: `countdown ${t.duration}ms linear forwards` }} />}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback<Push>(
    (t) => {
      const id = Date.now() + Math.random();
      const toast: Toast = { duration: t.tone === 'error' ? 7000 : 4000, ...t, id };
      setToasts((ts) => [...ts.slice(-3), toast]);
      if (toast.duration > 0) setTimeout(() => dismiss(id), toast.duration);
      return id;
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      <DismissContext.Provider value={dismiss}>
        {children}
        {createPortal(
          <div className="pointer-events-none fixed right-4 bottom-4 left-4 z-[60] flex flex-col items-stretch gap-2 sm:right-auto sm:bottom-6 sm:left-6 sm:w-[360px]">
            {toasts.map((t) => (
              <ToastItem key={t.id} toast={t} dismiss={dismiss} />
            ))}
          </div>,
          document.body,
        )}
      </DismissContext.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  const dismiss = useContext(DismissContext);
  return {
    success: (message: ReactNode, action?: Toast['action']) => push({ tone: 'success', message, action }),
    error: (message: ReactNode, action?: Toast['action']) => push({ tone: 'error', message, action }),
    info: (message: ReactNode, action?: Toast['action'], duration?: number) => push({ tone: 'info', message, action, duration }),
    // Something that happens after `duration` unless the action is taken (Undo send).
    pending: (message: ReactNode, action: Toast['action'], duration: number) => push({ tone: 'pending', message, action, duration }),
    dismiss,
  };
}
