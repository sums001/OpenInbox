import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router';
import { Activity, Globe, Inbox, LayoutDashboard, Plug, Route as RouteIcon, Settings, UsersRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { OverviewPage } from './OverviewPage';
import { UsersPage } from './UsersPage';
import { InboxesPage } from './InboxesPage';
import { DomainsPage } from './DomainsPage';
import { IntegrationsPage } from './IntegrationsPage';
import { MailFlowPage } from './MailFlowPage';
import { ActivityPage } from './ActivityPage';
import { AdminSettingsPage } from './AdminSettingsPage';

const items = [
  { to: '/admin', label: 'Overview', Icon: LayoutDashboard, end: true },
  { to: '/admin/inboxes', label: 'Inboxes', Icon: Inbox },
  { to: '/admin/users', label: 'Users', Icon: UsersRound },
  { to: '/admin/domains', label: 'Domains', Icon: Globe },
  { to: '/admin/integrations', label: 'Integrations', Icon: Plug },
  { to: '/admin/mailflow', label: 'Mail flow', Icon: RouteIcon },
  { to: '/admin/activity', label: 'Activity', Icon: Activity },
  { to: '/admin/settings', label: 'Settings', Icon: Settings },
];

function AdminLayout() {
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="shrink-0 border-b border-border bg-surface md:w-56 md:border-r md:border-b-0">
        <nav className="scroll-thin flex gap-1 overflow-x-auto p-2 md:flex-col md:p-3">
          {items.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
                  isActive ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="inboxes" element={<InboxesPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="domains" element={<DomainsPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="mailflow" element={<MailFlowPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
    </Routes>
  );
}
