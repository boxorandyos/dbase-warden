import { FormEvent, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api, ApiUser, getToken, setToken } from './api';
import { Brand } from './chrome';
import { EnvProvider } from './env';
import { Shell } from './shell';
import { AuditPage, ClustersPage, ConnectorsPage, DashboardPage, EnginesPage, JobsPage, ServersPage, UsersPage } from './pages';
import { AccountsPage, AlertsPage, BackupsPage, EnvironmentsPage, EventsPage, FindingsPage, MaintenancePage, NodesPage, RunbooksPage } from './platform';
import { AccountPage, IdentityPage, MetricsPage, PasswordChange, SnapshotsPage } from './parity';

export function App() {
  const token = getToken();
  const me = useQuery({
    queryKey: ['me', token],
    queryFn: () => api<ApiUser>('/api/v1/auth/me'),
    enabled: Boolean(token),
  });

  if (!token) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (me.isLoading) {
    return <div className="grid min-h-screen place-items-center text-xs uppercase tracking-[0.2em] text-muted-foreground">Loading</div>;
  }

  if (!me.data) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (me.data.mustChangePassword) {
    return <PasswordChange onDone={() => window.location.assign('/dashboard')} />;
  }

  return (
    <EnvProvider>
      <Shell user={me.data}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/servers" element={<ServersPage role={me.data.role} />} />
          <Route path="/engines" element={<EnginesPage role={me.data.role} />} />
          <Route path="/clusters" element={<ClustersPage role={me.data.role} />} />
          <Route path="/environments" element={<EnvironmentsPage role={me.data.role} />} />
          <Route path="/alerts" element={<AlertsPage role={me.data.role} />} />
          <Route path="/events" element={<EventsPage role={me.data.role} />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="/nodes" element={me.data.role === 'admin' ? <NodesPage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/backups" element={<BackupsPage role={me.data.role} />} />
          <Route path="/runbooks" element={<RunbooksPage role={me.data.role} />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/users" element={me.data.role === 'admin' ? <UsersPage role={me.data.role} /> : <Navigate to="/dashboard" replace />} />
          <Route path="/service-accounts" element={me.data.role === 'admin' ? <AccountsPage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/findings" element={<FindingsPage role={me.data.role} />} />
          <Route path="/maintenance" element={me.data.role === 'admin' ? <MaintenancePage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/identity" element={me.data.role === 'admin' ? <IdentityPage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/snapshots" element={me.data.role === 'admin' ? <SnapshotsPage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/connectors" element={<ConnectorsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Shell>
    </EnvProvider>
  );
}

function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('error')) setError('Sign-in failed');
    if (params.get('challenge')) setChallenge(params.get('challenge') || '');
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const access = hash.get('accessToken');
    if (access) {
      setToken(access);
      window.location.assign('/dashboard');
    }
  }, [location.search, location.hash]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      if (challenge) {
        const verified = await api<{ accessToken: string }>('/api/v1/auth/verify-2fa', {
          method: 'POST',
          body: JSON.stringify({ challengeToken: challenge, code }),
        });
        setToken(verified.accessToken);
        navigate('/dashboard', { replace: true });
        window.location.assign('/dashboard');
        return;
      }
      const data = await api<{ accessToken?: string; challengeToken?: string; twoFactorRequired?: boolean; user: ApiUser }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (data.twoFactorRequired && data.challengeToken) {
        setChallenge(data.challengeToken);
        return;
      }
      setToken(data.accessToken || null);
      navigate('/dashboard', { replace: true });
      window.location.assign('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <section className="relative flex flex-1 flex-col justify-between overflow-hidden bg-gradient-to-br from-slate-950 via-indigo-950 to-teal-950 px-8 py-10 text-white lg:max-w-[46%] lg:px-12">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:24px_24px]" />
        <div className="relative">
          <Brand inverted />
        </div>
        <div className="relative max-w-md">
          <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-teal-200">Dbase Warden</p>
          <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight">Control plane for your data</h1>
          <p className="mt-4 text-sm leading-6 text-slate-200">
            Inventory, health, and auditable operations for PostgreSQL, MySQL, and MariaDB — from a single node to a cluster.
          </p>
          <ul className="mt-8 space-y-3 text-sm">
            {['Same console rhythm as the Warden family', 'Connector lifecycle with a PostgreSQL probe', 'Jobs and audit trail on every change'].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-teal-300" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-[10px] font-bold uppercase tracking-[0.22em] text-slate-300">Management · Monitoring · Security</p>
      </section>
      <section className="flex flex-1 items-center justify-center bg-background px-6 py-12">
        <form onSubmit={onSubmit} className="w-full max-w-md border border-border bg-card p-8 shadow-2xl shadow-primary/5">
          <h2 className="font-display text-2xl font-semibold">Dbase Warden</h2>
          <p className="mt-2 text-sm text-muted-foreground">Sign in to manage database infrastructure.</p>
          <label className="mt-6 block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Username
            <input
              className="mt-2 h-11 w-full border border-input bg-background px-3 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Password
            <input
              type="password"
              className="mt-2 h-11 w-full border border-input bg-background px-3 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          {challenge && (
            <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Authentication code
              <input
                className="mt-2 h-11 w-full border border-input bg-background px-3 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </label>
          )}
          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={pending}
            className="mt-6 h-11 w-full bg-primary text-sm font-semibold text-primary-foreground shadow-md shadow-primary/15 disabled:opacity-60"
          >
            {pending ? 'Signing in' : 'Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}

