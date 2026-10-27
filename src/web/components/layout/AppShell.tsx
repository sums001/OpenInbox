import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Command, Inbox, Keyboard, LayoutGrid, LogOut, Monitor, Moon, Settings, Sun, UserRound } from 'lucide-react';
import { useSession } from '../../lib/session';
import { errorText, post } from '../../lib/api';
import type { Session } from '../../lib/types';
import { useTheme, type Theme } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { CommandPalette, KeyCombo, SHORTCUTS } from '../../pages/mail/CommandPalette';
import { LogoMark } from '../Logo';
import { Dialog, Menu, MenuItem, MenuLabel, MenuSeparator, useToast } from '../ui/overlay';
import { Avatar, Kbd } from '../ui/misc';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function AppShell() {
  const { data: session } = useSession();
  const user = session?.user;
  const [theme, setTheme] = useTheme();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);

  // Ctrl/⌘ K and the shortcuts help work on every page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    const onHelp = () => setHelp(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('oi:shortcuts', onHelp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('oi:shortcuts', onHelp);
    };
  }, []);

  const signOut = async () => {
    try {
      await post('/auth/logout');
    } catch (e) {
      toast.error(errorText(e));
      return;
    }
    // Mark the session signed out in place and drop everything else. (Clearing the whole cache
    // orphaned the session query, so the app kept the old user and never reached the login page.)
    navigate('/login', { replace: true });
    qc.setQueryData<Session>(['session'], (s) => (s ? { ...s, user: null } : s));
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
  };

  const nav = (to: string, label: string, Icon: typeof Inbox) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex h-7 items-center gap-[7px] rounded-[7px] px-2.5 text-[13px] font-medium transition-colors [&>svg]:h-[15px] [&>svg]:w-[15px]',
          isActive ? 'bg-surface-2 text-fg [&>svg]:text-muted' : 'text-muted hover:text-fg',
        )
      }
    >
      <Icon />
      <span className="hidden sm:inline">{label}</span>
    </NavLink>
  );

  const themes: { value: Theme; label: string; Icon: typeof Sun }[] = [
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'dark', label: 'Dark', Icon: Moon },
    { value: 'system', label: 'System', Icon: Monitor },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg pr-3 pl-3.5 sm:gap-5">
        <NavLink to="/" className="flex items-center gap-[9px] md:w-[230px]">
          <LogoMark size={22} />
          <span className="hidden truncate text-sm font-semibold tracking-[-0.01em] md:inline">{session?.instanceName ?? 'OpenInbox'}</span>
        </NavLink>
        <nav className="flex items-center gap-0.5">
          {nav('/mail', 'Mail', Inbox)}
          {isAdmin && nav('/admin', 'Admin', LayoutGrid)}
        </nav>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="hidden h-[30px] w-60 items-center gap-2 rounded-lg border border-border bg-surface pr-1.5 pl-2.5 text-[12.5px] text-faint transition-colors hover:border-border-strong hover:text-muted sm:flex"
        >
          <Command className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">Jump to…</span>
          <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
        </button>
        <Menu
          className="w-[264px]"
          trigger={({ onClick, open }) => (
            <button type="button" onClick={onClick} className={cn('rounded-full transition-shadow', open && 'ring-2 ring-[var(--ring)] ring-offset-2 ring-offset-bg')} aria-label="Account menu">
              <Avatar name={user?.name ?? ''} address={user?.email ?? ''} size={30} />
            </button>
          )}
        >
          <div className="flex items-center gap-2.5 px-2 pt-2 pb-2.5">
            <Avatar name={user?.name ?? ''} address={user?.email ?? ''} size={34} />
            <div className="min-w-0 leading-snug">
              <div className="truncate text-[13px] font-semibold">{user?.name}</div>
              <div className="truncate text-xs text-muted">{user?.email}</div>
            </div>
          </div>
          <MenuSeparator />
          <MenuItem icon={<UserRound />} onClick={() => navigate('/settings/profile')}>
            Account
          </MenuItem>
          <MenuItem icon={<Settings />} onClick={() => navigate('/settings/signature')}>
            Mail settings
          </MenuItem>
          <MenuItem icon={<Keyboard />} onClick={() => setHelp(true)} hint={<Kbd>?</Kbd>}>
            Keyboard shortcuts
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          {themes.map(({ value, label, Icon }) => (
            <MenuItem key={value} icon={<Icon />} onClick={() => setTheme(value)} checked={theme === value}>
              {label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={<LogOut />} onClick={signOut}>
            Sign out
          </MenuItem>
          <div className="px-2 pt-1.5 pb-1 text-[11px] text-faint">OpenInbox {session?.version}</div>
        </Menu>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <Dialog open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" size="lg">
        <div className="grid gap-x-9 sm:grid-cols-2">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={label} className="flex min-h-[38px] items-center justify-between gap-3 border-b border-border py-1.5 text-[13px]">
              <span className="text-muted">{label}</span>
              <KeyCombo keys={keys} />
            </div>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
