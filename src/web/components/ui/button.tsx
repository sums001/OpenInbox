import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Tooltip } from './tooltip';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'link';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover shadow-[var(--shadow),inset_0_1px_0_rgb(255_255_255/0.12)]',
  secondary: 'bg-surface text-fg border border-border shadow-card hover:bg-surface-2',
  outline: 'bg-surface text-fg border border-border hover:bg-surface-2',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white hover:opacity-90 shadow-card',
  link: 'text-primary-text hover:underline px-0 h-auto',
};

const sizes: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-[7px] [&>svg]:h-3.5 [&>svg]:w-3.5',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-[34px] px-3.5 text-[13px] gap-2 rounded-lg',
  lg: 'h-10 px-4 text-sm gap-2 rounded-[9px]',
  icon: 'h-[30px] w-[30px] rounded-[7px] justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center font-medium whitespace-nowrap transition-colors select-none disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

// Icon-only button. The label is its accessible name and tooltip; `shortcut` shows the key.
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string; shortcut?: string }>(function IconButton({ label, shortcut, className, disabled, ...rest }, ref) {
  const button = <Button ref={ref} variant="ghost" size="icon" aria-label={label} className={cn('[&>svg]:h-4 [&>svg]:w-4', className)} disabled={disabled} {...rest} />;
  // A disabled button gets no pointer events, so the tooltip goes on a wrapper.
  if (disabled)
    return (
      <Tooltip content={label} shortcut={shortcut}>
        <span className="inline-flex">{button}</span>
      </Tooltip>
    );
  return (
    <Tooltip content={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  );
});
