import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Download,
  FileSpreadsheet,
  Gauge,
  LogOut,
  Menu,
  Rocket,
  Settings as SettingsIcon,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const NAV = [
  { to: '/', label: 'Dashboard', icon: Gauge, end: true },
  { to: '/scrape', label: 'Scrape Leads', icon: Rocket },
  { to: '/jobs', label: 'Jobs', icon: FileSpreadsheet },
  { to: '/leads', label: 'Leads', icon: Users },
  { to: '/email-validation/option-1', label: 'Validate email list', icon: FileSpreadsheet },
  { to: '/email-validation/option-2', label: 'Validate leads CSV', icon: FileSpreadsheet },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function NavItems({ onNavigate }) {
  return (
    <nav className="flex-1 space-y-1 px-3">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              isActive
                ? 'bg-brand-600 text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`
          }
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function SidebarContent({ onNavigate }) {
  const { user, logout } = useAuth();

  return (
    <div className="flex h-full flex-col bg-slate-900">
      <div className="flex items-center gap-2 px-6 py-5">
        <div className="rounded-lg bg-brand-600 px-2 py-1 text-sm font-bold text-white">LF</div>
        <div>
          <p className="text-sm font-semibold text-white">LeadForge AI</p>
          <p className="text-xs text-slate-400">Business lead scraper</p>
        </div>
      </div>

      <NavItems onNavigate={onNavigate} />

      <div className="border-t border-slate-800 p-3">
        <div className="mb-2 px-3">
          <p className="truncate text-sm font-medium text-white">{user?.name}</p>
          <p className="truncate text-xs text-slate-400">{user?.email}</p>
        </div>
        <button
          type="button"
          onClick={logout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium
                     text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <LogOut size={18} />
          Sign out
        </button>
      </div>
    </div>
  );
}

/** Authenticated application shell: fixed sidebar + scrollable content. */
export default function Layout() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-slate-900/60"
            onClick={() => setOpen(false)}
          />
          <aside className="relative h-full w-64 shadow-xl">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
              className="absolute right-3 top-4 text-slate-400 hover:text-white"
            >
              <X size={20} />
            </button>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
          >
            <Menu size={20} />
          </button>
          <span className="font-semibold text-slate-900">LeadForge AI</span>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}