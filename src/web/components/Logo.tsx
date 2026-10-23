export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="oi-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#oi-g)" />
      <path d="M14 22.5c0-2.5 2-4.5 4.5-4.5h27c2.5 0 4.5 2 4.5 4.5v19c0 2.5-2 4.5-4.5 4.5h-27A4.5 4.5 0 0 1 14 41.5v-19Z" fill="none" stroke="#fff" strokeWidth="4" />
      <path d="m16 22 16 12 16-12" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ name = 'OpenInbox' }: { name?: string }) {
  return (
    <div className="flex items-center gap-2">
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight text-fg">{name}</span>
    </div>
  );
}
