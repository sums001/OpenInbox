import { useEffect, useState } from 'react';
import { storageGet, storageSet } from './utils';

export type Theme = 'light' | 'dark' | 'system';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && media().matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e0e12' : '#4f46e5');
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => storageGet<Theme>('oi.theme', 'system'));
  useEffect(() => {
    applyTheme(theme);
    storageSet('oi.theme', theme);
    if (theme !== 'system') return;
    const m = media();
    const onChange = () => applyTheme('system');
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, [theme]);
  return [theme, setTheme];
}

// Applied before React renders, to avoid a flash of the wrong theme.
export function initTheme(): void {
  applyTheme(storageGet<Theme>('oi.theme', 'system'));
}
