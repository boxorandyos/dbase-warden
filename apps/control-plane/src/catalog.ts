import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors';
import type { Role } from './store';

export interface EnvironmentRecord {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface ServiceAccountRecord {
  id: string;
  name: string;
  role: Role;
  environmentId: string | null;
  createdAt: string;
}

export interface MetricRecord {
  id: string;
  engineId: string;
  collectedAt: string;
  ok: boolean;
  connections: number;
  maxConnections: number | null;
  sizeBytes: number | null;
  replicationLagMs: number | null;
  role: string | null;
}

export interface AlertRule {
  id: string;
  name: string;
  kind: 'availability' | 'connections' | 'replication_lag' | 'backup_age';
  threshold: number;
  enabled: boolean;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  engineId: string | null;
  status: 'firing' | 'resolved';
  message: string;
  firedAt: string;
  resolvedAt: string | null;
}

export interface StreamEvent {
  id: string;
  source: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
}

export interface BackupRecord {
  id: string;
  engineId: string;
  status: 'succeeded' | 'failed';
  format: string;
  artifactPath: string;
  actor: string;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface FindingRecord {
  id: string;
  engineId: string;
  checkId: string;
  severity: string;
  passed: boolean;
  detail: string;
  scannedAt: string;
}

export interface RunbookRecord {
  id: string;
  clusterId: string | null;
  environmentId: string | null;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyRecord {
  id: string;
  name: string;
  kind: string;
  threshold: number | null;
  enabled: boolean;
  environmentId: string | null;
}

export interface Observation {
  ok: boolean;
  connections?: number;
  maxConnections?: number | null;
  sizeBytes?: number | null;
  replicationLagMs?: number | null;
  role?: string | null;
}

const RULE_KINDS = ['availability', 'connections', 'replication_lag', 'backup_age'] as const;
const ROLES: Role[] = ['admin', 'moderator', 'viewer'];

function now(): string {
  return new Date().toISOString();
}

function id(): string {
  return crypto.randomUUID();
}

export class Catalog {
  constructor(private readonly db: DatabaseSync) {}

  seed(): void {
    const environments = this.db.prepare('SELECT COUNT(*) AS c FROM environments').get() as { c: number };
    if (environments.c === 0) {
      this.db
        .prepare('INSERT INTO environments (id, name, description, created_at) VALUES (?, ?, ?, ?)')
        .run('env-default', 'default', 'Initial environment', now());
    }
    const rules = this.db.prepare('SELECT COUNT(*) AS c FROM alert_rules').get() as { c: number };
    if (rules.c === 0) {
      const defaults: Array<[string, AlertRule['kind'], number]> = [
        ['Availability', 'availability', 1],
        ['Connection capacity', 'connections', 100],
        ['Replication lag', 'replication_lag', 30000],
        ['Backup age', 'backup_age', 24],
      ];
      const insert = this.db.prepare(
        'INSERT INTO alert_rules (id, name, kind, threshold, enabled, environment_id) VALUES (?, ?, ?, ?, 1, NULL)',
      );
      for (const [name, kind, threshold] of defaults) insert.run(id(), name, kind, threshold);
    }
    const policies = this.db.prepare('SELECT COUNT(*) AS c FROM policies').get() as { c: number };
    if (policies.c === 0) {
      this.db
        .prepare('INSERT INTO policies (id, name, kind, threshold, enabled, environment_id) VALUES (?, ?, ?, ?, 1, NULL)')
        .run(id(), 'Require encrypted transport', 'require_ssl', null);
    }
    const defaultId = this.defaultEnvironmentId();
    this.db.prepare('UPDATE servers SET environment_id = ? WHERE environment_id IS NULL').run(defaultId);
    this.db.prepare('UPDATE engines SET environment_id = ? WHERE environment_id IS NULL').run(defaultId);
    this.db.prepare('UPDATE clusters SET environment_id = ? WHERE environment_id IS NULL').run(defaultId);
  }

  defaultEnvironmentId(): string {
    const row = this.db.prepare('SELECT id FROM environments ORDER BY name LIMIT 1').get() as { id: string } | undefined;
    if (!row) throw new AppError(500, 'No environment is configured');
    return row.id;
  }

