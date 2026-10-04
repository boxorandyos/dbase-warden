import { FormEvent, ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useEnvironment } from './env';

interface AlertEvent {
  id: string;
  ruleName: string;
  status: string;
  message: string;
  firedAt: string;
}

interface BackupRecord {
  id: string;
  engineId: string;
  status: string;
  format: string;
  createdAt: string;
}

interface Finding {
  id: string;
  engineId: string;
  checkId: string;
  severity: string;
  passed: boolean;
  detail: string;
}

interface Runbook {
  id: string;
  title: string;
  body: string;
  clusterId: string | null;
}

interface StreamEvent {
  id: string;
  source: string;
  severity: string;
  message: string;
  createdAt: string;
}

interface ServiceAccount {
  id: string;
  name: string;
  role: string;
  environmentId: string | null;
}

export function AlertsPage() {
  const rules = useQuery({ queryKey: ['alert-rules'], queryFn: () => api<Array<{ id: string; name: string; kind: string; threshold: number }>>('/api/v1/alerts/rules') });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<AlertEvent[]>('/api/v1/alerts') });
  const firing = alerts.data?.filter((alert) => alert.status === 'firing') ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Firing">
        {firing.length === 0 && <Empty label="No firing alerts." />}
        <ul className="divide-y divide-border text-sm">
          {firing.map((alert) => (
            <li key={alert.id} className="py-3">
              <div className="font-medium">{alert.ruleName}</div>
              <div className="text-muted-foreground">{alert.message}</div>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Rules">
        <ul className="divide-y divide-border text-sm">
          {rules.data?.map((rule) => (
            <li key={rule.id} className="flex items-center justify-between py-3">
              <span>{rule.name}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {rule.kind} · {rule.threshold}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

export function BackupsPage() {
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => api<BackupRecord[]>('/api/v1/backups') });
  return (
    <Panel title="Catalog backups">
      <p className="mb-3 text-sm text-muted-foreground">Each backup is a manifest of databases and sizes. Restore verifies that manifest before any data files are touched.</p>
      <table className="w-full text-sm">
        <tbody>
          {backups.data?.map((backup) => (
            <tr key={backup.id} className="border-t border-border">
              <td className="py-3 font-mono text-xs">{backup.createdAt.replace('T', ' ').slice(0, 19)}</td>
              <td>{backup.format}</td>
              <td className="uppercase tracking-[0.14em]">{backup.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {backups.data?.length === 0 && <Empty label="No backups yet. Run one from an engine." />}
    </Panel>
  );
}

export function FindingsPage() {
  const findings = useQuery({ queryKey: ['findings'], queryFn: () => api<Finding[]>('/api/v1/findings') });
  const violations = useQuery({
    queryKey: ['violations'],
    queryFn: () => api<Array<{ policyName: string; detail: string; engineId: string }>>('/api/v1/policies/evaluate', { method: 'POST' }),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Policy violations">
        {violations.data?.length === 0 && <Empty label="No policy violations." />}
        <ul className="divide-y divide-border text-sm">
          {violations.data?.map((item, index) => (
            <li key={`${item.engineId}-${index}`} className="py-3">
              <div className="font-medium">{item.policyName}</div>
              <div className="text-muted-foreground">{item.detail}</div>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Latest checks">
        {findings.data?.length === 0 && <Empty label="Run a hardening scan from an engine." />}
        <ul className="divide-y divide-border text-sm">
          {findings.data?.map((finding) => (
            <li key={finding.id} className="flex items-center justify-between py-3">
              <span>{finding.checkId}</span>
              <span className={finding.passed ? 'text-teal-700' : 'text-destructive'}>{finding.passed ? 'pass' : finding.detail}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

export function EventsPage() {
  const events = useQuery({ queryKey: ['events'], queryFn: () => api<StreamEvent[]>('/api/v1/events') });
  return (
    <Panel title="Event stream">
      <ul className="divide-y divide-border text-sm">
        {events.data?.map((event) => (
          <li key={event.id} className="py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{event.source}</span>
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{event.severity}</span>
            </div>
            <div className="text-muted-foreground">{event.message}</div>
          </li>
        ))}
      </ul>
      {events.data?.length === 0 && <Empty label="Jobs and external adapters will land here." />}
    </Panel>
  );
}

export function RunbooksPage({ role }: { role: string }) {
  const queryClient = useQueryClient();
  const environment = useEnvironment();
  const runbooks = useQuery({ queryKey: ['runbooks'], queryFn: () => api<Runbook[]>('/api/v1/runbooks') });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: (body: { title: string; body: string; environmentId: string }) => api('/api/v1/runbooks', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['runbooks'] });
    },
    onError: (err: Error) => setError(err.message),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Disaster recovery</h2>
        {role !== 'viewer' && (
          <button className="h-10 bg-primary px-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground" onClick={() => setOpen(true)}>
            Add runbook
          </button>
        )}
      </div>
      <div className="grid gap-4">
        {runbooks.data?.map((runbook) => (
          <Panel key={runbook.id} title={runbook.title}>
            <p className="whitespace-pre-wrap text-sm">{runbook.body}</p>
          </Panel>
        ))}
        {runbooks.data?.length === 0 && (
          <Panel>
            <Empty label="No runbooks yet." />
          </Panel>
        )}
      </div>
      {open && (
        <dialog open className="fixed inset-0 z-50 grid h-full w-full place-items-center bg-foreground/40 p-4">
          <form
            className="w-full max-w-md border border-border bg-card p-6"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setError('');
              save.mutate({ title: String(data.get('title') ?? ''), body: String(data.get('body') ?? ''), environmentId: environment.id });
            }}
          >
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.16em]">Add runbook</h3>
            <input name="title" required placeholder="Title" className="mb-3 h-11 w-full border border-input bg-background px-3 text-sm" />
            <textarea name="body" required placeholder="Steps" className="mb-3 h-32 w-full border border-input bg-background px-3 py-2 text-sm" />
            {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <button className="h-11 flex-1 bg-primary text-sm font-semibold text-primary-foreground">Save</button>
              <button type="button" className="h-11 border border-foreground/15 px-4 text-sm" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}

export function AccountsPage() {
  const queryClient = useQueryClient();
  const environment = useEnvironment();
  const accounts = useQuery({ queryKey: ['service-accounts'], queryFn: () => api<ServiceAccount[]>('/api/v1/service-accounts') });
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const create = useMutation({
    mutationFn: (body: { name: string; role: string; environmentId: string }) =>
      api<ServiceAccount & { token: string }>('/api/v1/service-accounts', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async (account) => {
      setToken(account.token);
      await queryClient.invalidateQueries({ queryKey: ['service-accounts'] });
    },
    onError: (err: Error) => setError(err.message),
  });
  return (
    <div className="space-y-4">
      <Panel title="Service accounts">
        <ul className="divide-y divide-border text-sm">
          {accounts.data?.map((account) => (
            <li key={account.id} className="flex justify-between py-3">
              <span className="font-medium">{account.name}</span>
              <span className="uppercase tracking-[0.14em] text-muted-foreground">{account.role}</span>
            </li>
          ))}
        </ul>
        {accounts.data?.length === 0 && <Empty label="No service accounts yet." />}
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setError('');
            create.mutate({ name: String(data.get('name') ?? ''), role: String(data.get('role') ?? 'viewer'), environmentId: environment.id });
            event.currentTarget.reset();
          }}
        >
          <input name="name" required placeholder="name" className="h-10 border border-input bg-background px-3 text-sm" />
          <select name="role" className="h-10 border border-input bg-background px-2 text-sm" defaultValue="viewer">
            <option value="viewer">viewer</option>
            <option value="moderator">moderator</option>
            <option value="admin">admin</option>
          </select>
          <button className="h-10 bg-primary px-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground">Create</button>
        </form>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        {token && <p className="mt-3 break-all font-mono text-xs">Copy this token now. It is not shown again: {token}</p>}
      </Panel>
    </div>
  );
}

export function EnvironmentsPage({ role }: { role: string }) {
  const queryClient = useQueryClient();
  const environment = useEnvironment();
  const [error, setError] = useState('');
  const create = useMutation({
    mutationFn: (name: string) => api('/api/v1/environments', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['environments'] });
    },
    onError: (err: Error) => setError(err.message),
  });
  return (
    <Panel title="Environments">
      <ul className="divide-y divide-border text-sm">
        {environment.environments.map((item) => (
          <li key={item.id} className="flex items-center justify-between py-3">
            <span className="font-medium">{item.name}</span>
            {item.id === environment.id && <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Current</span>}
          </li>
        ))}
      </ul>
      {role === 'admin' && (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setError('');
            create.mutate(String(data.get('name') ?? ''));
            event.currentTarget.reset();
          }}
        >
          <input name="name" required placeholder="Name" className="h-10 flex-1 border border-input bg-background px-3 text-sm" />
          <button className="h-10 bg-primary px-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground">Add</button>
        </form>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </Panel>
  );
}

function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="border border-border bg-card p-4">
      {title && <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{title}</h2>}
      {children}
    </section>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="py-6 text-sm text-muted-foreground">{label}</p>;
}
