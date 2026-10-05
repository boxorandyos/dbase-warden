import { ReactNode, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Activity, BarChart3, Bell, BookOpen, Cable, Database, HardDrive, LogOut, ScrollText, Server, ShieldCheck, UserRound, Users, Waypoints, Wrench } from 'lucide-react';
import type { ApiUser } from './api';
import { setToken } from './api';
import { Brand, MenuButton, MobileNav, ThemeIcon, useTheme } from './chrome';
import { useEnvironment } from './env';
import { useI18n } from './i18n';

const sections = [
  { id: 'pulse', label: 'pulse', path: '/dashboard' },
  {
    id: 'estate',
    label: 'estate',
    items: [
      { path: '/servers', label: 'servers', icon: Server },
      { path: '/engines', label: 'engines', icon: Database },
      { path: '/clusters', label: 'clusters', icon: Waypoints },
      { path: '/environments', label: 'environments', icon: Server },
      { path: '/connectors', label: 'connectors', icon: Cable },
    ],
  },
  {
    id: 'signals',
    label: 'signals',
    items: [
      { path: '/alerts', label: 'alerts', icon: Bell },
      { path: '/events', label: 'events', icon: Activity },
      { path: '/metrics', label: 'metrics', icon: BarChart3 },
    ],
  },
  {
    id: 'fleet',
    label: 'fleet',
    items: [
      { path: '/users', label: 'users', icon: Users },
      { path: '/service-accounts', label: 'serviceAccounts', icon: Users },
      { path: '/identity', label: 'identity', icon: ShieldCheck },
      { path: '/nodes', label: 'nodes', icon: Server },
      { path: '/maintenance', label: 'maintenance', icon: Wrench },
      { path: '/snapshots', label: 'snapshots', icon: HardDrive },
      { path: '/backups', label: 'backups', icon: HardDrive },
      { path: '/jobs', label: 'jobs', icon: Activity },
      { path: '/runbooks', label: 'runbooks', icon: BookOpen },
      { path: '/findings', label: 'hardening', icon: ShieldCheck },
      { path: '/audit', label: 'audit', icon: ScrollText },
    ],
  },
] as const;

const titles: Record<string, string> = {
  dashboard: 'pulse',
  servers: 'servers',
  engines: 'engines',
  clusters: 'clusters',
  jobs: 'jobs',
  audit: 'audit',
  users: 'users',
  connectors: 'connectors',
  alerts: 'alerts',
  events: 'events',
  metrics: 'metrics',
  backups: 'backups',
  runbooks: 'runbooks',
  findings: 'hardening',
  maintenance: 'maintenance',
  nodes: 'nodes',
  account: 'account',
  identity: 'identity',
  snapshots: 'snapshots',
  environments: 'environments',
  'service-accounts': 'serviceAccounts',
};

export function Shell({ user, children }: { user: ApiUser; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [dark, toggleTheme] = useTheme();
  const { lang, toggle, t } = useI18n();
  const [mobile, setMobile] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const environment = useEnvironment();
  const segment = location.pathname.split('/').filter(Boolean)[0] ?? 'dashboard';
  const title = t(`nav.${titles[segment] ?? 'pulse'}`);

  function logout() {
    setToken(null);
    navigate('/login', { replace: true });
    window.location.assign('/login');
  }

  const adminOnly = new Set(user.role === 'admin' ? [] : ['/users', '/service-accounts', '/maintenance', '/identity', '/snapshots', '/nodes']);
  const links = (
    <nav className="flex flex-col gap-1 md:flex-row md:items-center md:gap-1">
      {sections.map((section) =>
        'path' in section ? (
          <NavLink
            key={section.id}
            to={section.path}
            onClick={() => setMobile(false)}
            className={({ isActive }) => navClass(isActive)}
          >
            {t(`nav.${section.label}`)}
          </NavLink>
        ) : (
          <div
            key={section.id}
            className="relative"
            onMouseEnter={() => setOpenMenu(section.id)}
            onMouseLeave={() => setOpenMenu(null)}
          >
            <button
              className={navClass(section.items.some((item) => location.pathname.startsWith(item.path)))}
              onClick={() => setOpenMenu(openMenu === section.id ? null : section.id)}
            >
              {t(`nav.${section.label}`)}
            </button>
            {openMenu === section.id && (
              <div className="z-40 min-w-[12rem] border border-foreground/10 bg-popover p-1 md:absolute md:left-0 md:top-full">
                <div className="border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  {t(`nav.${section.label}`)}
                </div>
                {section.items.filter((item) => !adminOnly.has(item.path)).map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      onClick={() => {
                        setOpenMenu(null);
                        setMobile(false);
                      }}
                      className={({ isActive }) =>
                        `flex items-center gap-2 px-2 py-2 text-sm ${isActive ? 'bg-foreground/[0.07] font-medium' : ''}`
                      }
                    >
                      <Icon className="h-4 w-4 opacity-70" />
                      {t(`nav.${item.label}`)}
                    </NavLink>
                  );
                })}
              </div>
            )}
          </div>
        ),
      )}
    </nav>
  );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center border-b border-foreground/10 bg-background/95 backdrop-blur-sm">
        <div className="flex w-full items-center gap-3 px-3 md:px-5">
          <MenuButton onClick={() => setMobile(true)} />
          <Brand />
          <div className="ml-4 hidden md:block">{links}</div>
          <div className="ml-auto flex items-center gap-2">
            {environment.environments.length > 0 && (
              <select
                aria-label={t('aria.environment')}
                className="h-10 border border-foreground/15 bg-background px-2 text-xs uppercase tracking-[0.14em]"
                value={environment.id}
                onChange={(event) => environment.setId(event.target.value)}
              >
                {environment.environments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
            <button className="border border-transparent px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground" onClick={toggle} aria-label={t('aria.language')}>
              {lang === 'en' ? 'DE' : 'EN'}
            </button>
            <button className="border border-transparent p-2 text-muted-foreground hover:text-foreground" onClick={toggleTheme} aria-label={t('aria.theme')}>
              <ThemeIcon dark={dark} />
            </button>
            <button className="border border-transparent p-2 text-muted-foreground hover:text-foreground" onClick={() => navigate('/account')} aria-label={t('nav.account')}>
              <UserRound className="h-4 w-4" />
            </button>
            <div className="hidden text-right sm:block">
              <div className="text-xs font-semibold">{user.username}</div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{user.role}</div>
            </div>
            <button className="border border-transparent p-2 text-muted-foreground hover:text-foreground" onClick={logout} aria-label={t('aria.logout')}>
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
      <MobileNav open={mobile} onClose={() => setMobile(false)}>
        {links}
      </MobileNav>
      <div className="app-canvas flex min-h-0 flex-1 flex-col border-x border-foreground/[0.06]">
        <header className="shrink-0 border-b border-foreground/10 bg-muted/20 px-4 py-3 md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em]">{title}</p>
        </header>
        <main className="flex-1 overflow-auto px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

function navClass(active: boolean): string {
  return `h-10 border px-3 text-left text-xs font-semibold uppercase tracking-[0.18em] ${
    active
      ? 'border-foreground/20 bg-foreground/[0.06] text-foreground'
      : 'border-transparent text-muted-foreground hover:border-foreground/10 hover:bg-muted/40 hover:text-foreground'
  }`;
}
