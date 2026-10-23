import { NavLink, Navigate, Route, Routes } from 'react-router';
import { Inbox, UserRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { AccountSettings } from './AccountSettings';
import { MailboxSettings } from './MailboxSettings';

export default function SettingsPage() {
  const link = (to: string, label: string, Icon: typeof Inbox) => (
    <NavLink
      to={to}
      className={({ isActive }) => cn('flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium', isActive ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg')}
    >
      <Icon className="h-4 w-4" />
      {label}
    </NavLink>
  );
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="shrink-0 border-b border-border bg-surface p-2 md:w-56 md:border-r md:border-b-0 md:p-3">
        <nav className="flex gap-1 md:flex-col">
          {link('/settings/account', 'Account', UserRound)}
          {link('/settings/mailboxes', 'Mail settings', Inbox)}
        </nav>
      </aside>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
          <Routes>
            <Route path="account" element={<AccountSettings />} />
            <Route path="mailboxes/*" element={<MailboxSettings />} />
            <Route path="*" element={<Navigate to="account" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