  listEnvironments(): EnvironmentRecord[] {
    const rows = this.db.prepare('SELECT * FROM environments ORDER BY name').all() as Array<{
      id: string;
      name: string;
      description: string;
      created_at: string;
    }>;
    return rows.map((row) => ({ id: row.id, name: row.name, description: row.description, createdAt: row.created_at }));
  }

  createEnvironment(input: { name: string; description?: string }): EnvironmentRecord {
    const name = requiredName(input.name, 'name');
    if (this.db.prepare('SELECT id FROM environments WHERE name = ?').get(name)) {
      throw new AppError(409, 'Environment name already exists');
    }
    const record: EnvironmentRecord = {
      id: id(),
      name,
      description: input.description?.trim() ?? '',
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO environments (id, name, description, created_at) VALUES (?, ?, ?, ?)')
      .run(record.id, record.name, record.description, record.createdAt);
    return record;
  }

  requireEnvironment(environmentId: string): void {
    const row = this.db.prepare('SELECT id FROM environments WHERE id = ?').get(environmentId);
    if (!row) throw new AppError(400, 'environmentId does not match an environment');
  }

  createServiceAccount(input: { name: string; role: Role; environmentId?: string | null }): ServiceAccountRecord & { token: string } {
    const name = requiredName(input.name, 'name');
    if (!ROLES.includes(input.role)) throw new AppError(400, 'Role must be admin, moderator, or viewer');
    if (this.db.prepare('SELECT id FROM service_accounts WHERE name = ?').get(name)) {
      throw new AppError(409, 'Service account name already exists');
    }
    if (input.environmentId) this.requireEnvironment(input.environmentId);
    const token = `dw_${randomBytes(24).toString('hex')}`;
    const record: ServiceAccountRecord = {
      id: id(),
      name,
      role: input.role,
      environmentId: input.environmentId ?? null,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO service_accounts (id, name, role, token_hash, environment_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(record.id, record.name, record.role, hashToken(token), record.environmentId, record.createdAt);
    return { ...record, token };
  }

  listServiceAccounts(): ServiceAccountRecord[] {
    const rows = this.db.prepare('SELECT id, name, role, environment_id, created_at FROM service_accounts ORDER BY name').all() as Array<{
      id: string;
      name: string;
      role: Role;
      environment_id: string | null;
      created_at: string;
    }>;
    return rows.map(mapAccount);
  }

  deleteServiceAccount(accountId: string): void {
    const result = this.db.prepare('DELETE FROM service_accounts WHERE id = ?').run(accountId);
    if (result.changes === 0) throw new AppError(404, 'Service account not found');
  }

  findServiceAccount(token: string): { id: string; username: string; role: Role; createdAt: string; environmentId: string | null } | null {
    if (!token.startsWith('dw_')) return null;
    const row = this.db
      .prepare('SELECT id, name, role, environment_id, created_at FROM service_accounts WHERE token_hash = ?')
      .get(hashToken(token)) as
      | { id: string; name: string; role: Role; environment_id: string | null; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      username: row.name,
      role: row.role,
      createdAt: row.created_at,
      environmentId: row.environment_id,
    };
  }

  recordSecretVersion(engineId: string, actor: string, applied: boolean): void {
    this.db
      .prepare('INSERT INTO secret_versions (id, engine_id, actor, applied, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id(), engineId, actor, applied ? 1 : 0, now());
  }

  listSecretVersions(engineId: string): Array<{ id: string; actor: string; applied: boolean; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT id, actor, applied, created_at FROM secret_versions WHERE engine_id = ? ORDER BY created_at DESC')
      .all(engineId) as Array<{ id: string; actor: string; applied: number; created_at: string }>;
    return rows.map((row) => ({ id: row.id, actor: row.actor, applied: row.applied === 1, createdAt: row.created_at }));
  }

  recordMetrics(engineId: string, observation: Observation): MetricRecord {
    const record: MetricRecord = {
      id: id(),
      engineId,
      collectedAt: now(),
      ok: observation.ok,
      connections: observation.connections ?? 0,
      maxConnections: observation.maxConnections ?? null,
      sizeBytes: observation.sizeBytes ?? null,
      replicationLagMs: observation.replicationLagMs ?? null,
      role: observation.role ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO metric_samples (
          id, engine_id, collected_at, ok, connections, max_connections, size_bytes, replication_lag_ms, role, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.engineId,
        record.collectedAt,
        record.ok ? 1 : 0,
        record.connections,
        record.maxConnections,
        record.sizeBytes,
        record.replicationLagMs,
        record.role,
        JSON.stringify(observation),
      );
    return record;
  }

  latestMetrics(engineId: string): MetricRecord | null {
    const row = this.db
      .prepare('SELECT * FROM metric_samples WHERE engine_id = ? ORDER BY collected_at DESC LIMIT 1')
      .get(engineId) as Record<string, unknown> | undefined;
    return row ? mapMetric(row) : null;
  }

  listRules(): AlertRule[] {
    const rows = this.db.prepare('SELECT * FROM alert_rules ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map(mapRule);
  }

  createRule(input: { name: string; kind: string; threshold: number }): AlertRule {
    if (!RULE_KINDS.includes(input.kind as AlertRule['kind'])) {
      throw new AppError(400, 'kind must be availability, connections, replication_lag, or backup_age');
    }
    if (!Number.isFinite(input.threshold) || input.threshold < 0) throw new AppError(400, 'threshold must be a positive number');
    const record: AlertRule = {
      id: id(),
      name: requiredName(input.name, 'name'),
      kind: input.kind as AlertRule['kind'],
      threshold: input.threshold,
      enabled: true,
    };
    this.db
      .prepare('INSERT INTO alert_rules (id, name, kind, threshold, enabled, environment_id) VALUES (?, ?, ?, ?, 1, NULL)')
      .run(record.id, record.name, record.kind, record.threshold);
    return record;
  }

  setRuleEnabled(id: string, enabled: boolean): AlertRule {
    const existing = this.listRules().find((rule) => rule.id === id);
    if (!existing) throw new AppError(404, 'Alert rule not found');
    this.db.prepare('UPDATE alert_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return { ...existing, enabled };
  }

  listAlerts(): AlertEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, r.name AS rule_name FROM alert_events e
         JOIN alert_rules r ON r.id = e.rule_id
         ORDER BY e.fired_at DESC LIMIT 200`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapAlert);
  }

  evaluateObservation(engineId: string, observation: Observation): AlertEvent[] {
    const rules = this.listRules().filter((rule) => rule.enabled && rule.kind !== 'backup_age');
    const changes: AlertEvent[] = [];
    for (const rule of rules) {
      const firing = ruleFires(rule, observation);
      changes.push(...this.setAlert(rule, engineId, firing, alertMessage(rule, observation)));
    }
    changes.push(...this.evaluateBackupAge(engineId));
    return changes;
  }

  evaluateBackupAge(engineId: string): AlertEvent[] {
    const changes: AlertEvent[] = [];
    for (const rule of this.listRules().filter((item) => item.enabled && item.kind === 'backup_age')) {
      const latest = this.db
        .prepare(`SELECT created_at FROM backups WHERE engine_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`)
        .get(engineId) as { created_at: string } | undefined;
      const ageHours = latest ? (Date.now() - Date.parse(latest.created_at)) / 36e5 : Number.POSITIVE_INFINITY;
      const firing = ageHours > rule.threshold;
      const message = latest ? `Last backup is ${ageHours.toFixed(1)}h old` : 'No successful backup';
      changes.push(...this.setAlert(rule, engineId, firing, message));
    }
    return changes;
  }

  private setAlert(rule: AlertRule, engineId: string, firing: boolean, message: string): AlertEvent[] {
    const open = this.db
      .prepare(`SELECT id FROM alert_events WHERE rule_id = ? AND engine_id = ? AND status = 'firing'`)
      .get(rule.id, engineId) as { id: string } | undefined;
    if (firing && !open) {
      const event: AlertEvent = {
        id: id(),
        ruleId: rule.id,
        ruleName: rule.name,
        engineId,
        status: 'firing',
        message,
        firedAt: now(),
        resolvedAt: null,
      };
      this.db
        .prepare(
          'INSERT INTO alert_events (id, rule_id, engine_id, status, message, fired_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        )
        .run(event.id, event.ruleId, event.engineId, event.status, event.message, event.firedAt);
      return [event];
    }
    if (!firing && open) {
      const resolvedAt = now();
      this.db.prepare(`UPDATE alert_events SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(resolvedAt, open.id);
      return [
        {
          id: open.id,
          ruleId: rule.id,
          ruleName: rule.name,
          engineId,
          status: 'resolved',
          message,
          firedAt: '',
          resolvedAt,
        },
      ];
    }
    return [];
  }

  recordEvent(input: {
    source: string;
    severity?: StreamEvent['severity'];
    message: string;
    resourceType: string;
    resourceId?: string;
  }): StreamEvent {
    const severity = input.severity ?? 'info';
    if (!['info', 'warning', 'critical'].includes(severity)) throw new AppError(400, 'severity must be info, warning, or critical');
    const record: StreamEvent = {
      id: id(),
      source: requiredName(input.source, 'source'),
      severity,
      message: requiredName(input.message, 'message'),
      resourceType: requiredName(input.resourceType, 'resourceType'),
      resourceId: input.resourceId ?? '',
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO events (id, source, severity, message, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(record.id, record.source, record.severity, record.message, record.resourceType, record.resourceId, record.createdAt);
    return record;
  }

  listEvents(): StreamEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 200').all() as Array<{
      id: string;
      source: string;
      severity: StreamEvent['severity'];
      message: string;
      resource_type: string;
      resource_id: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      severity: row.severity,
      message: row.message,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      createdAt: row.created_at,
    }));
  }

  saveBackup(input: {
    engineId: string;
    status: 'succeeded' | 'failed';
    format: string;
    artifactPath: string;
    actor: string;
    error?: string;
  }): BackupRecord {
    const record: BackupRecord = {
      id: id(),
      engineId: input.engineId,
      status: input.status,
      format: input.format,
      artifactPath: input.artifactPath,
      actor: input.actor,
      createdAt: now(),
      finishedAt: now(),
      error: input.error ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO backups (id, engine_id, status, format, artifact_path, actor, created_at, finished_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.engineId,
        record.status,
        record.format,
        record.artifactPath,
        record.actor,
        record.createdAt,
        record.finishedAt,
        record.error,
      );
    return record;
  }

  listBackups(): BackupRecord[] {
    const rows = this.db.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT 200').all() as Array<Record<string, unknown>>;
    return rows.map(mapBackup);
  }

  getBackup(backupId: string): BackupRecord {
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId) as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, 'Backup not found');
    return mapBackup(row);
  }

  replaceFindings(engineId: string, findings: Array<Omit<FindingRecord, 'id' | 'engineId' | 'scannedAt'>>): FindingRecord[] {
    const scannedAt = now();
    this.db.prepare('DELETE FROM findings WHERE engine_id = ?').run(engineId);
    const insert = this.db.prepare(
      'INSERT INTO findings (id, engine_id, check_id, severity, passed, detail, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    return findings.map((finding) => {
      const record: FindingRecord = { ...finding, id: id(), engineId, scannedAt };
      insert.run(record.id, engineId, record.checkId, record.severity, record.passed ? 1 : 0, record.detail, scannedAt);
      return record;
    });
  }

  listFindings(): FindingRecord[] {
    const rows = this.db.prepare('SELECT * FROM findings ORDER BY scanned_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      engineId: String(row.engine_id),
      checkId: String(row.check_id),
      severity: String(row.severity),
      passed: row.passed === 1,
      detail: String(row.detail),
      scannedAt: String(row.scanned_at),
    }));
  }

