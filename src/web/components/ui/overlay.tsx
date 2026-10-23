import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './button';

// Modal dialog: portal, Escape to close, focus moves inside, click outside closes.
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
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
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" className={cn('w-full rounded-xl border border-border bg-surface shadow-pop outline-none animate-slide-up', width)}>
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h2 className="text-base font-semibold text-fg">{title}</h2>
            {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-faint hover:bg-surface-2 hover:text-fg" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children && <div className="px-5 py-4">{children}</div>}
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
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
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children && <div className="text-sm text-muted">{children}</div>}
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
            'absolute z-40 mt-1 min-w-48 rounded-lg border border-border bg-surface p-1 shadow-pop animate-fade-in',
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

export function MenuItem({ icon, children, onClick, danger, disabled, hint }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean; hint?: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-50',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-fg hover:bg-surface-2',
      )}
    >
      {icon && <span className="text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
      <span className="flex-1">{children}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">{children}</div>;
}

// Toasts ---------------------------------------------------------------------------------------

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  message: ReactNode;
  action?: { label: string; onClick: () => void };
  duration: number;
}

const ToastContext = createContext<(t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => number>(() => 0);
const DismissContext = createContext<(id: number) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => {
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
          <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4">
            {toasts.map((t) => {
              const Icon = t.tone === 'success' ? CircleCheck : t.tone === 'error' ? CircleX : Info;
              return (
                <div key={t.id} className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-fg px-4 py-2.5 text-sm text-bg shadow-pop animate-slide-up">
                  <Icon className={cn('h-4 w-4 shrink-0', t.tone === 'error' ? 'text-red-400' : t.tone === 'success' ? 'text-green-400' : 'opacity-70')} />
                  <div className="flex-1">{t.message}</div>
                  {t.action && (
                    <button
                      type="button"
                      className="font-semibold text-primary-soft underline-offset-2 hover:underline"
                      onClick={() => {
                        t.action!.onClick();
                        dismiss(t.id);
                      }}
                    >
                      {t.action.label}
                    </button>
                  )}
                  <button type="button" onClick={() => dismiss(t.id)} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
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
    error: (message: ReactNode) => push({ tone: 'error', message }),
    info: (message: ReactNode, action?: Toast['action'], duration?: number) => push({ tone: 'info', message, action, duration }),
    dismiss,
  };
}
