import type { ReactNode } from 'react';
import { LogoMark } from '../../components/Logo';

export function AuthLayout({ title, subtitle, children, footer, wide }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-bg px-4 py-10">
      <div className={wide ? 'w-full max-w-2xl' : 'w-full max-w-sm'}>
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark size={44} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-card">{children}</div>
        {footer && <div className="mt-4 text-center text-[13px] text-muted">{footer}</div>}
      </div>
    </div>
  );
}
