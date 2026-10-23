import { cn } from '../lib/utils';

// A rough strength estimate: length and character variety, which is what matters most.
export function passwordScore(p: string): number {
  if (!p) return 0;
  let score = 0;
  if (p.length >= 10) score++;
  if (p.length >= 14) score++;
  if (p.length >= 20) score++;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/, /\s/].filter((r) => r.test(p)).length;
  if (kinds >= 3) score++;
  if (/^(.)\1+$/.test(p) || /^(password|123456|qwerty)/i.test(p)) score = 0;
  return Math.min(4, score);
}

export function PasswordStrength({ password }: { password: string }) {
  const score = passwordScore(password);
  const labels = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];
  const colors = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'];
  if (!password) return null;
  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn('h-1 flex-1 rounded-full', i < Math.max(score, 1) ? colors[score] : 'bg-surface-3')} />
        ))}
      </div>
      <span className="w-16 text-right text-xs text-muted">{labels[score]}</span>
    </div>
  );
}
