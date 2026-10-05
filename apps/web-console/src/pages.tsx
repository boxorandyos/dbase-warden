import { FormEvent, ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, AuditRecord, ClusterRecord, ConnectorInfo, EngineRecord, getToken, JobRecord, ServerRecord } from './api';
import { StatusDot } from './chrome';
import { inEnvironment, useEnvironment } from './env';
import { useI18n } from './i18n';

function canWrite(role: string): boolean {
  return role === 'admin' || role === 'moderator';
}

export function DashboardPage() {
  const { t } = useI18n();
  const environment = useEnvironment();
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api<ServerRecord[]>('/api/v1/servers') });
  const engines = useQuery({ queryKey: ['engines'], queryFn: () => api<EngineRecord[]>('/api/v1/engines') });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api<JobRecord[]>('/api/v1/jobs') });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<Array<{ status: string }>>('/api/v1/alerts') });
  const connectors = useQuery({ queryKey: ['connectors'], queryFn: () => api<ConnectorInfo[]>('/api/v1/connectors') });
  const serverRows = inEnvironment(servers.data, environment.id);
  const engineRows = inEnvironment(engines.data, environment.id);
  const healthy = engineRows.filter((engine) => engine.lastHealth?.ok).length;
  const firing = alerts.data?.filter((alert) => alert.status === 'firing').length ?? 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label={t("Servers")} value={servers.isSuccess ? serverRows.length : undefined} />
        <Stat label={t("Engines")} value={engines.isSuccess ? engineRows.length : undefined} />
        <Stat label={t("Healthy")} value={engines.isSuccess ? healthy : undefined} />
        <Stat label={t("Firing alerts")} value={alerts.isSuccess ? firing : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("Connectors")}>
          <ul className="divide-y divide-border">
            {connectors.data?.map((connector) => (
              <li key={connector.kind} className="flex items-center justify-between py-3 text-sm">
                <span className="font-medium capitalize">{connector.kind}</span>
                <Badge tone={connector.implemented ? 'ok' : 'muted'}>{connector.implemented ? t("Ready") : t("Registered")}</Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("Recent jobs")}>
          <JobList jobs={jobs.data?.slice(0, 5) ?? []} />
        </Card>
      </div>
    </div>
  );
}

