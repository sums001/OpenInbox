import { useEffect, useState } from 'react';
import { storageGet, storageSet } from './utils';

export type Theme = 'light' | 'dark' | 'system';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && media().matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d0d11' : '#4f46e5');
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

// Whether the dark theme is showing right now; follows theme changes and the system setting.
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setDark(el.classList.contains('dark')));
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

// Applied before React renders, to avoid a flash of the wrong theme.
export function initTheme(): void {
  applyTheme(storageGet<Theme>('oi.theme', 'system'));
}