  listRunbooks(): RunbookRecord[] {
    const rows = this.db.prepare('SELECT * FROM runbooks ORDER BY title').all() as Array<Record<string, unknown>>;
    return rows.map(mapRunbook);
  }

  saveRunbook(input: { id?: string; title: string; body: string; clusterId?: string | null; environmentId?: string | null }): RunbookRecord {
    const title = requiredName(input.title, 'title');
    const body = input.body?.trim() ?? '';
    if (!body) throw new AppError(400, 'body is required');
    if (body.length > 20000) throw new AppError(400, 'body is too long');
    if (input.clusterId && !this.db.prepare('SELECT id FROM clusters WHERE id = ?').get(input.clusterId)) {
      throw new AppError(400, 'clusterId does not match a cluster');
    }
    const timestamp = now();
    if (input.id) {
      const existing = this.db.prepare('SELECT id, created_at FROM runbooks WHERE id = ?').get(input.id) as
        | { id: string; created_at: string }
        | undefined;
      if (!existing) throw new AppError(404, 'Runbook not found');
      this.db
        .prepare('UPDATE runbooks SET title = ?, body = ?, cluster_id = ?, environment_id = ?, updated_at = ? WHERE id = ?')
        .run(title, body, input.clusterId ?? null, input.environmentId ?? null, timestamp, input.id);
      return {
        id: input.id,
        title,
        body,
        clusterId: input.clusterId ?? null,
        environmentId: input.environmentId ?? null,
        createdAt: existing.created_at,
        updatedAt: timestamp,
      };
    }
    const record: RunbookRecord = {
      id: id(),
      title,
      body,
      clusterId: input.clusterId ?? null,
      environmentId: input.environmentId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        'INSERT INTO runbooks (id, cluster_id, environment_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(record.id, record.clusterId, record.environmentId, record.title, record.body, record.createdAt, record.updatedAt);
    return record;
  }

  listPolicies(): PolicyRecord[] {
    const rows = this.db.prepare('SELECT * FROM policies ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map(mapPolicy);
  }

  createPolicy(input: { name: string; kind: string; threshold?: number | null; environmentId?: string | null }): PolicyRecord {
    const kind = input.kind.trim();
    if (!['require_ssl', 'limit_superusers'].includes(kind)) {
      throw new AppError(400, 'kind must be require_ssl or limit_superusers');
    }
    const record: PolicyRecord = {
      id: id(),
      name: requiredName(input.name, 'name'),
      kind,
      threshold: input.threshold ?? null,
      enabled: true,
      environmentId: input.environmentId ?? null,
    };
    this.db
      .prepare('INSERT INTO policies (id, name, kind, threshold, enabled, environment_id) VALUES (?, ?, ?, ?, 1, ?)')
      .run(record.id, record.name, record.kind, record.threshold, record.environmentId);
    return record;
  }

  setPolicyEnabled(id: string, enabled: boolean): PolicyRecord {
    const existing = this.listPolicies().find((policy) => policy.id === id);
    if (!existing) throw new AppError(404, 'Policy not found');
    this.db.prepare('UPDATE policies SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return { ...existing, enabled };
  }

  evaluatePolicies(): Array<{ policyId: string; policyName: string; engineId: string; detail: string }> {
    const policies = this.listPolicies().filter((policy) => policy.enabled);
    const findings = this.listFindings();
    const violations: Array<{ policyId: string; policyName: string; engineId: string; detail: string }> = [];
    for (const policy of policies) {
      for (const finding of findings) {
        if (policy.kind === 'require_ssl' && (finding.checkId === 'ssl' || finding.checkId === 'require_secure_transport') && !finding.passed) {
          violations.push({ policyId: policy.id, policyName: policy.name, engineId: finding.engineId, detail: finding.detail });
        }
        if (policy.kind === 'limit_superusers' && finding.checkId === 'superuser_count' && !finding.passed) {
          violations.push({ policyId: policy.id, policyName: policy.name, engineId: finding.engineId, detail: finding.detail });
        }
      }
    }
    return violations;
  }

  listWardenNodes(): Array<{ id: string; name: string; host: string; port: number; createdAt: string }> {
    const rows = this.db.prepare('SELECT id, name, host, port, created_at FROM warden_nodes ORDER BY name').all() as Array<{
      id: string;
      name: string;
      host: string;
      port: number;
      created_at: string;
    }>;
    return rows.map((row) => ({ id: row.id, name: row.name, host: row.host, port: row.port, createdAt: row.created_at }));
  }

  createWardenNode(input: { name: string; host: string; port?: number }): {
    id: string;
    name: string;
    host: string;
    port: number;
    token: string;
    createdAt: string;
  } {
    const name = requiredName(input.name, 'name');
    const host = input.host?.trim() ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) throw new AppError(400, 'host is invalid');
    const port = input.port ?? 3101;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError(400, 'port is invalid');
    if (this.db.prepare('SELECT id FROM warden_nodes WHERE name = ?').get(name)) throw new AppError(409, 'Node name already exists');
    const record = {
      id: id(),
      name,
      host,
      port,
      token: `dw_${randomBytes(24).toString('hex')}`,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO warden_nodes (id, name, host, port, token, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.name, record.host, record.port, record.token, record.createdAt);
    return record;
  }

  deleteWardenNode(nodeId: string): void {
    const result = this.db.prepare('DELETE FROM warden_nodes WHERE id = ?').run(nodeId);
    if (result.changes === 0) throw new AppError(404, 'Node not found');
  }

  wardenNodesForUpgrade(nodeId?: string): Array<{ id: string; name: string; host: string; port: number; token: string }> {
    const rows = (
      nodeId
        ? this.db.prepare('SELECT id, name, host, port, token FROM warden_nodes WHERE id = ?').all(nodeId)
        : this.db.prepare('SELECT id, name, host, port, token FROM warden_nodes ORDER BY name').all()
    ) as Array<{ id: string; name: string; host: string; port: number; token: string }>;
    if (nodeId && rows.length === 0) throw new AppError(404, 'Node not found');
    return rows;
  }

  exportAudit(format: 'json' | 'csv'): string {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY created_at').all() as Array<{
      id: string;
      actor: string;
      action: string;
      resource_type: string;
      resource_id: string;
      detail: string;
      created_at: string;
    }>;
    if (format === 'json') return JSON.stringify(rows, null, 2);
    const header = 'id,actor,action,resource_type,resource_id,detail,created_at';
    const lines = rows.map((row) =>
      [row.id, row.actor, row.action, row.resource_type, row.resource_id, row.detail, row.created_at].map(csvCell).join(','),
    );
    return [header, ...lines].join('\n');
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function requiredName(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new AppError(400, `${field} is required`);
  if (trimmed.length > 200) throw new AppError(400, `${field} is too long`);
  return trimmed;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function ruleFires(rule: AlertRule, observation: Observation): boolean {
  if (rule.kind === 'availability') return !observation.ok;
  if (rule.kind === 'connections') return (observation.connections ?? 0) > rule.threshold;
  if (rule.kind === 'replication_lag') return (observation.replicationLagMs ?? 0) > rule.threshold;
  return false;
}

function alertMessage(rule: AlertRule, observation: Observation): string {
  if (rule.kind === 'availability') return observation.ok ? 'Instance is reachable' : 'Instance is unreachable';
  if (rule.kind === 'connections') return `${observation.connections ?? 0} connections`;
  if (rule.kind === 'replication_lag') return `lag ${observation.replicationLagMs ?? 0}ms`;
  return rule.name;
}

function mapAccount(row: { id: string; name: string; role: Role; environment_id: string | null; created_at: string }): ServiceAccountRecord {
  return { id: row.id, name: row.name, role: row.role, environmentId: row.environment_id, createdAt: row.created_at };
}

function mapMetric(row: Record<string, unknown>): MetricRecord {
  return {
    id: String(row.id),
    engineId: String(row.engine_id),
    collectedAt: String(row.collected_at),
    ok: row.ok === 1,
    connections: Number(row.connections ?? 0),
    maxConnections: row.max_connections == null ? null : Number(row.max_connections),
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    replicationLagMs: row.replication_lag_ms == null ? null : Number(row.replication_lag_ms),
    role: row.role == null ? null : String(row.role),
  };
}

function mapRule(row: Record<string, unknown>): AlertRule {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind) as AlertRule['kind'],
    threshold: Number(row.threshold),
    enabled: row.enabled === 1,
  };
}

function mapAlert(row: Record<string, unknown>): AlertEvent {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    ruleName: String(row.rule_name ?? ''),
    engineId: row.engine_id == null ? null : String(row.engine_id),
    status: String(row.status) as AlertEvent['status'],
    message: String(row.message),
    firedAt: String(row.fired_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
  };
}

function mapBackup(row: Record<string, unknown>): BackupRecord {
  return {
    id: String(row.id),
    engineId: String(row.engine_id),
    status: String(row.status) as BackupRecord['status'],
    format: String(row.format),
    artifactPath: String(row.artifact_path),
    actor: String(row.actor),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    error: row.error == null ? null : String(row.error),
  };
}

function mapRunbook(row: Record<string, unknown>): RunbookRecord {
  return {
    id: String(row.id),
    clusterId: row.cluster_id == null ? null : String(row.cluster_id),
    environmentId: row.environment_id == null ? null : String(row.environment_id),
    title: String(row.title),
    body: String(row.body),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPolicy(row: Record<string, unknown>): PolicyRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind),
    threshold: row.threshold == null ? null : Number(row.threshold),
    enabled: row.enabled === 1,
    environmentId: row.environment_id == null ? null : String(row.environment_id),
  };
}
