import { useEffect, useState } from 'react';
import { useSession } from '../lib/session';

export function LogoMark({ size = 28, src, className }: { size?: number; src?: string | null; className?: string }) {
  const { data: session } = useSession();
  const [failed, setFailed] = useState(false);
  const logoUrl = src !== undefined ? (src || null) : (session?.logoUrl ?? null);

  useEffect(() => {
    setFailed(false);
  }, [logoUrl]);

  if (logoUrl && !failed) {
    return (
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className={`shrink-0 object-contain ${className ?? ''}`}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={`shrink-0 ${className ?? ''}`}>
      <defs>
        <linearGradient id="oi-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#oi-g)" />
      <rect x=".5" y=".5" width="63" height="63" rx="14.5" fill="none" stroke="#fff" strokeOpacity=".2" />
      {/* The "a": a ring cut flat on the right, then the "I" pill. */}
      <path fill="#fff" fillRule="evenodd" d="M39.5 19.93A16 16 0 1 0 39.5 44.07ZM38 32a9 9 0 1 0-18 0 9 9 0 1 0 18 0Z" />
      <rect x="41" y="16" width="10" height="32" rx="5" fill="#fff" />
    </svg>
  );
}

export function Logo({ name }: { name?: string }) {
  const { data: session } = useSession();
  const displayName = name ?? session?.instanceName ?? 'OpenInbox';
  return (
    <div className="flex items-center gap-2">
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight text-fg">{displayName}</span>
    </div>
  );
}
