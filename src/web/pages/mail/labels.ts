import type { CSSProperties } from 'react';
import { LABEL_COLORS } from '../../../shared/constants';

// Label colors are CSS variables (index.css); unknown colors fall back to slate.
function token(color: string): string {
  return `var(--lab-${(LABEL_COLORS as readonly string[]).includes(color) ? color : 'slate'})`;
}

// For the small dot: style={labelDot(l.color)}.
export function labelDot(color: string): CSSProperties {
  return { background: token(color) };
}

// For a chip: className="label-chip" style={labelChip(l.color)}.
export function labelChip(color: string): CSSProperties {
  return { '--lab': token(color) } as CSSProperties;
}