export function ServersPage({
  role }: { role: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const environment = useEnvironment();
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api<ServerRecord[]>('/api/v1/servers') });
  const rows = inEnvironment(servers.data, environment.id);
  const sync = useMutation({
    mutationFn: (serverId: string) => api(`/api/v1/jobs`, { method: 'POST', body: JSON.stringify({ type: 'server.sync', serverId }) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['engines'] });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const create = useMutation({
    mutationFn: (body: { name: string; hostname: string; description: string }) =>
      api('/api/v1/servers', { method: 'POST', body: JSON.stringify({ ...body, environmentId: environment.id }) }),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-4">
      <Toolbar title={t("Registered hosts")} action={canWrite(role) ? t("Register server") : undefined} onAction={() => setOpen(true)} />
      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            <tr>
              <th className="py-2">{t("Name")}</th>
              <th>{t("Hostname")}</th>
              <th>{t("SSH")}</th>
              <th>{t("Notes")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((server) => (
              <tr key={server.id} className="border-t border-border">
                <td className="py-3 font-medium">{server.name}</td>
                <td className="font-mono text-xs">{server.hostname}</td>
                <td>{server.sshPort}</td>
                <td className="text-muted-foreground">{server.description}</td>
                <td className="text-right">
                  {canWrite(role) && (
                    <button className="border border-foreground/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]" onClick={() => sync.mutate(server.id)}>
                      {t("Sync")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty label={t("No servers registered yet.")} />}
      </Card>
      {open && (
        <Modal title={t("Register server")} onClose={() => setOpen(false)}>
          <ServerForm
            error={error}
            pending={create.isPending}
            onSubmit={(body) => {
              setError('');
              create.mutate(body);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export function EnginesPage({
  role }: { role: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const environment = useEnvironment();
  const engines = useQuery({ queryKey: ['engines'], queryFn: () => api<EngineRecord[]>('/api/v1/engines') });
  const rows = inEnvironment(engines.data, environment.id);
  const [open, setOpen] = useState(false);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');

  const create = useMutation({
    mutationFn: (body: Record<string, string | number>) =>
      api('/api/v1/engines', { method: 'POST', body: JSON.stringify({ ...body, environmentId: environment.id }) }),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['engines'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const probe = useMutation({
    mutationFn: (id: string) => api(`/api/v1/engines/${id}/health`, { method: 'POST' }),
    onSuccess: async () => {
      setActionError('');
      setNotice(t("Health recorded"));
      await queryClient.invalidateQueries({ queryKey: ['engines'] });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: async (err: Error) => {
      setNotice('');
      setActionError(err.message);
      await queryClient.invalidateQueries({ queryKey: ['engines'] });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const job = useMutation({
    mutationFn: (body: Record<string, string | boolean>) => api<JobRecord>(`/api/v1/jobs`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async (record) => {
      setRotateId(null);
      setActionError('');
      setNotice(jobNotice(record, t));
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
      await queryClient.invalidateQueries({ queryKey: ['findings'] });
      await queryClient.invalidateQueries({ queryKey: ['engines'] });
    },
    onError: async (err: Error) => {
      setNotice('');
      setActionError(err.message);
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  return (
    <div className="space-y-4">
      <Toolbar title={t("Engine instances")} action={canWrite(role) ? t("Add engine") : undefined} onAction={() => setOpen(true)} />
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            <tr>
              <th className="py-2">{t("Name")}</th>
              <th>{t("Kind")}</th>
              <th>{t("Endpoint")}</th>
              <th>{t("Version")}</th>
              <th>{t("Health")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((engine) => (
              <tr key={engine.id} className="border-t border-border">
                <td className="py-3 font-medium">{engine.name}</td>
                <td className="capitalize">{engine.kind}</td>
                <td className="font-mono text-xs">
                  {engine.host}:{engine.port}
                </td>
                <td>{engine.version ?? '—'}</td>
                <td>
                  <span className="inline-flex items-center gap-2">
                    <StatusDot ok={engine.lastHealth ? engine.lastHealth.ok : null} />
                    {engine.lastHealth ? (engine.lastHealth.ok ? engine.lastHealth.role ?? 'ok' : t('failed')) : t('unknown')}
                  </span>
                </td>
                <td className="text-right">
                  {canWrite(role) && (
                    <div className="flex flex-wrap justify-end gap-1">
                      {(['engine.health', 'engine.metrics', 'engine.discover', 'engine.validate', 'engine.backup', 'engine.harden'] as const).map((type) => (
                        <button
                          key={type}
                          className="border border-foreground/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                          onClick={() => (type === 'engine.health' ? probe.mutate(engine.id) : job.mutate({ type, engineId: engine.id }))}
                          disabled={probe.isPending || job.isPending}
                        >
                          {engineActionLabel(type, t)}
                        </button>
                      ))}
                      {engine.serviceUnit &&
                        (['start', 'stop', 'restart'] as const).map((action) => (
                          <button
                            key={action}
                            className="border border-foreground/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                            onClick={() => job.mutate({ type: 'engine.control', engineId: engine.id, action })}
                            disabled={job.isPending}
                          >
                            {t(action)}
                          </button>
                        ))}
                      {role === 'admin' && (
                        <button
                          className="border border-foreground/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                          onClick={() => setRotateId(engine.id)}
                        >
                          {t("Rotate")}
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty label={t("No engine instances yet.")} />}
      </Card>
      {open && (
        <Modal title={t("Add engine")} onClose={() => setOpen(false)}>
          <EngineForm
            error={error}
            pending={create.isPending}
            onSubmit={(body) => {
              setError('');
              create.mutate(body);
            }}
          />
        </Modal>
      )}
      {rotateId && (
        <Modal title={t("Rotate password")} onClose={() => setRotateId(null)}>
          <form
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setNotice('');
              setActionError('');
              job.mutate({
                type: 'secret.rotate',
                engineId: rotateId,
                password: String(data.get('password') ?? ''),
                apply: data.get('apply') === 'on',
              });
            }}
          >
            <Field label={t("New password")}>
              <input name="password" type="password" required minLength={8} className={inputClass} />
            </Field>
            <label className="mb-4 flex items-center gap-2 text-sm">
              <input name="apply" type="checkbox" />
              {t("Apply on the engine")}
            </label>
            <p className="mb-3 text-xs text-muted-foreground">{t("Apply runs ALTER ROLE or ALTER USER. Leaving it off stores a new local secret version only.")}</p>
            {actionError && <p className="mb-3 text-sm text-destructive">{actionError}</p>}
            <button disabled={job.isPending} className="h-11 w-full bg-primary text-sm font-semibold text-primary-foreground">
              {t("Rotate")}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function engineActionLabel(type: string, t: (key: string) => string): string {
  if (type === 'engine.health') return t("Probe");
  if (type === 'engine.metrics') return t("Metrics");
  if (type === 'engine.discover') return t("Discover");
  if (type === 'engine.validate') return t("Validate");
  if (type === 'engine.backup') return t("Backup");
  return t("Scan");
}

function jobNotice(record: JobRecord, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const result = record.result ?? {};
  if (typeof result.detail === 'string') return result.detail;
  if (result.rotated === true) return result.applied ? t("Password applied and stored") : t("Password stored");
  if (typeof result.backupId === 'string') return t("Backup catalog written");
  if (Array.isArray(result.databases)) return t("databases.discovered", { count: result.databases.length });
  if (result.valid === true) return t("Configuration valid");
  if (typeof result.connections === 'number') return t("connections.count", { count: result.connections });
  return t("Completed");
}

export function ClustersPage({
  role }: { role: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const environment = useEnvironment();
  const clusters = useQuery({ queryKey: ['clusters'], queryFn: () => api<ClusterRecord[]>('/api/v1/clusters') });
  const engines = useQuery({ queryKey: ['engines'], queryFn: () => api<EngineRecord[]>('/api/v1/engines') });
  const clusterRows = inEnvironment(clusters.data, environment.id);
  const engineRows = inEnvironment(engines.data, environment.id);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const create = useMutation({
    mutationFn: (body: { name: string; kind: string }) =>
      api('/api/v1/clusters', { method: 'POST', body: JSON.stringify({ ...body, environmentId: environment.id }) }),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['clusters'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const addMember = useMutation({
    mutationFn: (body: { clusterId: string; engineId: string; role: string }) =>
      api(`/api/v1/clusters/${body.clusterId}/members`, {
        method: 'POST',
        body: JSON.stringify({ engineId: body.engineId, role: body.role }),
      }),
    onSuccess: async () => {
      setError('');
      await queryClient.invalidateQueries({ queryKey: ['clusters'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const promote = useMutation({
    mutationFn: (body: { clusterId: string; engineId: string }) =>
      api('/api/v1/jobs', { method: 'POST', body: JSON.stringify({ type: 'engine.promote', ...body }) }),
    onSuccess: async () => {
      setError('');
      await queryClient.invalidateQueries({ queryKey: ['clusters'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-4">
      <Toolbar title={t("Topologies")} action={canWrite(role) ? t("Create cluster") : undefined} onAction={() => setOpen(true)} />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-4">
        {clusterRows.map((cluster) => (
          <Card key={cluster.id} title={`${cluster.name} · ${cluster.kind}`}>
            <ul className="space-y-2 text-sm">
              {cluster.members.map((member) => (
                <li key={member.engineId} className="flex items-center justify-between gap-3 border border-border px-3 py-2">
                  <span>{member.engineName}</span>
                  <span className="flex items-center gap-2">
                    <span className="uppercase tracking-[0.14em] text-muted-foreground">{member.role}</span>
                    {canWrite(role) && member.role !== 'primary' && (
                      <button
                        className="border border-foreground/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                        onClick={() => promote.mutate({ clusterId: cluster.id, engineId: member.engineId })}
                      >
                        Promote
                      </button>
                    )}
                  </span>
                </li>
              ))}
              {cluster.members.length === 0 && <Empty label={t("No members yet.")} />}
            </ul>
            {canWrite(role) && (
              <MemberForm
                engines={engineRows.filter((engine) => engine.kind === cluster.kind)}
                onSubmit={(engineId, memberRole) => addMember.mutate({ clusterId: cluster.id, engineId, role: memberRole })}
              />
            )}
          </Card>
        ))}
        {clusterRows.length === 0 && (
          <Card>
            <Empty label={t("No clusters defined yet.")} />
          </Card>
        )}
      </div>
      {open && (
        <Modal title={t("Create cluster")} onClose={() => setOpen(false)}>
          <ClusterForm
            error={error}
            pending={create.isPending}
            onSubmit={(body) => {
              setError('');
              create.mutate(body);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export function JobsPage() {
  const { t } = useI18n();
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api<JobRecord[]>('/api/v1/jobs') });
  return (
    <Card title={t("Operation history")}>
      <JobList jobs={jobs.data ?? []} />
      {jobs.data?.length === 0 && <Empty label={t("No jobs have run yet.")} />}
    </Card>
  );
}

export function AuditPage() {
  const { t } = useI18n();
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api<AuditRecord[]>('/api/v1/audit') });
  async function download() {
    const response = await fetch('/api/v1/audit/export?format=csv', { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'dbase-audit.csv';
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="h-10 border border-foreground/15 px-3 text-xs font-semibold uppercase tracking-[0.14em]" onClick={() => void download()}>
          {t("Export CSV")}
        </button>
      </div>
    <Card title={t("Audit log")}>
      <table className="w-full text-sm">
        <thead className="text-left text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          <tr>
            <th className="py-2">{t("When")}</th>
            <th>{t("Actor")}</th>
            <th>{t("Action")}</th>
            <th>{t("Detail")}</th>
          </tr>
        </thead>
        <tbody>
          {audit.data?.map((entry) => (
            <tr key={entry.id} className="border-t border-border">
              <td className="py-3 font-mono text-xs">{entry.createdAt.replace('T', ' ').slice(0, 19)}</td>
              <td>{entry.actor}</td>
              <td>{entry.action}</td>
              <td className="text-muted-foreground">{entry.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {audit.data?.length === 0 && <Empty label={t("No audit events yet.")} />}
    </Card>
    </div>
  );
}

export function UsersPage({
  role }: { role: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<Array<{ id: string; username: string; role: string }>>('/api/v1/users'),
    enabled: role === 'admin',
  });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const create = useMutation({
    mutationFn: (body: { username: string; password: string; role: string }) =>
      api('/api/v1/users', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (role !== 'admin') {
    return (
      <Card title={t("User Management")}>
        <p className="text-sm text-muted-foreground">{t("Only admins can manage operators.")}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Toolbar title={t("Operators")} action={t("Add user")} onAction={() => setOpen(true)} />
      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            <tr>
              <th className="py-2">{t("Username")}</th>
              <th>{t("Role")}</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((user) => (
              <tr key={user.id} className="border-t border-border">
                <td className="py-3 font-medium">{user.username}</td>
                <td className="uppercase tracking-[0.14em]">{user.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {open && (
        <Modal title={t("Add user")} onClose={() => setOpen(false)}>
          <UserForm
            error={error}
            pending={create.isPending}
            onSubmit={(body) => {
              setError('');
              create.mutate(body);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export function ConnectorsPage() {
  const { t } = useI18n();
  const connectors = useQuery({ queryKey: ['connectors'], queryFn: () => api<ConnectorInfo[]>('/api/v1/connectors') });
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {connectors.data?.map((connector) => (
        <Card key={connector.kind} title={connector.kind}>
          <p className="text-sm text-muted-foreground">
            {connector.implemented
              ? t("Reference connector. Health, discovery, and config validation run against a live instance.")
              : t("Plugin is registered in the lifecycle and will reject probes until an implementation lands.")}
          </p>
          <div className="mt-4">
            <Badge tone={connector.implemented ? 'ok' : 'muted'}>{connector.implemented ? t("Implemented") : t("Placeholder")}</Badge>
          </div>
        </Card>
      ))}
    </div>
  );
}

function JobList({
  jobs }: { jobs: JobRecord[] }) {
  if (jobs.length === 0) return null;
  return (
    <ul className="divide-y divide-border text-sm">
      {jobs.map((job) => (
        <li key={job.id} className="flex items-center justify-between gap-3 py-3">
          <div>
            <div className="font-medium">{job.type}</div>
            <div className="text-xs text-muted-foreground">{job.actor}</div>
          </div>
          <Badge tone={job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'bad' : 'muted'}>{job.status}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-semibold">{value ?? '—'}</div>
    </div>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="border border-border bg-card p-4">
      {title && <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{title}</h2>}
      {children}
    </section>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone: 'ok' | 'bad' | 'muted' }) {
  const color = tone === 'ok' ? 'bg-secondary text-secondary-foreground' : tone === 'bad' ? 'bg-destructive text-white' : 'bg-muted text-muted-foreground';
  return <span className={`px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${color}`}>{children}</span>;
}

function Empty({ label }: { label: string }) {
  return <p className="py-6 text-sm text-muted-foreground">{label}</p>;
}

function Toolbar({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {action && onAction && (
        <button className="h-10 bg-primary px-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4">
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md border border-border bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-[0.16em]">{title}</h3>
          <button onClick={onClose} className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
            {t("Close")}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputClass = 'h-11 w-full border border-input bg-background px-3 text-sm font-normal normal-case tracking-normal text-foreground outline-none';

function ServerForm({
  onSubmit,
  error,
  pending,
}: {
  onSubmit: (body: { name: string; hostname: string; description: string }) => void;
  error: string;
  pending: boolean;
}) {
  const { t } = useI18n();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({
      name: String(data.get('name') ?? ''),
      hostname: String(data.get('hostname') ?? ''),
      description: String(data.get('description') ?? ''),
    });
  }
  return (
    <form onSubmit={submit}>
      <Field label={t("Name")}>
        <input name="name" required className={inputClass} />
      </Field>
      <Field label={t("Hostname")}>
        <input name="hostname" required className={inputClass} />
      </Field>
      <Field label={t("Description")}>
        <input name="description" className={inputClass} />
      </Field>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <button disabled={pending} className="h-11 w-full bg-primary text-sm font-semibold text-primary-foreground">
        {t("Save")}
      </button>
    </form>
  );
}

function EngineForm({
  onSubmit,
  error,
  pending,
}: {
  onSubmit: (body: Record<string, string | number>) => void;
  error: string;
  pending: boolean;
}) {
  const { t } = useI18n();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({
      name: String(data.get('name') ?? ''),
      kind: String(data.get('kind') ?? 'postgresql'),
      host: String(data.get('host') ?? ''),
      port: Number(data.get('port') ?? 5432),
      databaseName: String(data.get('databaseName') ?? ''),
      username: String(data.get('username') ?? ''),
      password: String(data.get('password') ?? ''),
      serviceUnit: String(data.get('serviceUnit') ?? ''),
    });
  }
  return (
    <form onSubmit={submit}>
      <Field label={t("Name")}>
        <input name="name" required className={inputClass} />
      </Field>
      <Field label={t("Kind")}>
        <select name="kind" className={inputClass} defaultValue="postgresql">
          <option value="postgresql">PostgreSQL</option>
          <option value="mysql">MySQL</option>
          <option value="mariadb">MariaDB</option>
        </select>
      </Field>
      <Field label={t("Host")}>
        <input name="host" required className={inputClass} />
      </Field>
      <Field label={t("Port")}>
        <input name="port" type="number" defaultValue={5432} className={inputClass} />
      </Field>
      <Field label={t("Database")}>
        <input name="databaseName" className={inputClass} />
      </Field>
      <Field label={t("Username")}>
        <input name="username" className={inputClass} />
      </Field>
      <Field label={t("Password")}>
        <input name="password" type="password" className={inputClass} />
      </Field>
      <Field label={t("Service unit")}>
        <input name="serviceUnit" placeholder="postgresql" className={inputClass} />
      </Field>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <button disabled={pending} className="h-11 w-full bg-primary text-sm font-semibold text-primary-foreground">
        {t("Save")}
      </button>
    </form>
  );
}

function ClusterForm({
  onSubmit,
  error,
  pending,
}: {
  onSubmit: (body: { name: string; kind: string }) => void;
  error: string;
  pending: boolean;
}) {
  const { t } = useI18n();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({ name: String(data.get('name') ?? ''), kind: String(data.get('kind') ?? 'postgresql') });
  }
  return (
    <form onSubmit={submit}>
      <Field label={t("Name")}>
        <input name="name" required className={inputClass} />
      </Field>
      <Field label={t("Kind")}>
        <select name="kind" className={inputClass} defaultValue="postgresql">
          <option value="postgresql">PostgreSQL</option>
          <option value="mysql">MySQL</option>
          <option value="mariadb">MariaDB</option>
        </select>
      </Field>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <button disabled={pending} className="h-11 w-full bg-primary text-sm font-semibold text-primary-foreground">
        {t("Save")}
      </button>
    </form>
  );
}

function MemberForm({
  engines, onSubmit }: { engines: EngineRecord[]; onSubmit: (engineId: string, role: string) => void }) {
  const { t } = useI18n();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit(String(data.get('engineId') ?? ''), String(data.get('role') ?? 'replica'));
  }
  if (engines.length === 0) return null;
  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap gap-2">
      <select name="engineId" className="h-10 border border-input bg-background px-2 text-sm">
        {engines.map((engine) => (
          <option key={engine.id} value={engine.id}>
            {engine.name}
          </option>
        ))}
      </select>
      <select name="role" className="h-10 border border-input bg-background px-2 text-sm" defaultValue="replica">
        <option value="primary">primary</option>
        <option value="replica">replica</option>
        <option value="witness">witness</option>
      </select>
      <button className="h-10 border border-foreground/15 px-3 text-xs font-semibold uppercase tracking-[0.14em]">{t("Add member")}</button>
    </form>
  );
}

function UserForm({
  onSubmit,
  error,
  pending,
}: {
  onSubmit: (body: { username: string; password: string; role: string }) => void;
  error: string;
  pending: boolean;
}) {
  const { t } = useI18n();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({
      username: String(data.get('username') ?? ''),
      password: String(data.get('password') ?? ''),
      role: String(data.get('role') ?? 'viewer'),
    });
  }
  return (
    <form onSubmit={submit}>
      <Field label={t("Username")}>
        <input name="username" required className={inputClass} />
      </Field>
      <Field label={t("Password")}>
        <input name="password" type="password" required minLength={8} className={inputClass} />
      </Field>
      <Field label={t("Role")}>
        <select name="role" className={inputClass} defaultValue="viewer">
          <option value="viewer">viewer</option>
          <option value="moderator">moderator</option>
          <option value="admin">admin</option>
        </select>
      </Field>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <button disabled={pending} className="h-11 w-full bg-primary text-sm font-semibold text-primary-foreground">
        {t("Save")}
      </button>
    </form>
  );
}
