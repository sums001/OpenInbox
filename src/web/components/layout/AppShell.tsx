import { NavLink, Outlet, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Inbox, Keyboard, LayoutDashboard, LogOut, Monitor, Moon, Settings, Sun, UserRound } from 'lucide-react';
import { useSession } from '../../lib/session';
import { post } from '../../lib/api';
import { useTheme, type Theme } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { LogoMark } from '../Logo';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/overlay';
import { Avatar } from '../ui/misc';

export function AppShell() {
  const { data: session } = useSession();
  const user = session?.user;
  const [theme, setTheme] = useTheme();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  const signOut = async () => {
    await post('/auth/logout');
    qc.clear();
    navigate('/login');
    qc.invalidateQueries({ queryKey: ['session'] });
  };

  const nav = (to: string, label: string, Icon: typeof Inbox) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn('flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors', isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg')
      }
    >
      <Icon className="h-4 w-4" />
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
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-4">
        <NavLink to="/" className="flex items-center gap-2">
          <LogoMark size={24} />
          <span className="hidden text-[14px] font-semibold tracking-tight md:inline">{session?.instanceName ?? 'OpenInbox'}</span>
        </NavLink>
        <nav className="ml-2 flex items-center gap-1">
          {nav('/mail', 'Mail', Inbox)}
          {isAdmin && nav('/admin', 'Admin', LayoutDashboard)}
        </nav>
        <div className="flex-1" />
        <Menu
          trigger={({ onClick }) => (
            <button type="button" onClick={onClick} className="flex items-center gap-2 rounded-full p-0.5 hover:bg-surface-2" aria-label="Account menu">
              <Avatar name={user?.name ?? ''} address={user?.email ?? ''} size={28} />
            </button>
          )}
        >
          <div className="px-2.5 py-2">
            <div className="truncate text-[13px] font-medium">{user?.name}</div>
            <div className="truncate text-xs text-muted">{user?.email}</div>
          </div>
          <MenuSeparator />
          <MenuItem icon={<UserRound />} onClick={() => navigate('/settings/account')}>
            Account
          </MenuItem>
          <MenuItem icon={<Settings />} onClick={() => navigate('/settings/mailboxes')}>
            Mail settings
          </MenuItem>
          <MenuItem icon={<Keyboard />} onClick={() => window.dispatchEvent(new CustomEvent('oi:shortcuts'))} hint="?">
            Keyboard shortcuts
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          {themes.map(({ value, label, Icon }) => (
            <MenuItem key={value} icon={<Icon />} onClick={() => setTheme(value)} hint={theme === value ? '✓' : undefined}>
              {label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={<LogOut />} onClick={signOut}>
            Sign out
          </MenuItem>
          <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint">OpenInbox {session?.version}</div>
        </Menu>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
