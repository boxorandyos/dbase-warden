import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

interface SessionRow {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
}

interface Provider {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

interface SnapshotRow {
  id: string;
  actor: string;
  createdAt: string;
}

export function AccountPage() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<SessionRow[]>('/api/v1/auth/sessions') });
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const setup = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUrl: string }>('/api/v1/auth/2fa/setup', { method: 'POST', body: '{}' }),
    onSuccess: (result) => {
      setSecret(result.secret);
      setError('');
    },
    onError: (err: Error) => setError(err.message),
  });
  const enable = useMutation({
    mutationFn: (code: string) => api('/api/v1/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) }),
    onSuccess: () => setMessage('MFA enabled'),
    onError: (err: Error) => setError(err.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const password = useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api('/api/v1/auth/first-login/change-password', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => setMessage('Password updated'),
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-4">
      <section className="border border-border bg-card p-4">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Password</h2>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            password.mutate({ currentPassword: String(data.get('current') ?? ''), newPassword: String(data.get('next') ?? '') });
          }}
        >
          <input name="current" type="password" required placeholder="Current password" className="h-10 border border-input bg-background px-3 text-sm" />
          <input name="next" type="password" required minLength={8} placeholder="New password" className="h-10 border border-input bg-background px-3 text-sm" />
          <button className="h-10 bg-primary px-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground">Save</button>
        </form>
      </section>
      <section className="border border-border bg-card p-4">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Authenticator</h2>
        <button className="h-10 border border-foreground/15 px-3 text-xs font-semibold uppercase tracking-[0.14em]" onClick={() => setup.mutate()}>
          Generate secret
        </button>
        {secret && <p className="mt-3 font-mono text-sm">{secret}</p>}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            enable.mutate(String(data.get('code') ?? ''));
          }}
        >
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" required placeholder="6-digit code" className="h-10 border border-input bg-background px-3 text-sm" />
          <button className="h-10 bg-primary px-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground">Enable</button>
        </form>
      </section>
      <section className="border border-border bg-card p-4">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Sessions</h2>
        {sessions.data?.map((session) => (
          <div key={session.id} className="flex items-center justify-between gap-3 border-b border-border py-2 text-sm">
            <span>
              {session.ip} · {session.createdAt}
            </span>
            <button className="text-xs uppercase tracking-[0.14em]" onClick={() => revoke.mutate(session.id)}>
              Revoke
            </button>
          </div>
        ))}
        <button className="mt-3 text-xs uppercase tracking-[0.14em]" onClick={() => api('/api/v1/auth/logout-all', { method: 'POST', body: '{}' }).then(() => queryClient.invalidateQueries({ queryKey: ['sessions'] }))}>
          Sign out other sessions
        </button>
      </section>
      {message && <p className="text-sm">{message}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function IdentityPage() {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Provider[]>('/api/v1/identity/providers') });
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: (body: { name: string; type: string; config: Record<string, string> }) =>
      api('/api/v1/identity/providers', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
    onError: (err: Error) => setError(err.message),
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const type = String(data.get('type') ?? 'ldap');
    save.mutate({
      name: String(data.get('name') ?? ''),
      type,
      config:
        type === 'ldap'
          ? { url: String(data.get('url') ?? ''), searchBase: String(data.get('searchBase') ?? ''), bindDn: String(data.get('bindDn') ?? '') }
          : { issuer: String(data.get('issuer') ?? ''), clientId: String(data.get('clientId') ?? ''), redirectUrl: String(data.get('redirectUrl') ?? '') },
    });
  }
  return (
    <div className="space-y-4">
      <section className="border border-border bg-card p-4">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Providers</h2>
        {providers.data?.map((provider) => (
          <p key={provider.id} className="border-b border-border py-2 text-sm">
            {provider.name} · {provider.type}
          </p>
        ))}
        {providers.data?.length === 0 && <p className="text-sm text-muted-foreground">No directory providers yet.</p>}
      </section>
      <form className="grid gap-2 border border-border bg-card p-4 md:grid-cols-2" onSubmit={onSubmit}>
        <input name="name" required placeholder="Name" className="h-10 border border-input bg-background px-3 text-sm" />
        <select name="type" className="h-10 border border-input bg-background px-3 text-sm">
          <option value="ldap">ldap</option>
          <option value="oidc">oidc</option>
        </select>
        <input name="url" placeholder="LDAP URL" className="h-10 border border-input bg-background px-3 text-sm" />
        <input name="searchBase" placeholder="Search base" className="h-10 border border-input bg-background px-3 text-sm" />
        <input name="bindDn" placeholder="Bind DN" className="h-10 border border-input bg-background px-3 text-sm" />
        <input name="issuer" placeholder="OIDC issuer" className="h-10 border border-input bg-background px-3 text-sm" />
        <input name="clientId" placeholder="OIDC client id" className="h-10 border border-input bg-background px-3 text-sm" />
        <input name="redirectUrl" placeholder="OIDC redirect URL" className="h-10 border border-input bg-background px-3 text-sm" />
        <button className="h-10 bg-primary px-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground">Save provider</button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function MetricsPage() {
  const metrics = useQuery({ queryKey: ['metrics'], queryFn: () => api<Record<string, unknown>>('/api/v1/metrics') });
  return (
    <section className="border border-border bg-card p-4">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Platform</h2>
      <pre className="overflow-auto text-xs">{JSON.stringify(metrics.data ?? {}, null, 2)}</pre>
    </section>
  );
}

export function SnapshotsPage() {
  const queryClient = useQueryClient();
  const snapshots = useQuery({ queryKey: ['snapshots'], queryFn: () => api<SnapshotRow[]>('/api/v1/platform/snapshots') });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const create = useMutation({
    mutationFn: () => api('/api/v1/platform/snapshots', { method: 'POST', body: '{}' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['snapshots'] }),
    onError: (err: Error) => setError(err.message),
  });
  const apply = useMutation({
    mutationFn: (id: string) => api(`/api/v1/platform/snapshots/${id}/apply`, { method: 'POST', body: '{}' }),
    onError: (err: Error) => setError(err.message),
  });
  const sync = useMutation({
    mutationFn: () => api<unknown[]>('/api/v1/platform/sync', { method: 'POST', body: '{}' }),
    onSuccess: (result) => setNotice(`${result.length} slaves contacted`),
    onError: (err: Error) => setError(err.message),
  });
  return (
    <section className="border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Platform document</h2>
        <div className="flex gap-2">
          <button className="h-10 border border-foreground/15 px-3 text-xs font-semibold uppercase tracking-[0.14em]" onClick={() => sync.mutate()}>
            Push to slaves
          </button>
          <button className="h-10 bg-primary px-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground" onClick={() => create.mutate()}>
            Capture
          </button>
        </div>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">Environments, runbooks, alert rules, and policies.</p>
      {snapshots.data?.map((snapshot) => (
        <div key={snapshot.id} className="flex items-center justify-between border-b border-border py-2 text-sm">
          <span>
            {snapshot.createdAt} · {snapshot.actor}
          </span>
          <button className="text-xs uppercase tracking-[0.14em]" onClick={() => apply.mutate(snapshot.id)}>
            Apply
          </button>
        </div>
      ))}
      {notice && <p className="mt-3 text-sm text-muted-foreground">{notice}</p>}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </section>
  );
}

export function PasswordChange({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState('');
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api('/api/v1/auth/first-login/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: String(data.get('current') ?? ''), newPassword: String(data.get('next') ?? '') }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed');
    }
  }
  return (
    <form className="mx-auto mt-24 grid max-w-md gap-3 border border-border bg-card p-6" onSubmit={onSubmit}>
      <h1 className="text-lg font-semibold">Change your password</h1>
      <input name="current" type="password" required className="h-10 border border-input bg-background px-3 text-sm" placeholder="Current password" />
      <input name="next" type="password" required minLength={8} className="h-10 border border-input bg-background px-3 text-sm" placeholder="New password" />
      <button className="h-10 bg-primary text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground">Continue</button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
