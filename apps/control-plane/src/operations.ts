import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConnectorRegistry, EngineTarget, HealthReport } from '@dbase-warden/engines';
import { ConnectorError } from '@dbase-warden/engines';
import { AppError } from './errors';
import type { JobRecord, Store } from './store';

const execFileAsync = promisify(execFile);

const JOB_TYPES = [
  'engine.health',
  'engine.validate',
  'engine.discover',
  'engine.metrics',
  'engine.backup',
  'engine.restore',
  'engine.harden',
  'engine.control',
  'engine.promote',
  'server.sync',
  'secret.rotate',
] as const;
export type EngineJobType = (typeof JOB_TYPES)[number];

export interface OperationDeps {
  backupDir: string;
  processController: ProcessController;
}

export interface ProcessController {
  run(action: 'start' | 'stop' | 'restart', unit: string): Promise<{ executed: boolean; detail: string }>;
}

export function plannedProcessController(): ProcessController {
  return {
    async run(action, unit) {
      assertUnit(unit);
      return { executed: false, detail: `planned: systemctl ${action} ${unit}` };
    },
  };
}

export function systemProcessController(): ProcessController {
  return {
    async run(action, unit) {
      assertUnit(unit);
      await execFileAsync('systemctl', [action, unit]);
      return { executed: true, detail: `systemctl ${action} ${unit}` };
    },
  };
}

function assertUnit(unit: string): void {
  if (!/^[A-Za-z0-9@._:-]+$/.test(unit)) {
    throw new AppError(400, 'serviceUnit may contain only letters, numbers, and @ . _ : -');
  }
}

export function isEngineJobType(value: string): value is EngineJobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

function targetFor(store: Store, engineId: string): EngineTarget {
  const engine = store.getEngine(engineId);
  return {
    host: engine.host,
    port: engine.port,
    database: engine.databaseName || undefined,
    username: engine.username || undefined,
    password: store.getEngineSecret(engineId) || undefined,
  };
}

function connectorFor(store: Store, registry: ConnectorRegistry, engineId: string) {
  const engine = store.getEngine(engineId);
  try {
    return { engine, connector: registry.get(engine.kind) };
  } catch (error) {
    if (error instanceof ConnectorError) throw new AppError(400, error.message);
    throw error;
  }
}

export async function runEngineJob(
  store: Store,
  registry: ConnectorRegistry,
  input: {
    type: EngineJobType;
    actor: string;
    engineId?: string;
    serverId?: string;
    clusterId?: string;
    action?: 'start' | 'stop' | 'restart';
    password?: string;
    apply?: boolean;
    backupId?: string;
  },
  deps: OperationDeps,
): Promise<JobRecord> {
  const targetId = input.engineId || input.serverId || input.clusterId || '';
  const job = store.createJob({
    type: input.type,
    actor: input.actor,
    targetType: input.serverId && !input.engineId ? 'server' : input.clusterId && input.type === 'engine.promote' ? 'cluster' : 'engine',
    targetId,
    payload: {
      engineId: input.engineId,
      serverId: input.serverId,
      clusterId: input.clusterId,
      action: input.action,
      apply: input.apply,
      backupId: input.backupId,
    },
  });
  store.markJobRunning(job.id);
  try {
    const result = await dispatch(store, registry, input, deps);
    store.audit({
      actor: input.actor,
      action: input.type,
      resourceType: job.targetType ?? 'engine',
      resourceId: targetId,
      detail: summarize(result),
    });
    store.catalog.recordEvent({
      source: input.type,
      severity: 'info',
      message: summarize(result),
      resourceType: job.targetType ?? 'engine',
      resourceId: targetId,
    });
    return store.finishJob(job.id, { status: 'succeeded', result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Job failed';
    store.audit({
      actor: input.actor,
      action: input.type,
      resourceType: job.targetType ?? 'engine',
      resourceId: targetId,
      detail: `failed: ${message}`,
    });
    store.catalog.recordEvent({
      source: input.type,
      severity: 'warning',
      message,
      resourceType: job.targetType ?? 'engine',
      resourceId: targetId,
    });
    return store.finishJob(job.id, { status: 'failed', error: message });
  }
}

async function dispatch(
  store: Store,
  registry: ConnectorRegistry,
  input: {
    type: EngineJobType;
    actor: string;
    engineId?: string;
    serverId?: string;
    clusterId?: string;
    action?: 'start' | 'stop' | 'restart';
    password?: string;
    apply?: boolean;
    backupId?: string;
  },
  deps: OperationDeps,
): Promise<Record<string, unknown>> {
  if (input.type === 'server.sync') {
    if (!input.serverId) throw new AppError(400, 'serverId is required');
    if (!store.listServers().some((server) => server.id === input.serverId)) throw new AppError(404, 'Server not found');
    const engines = store.listEnginesForServer(input.serverId);
    const results = [];
    for (const engine of engines) {
      results.push(await collectEngine(store, registry, engine.id));
    }
    return { engines: results.length, results };
  }
  if (!input.engineId && input.type !== 'engine.promote') throw new AppError(400, 'engineId is required');
  if (input.type === 'engine.promote') {
    if (!input.clusterId || !input.engineId) throw new AppError(400, 'clusterId and engineId are required');
    const { connector } = connectorFor(store, registry, input.engineId);
    if (!connector.promote) throw new AppError(400, 'connector cannot promote');
    const promoted = await connector.promote(targetFor(store, input.engineId));
    const cluster = store.promoteMember(input.clusterId, input.engineId);
    return { detail: promoted.detail, members: cluster.members };
  }
  const engineId = input.engineId!;
  if (input.type === 'engine.health' || input.type === 'engine.metrics' || input.type === 'engine.discover' || input.type === 'engine.validate') {
    if (input.type === 'engine.health') return collectHealth(store, registry, engineId);
    if (input.type === 'engine.metrics') return collectMetrics(store, registry, engineId);
    if (input.type === 'engine.validate') return collectValidation(store, registry, engineId);
    return collectDiscover(store, registry, engineId);
  }
  if (input.type === 'engine.backup') return collectBackup(store, registry, engineId, input.actor, deps.backupDir);
  if (input.type === 'engine.restore') return restoreBackup(store, engineId, input.backupId);
  if (input.type === 'engine.harden') return collectHardening(store, registry, engineId);
  if (input.type === 'engine.control') return controlEngine(store, engineId, input.action, deps.processController);
  return rotateSecret(store, registry, engineId, input.actor, input.password, input.apply);
}

async function collectEngine(store: Store, registry: ConnectorRegistry, engineId: string): Promise<Record<string, unknown>> {
  let health: Record<string, unknown>;
  try {
    health = await collectHealth(store, registry, engineId);
  } catch (error) {
    health = { ok: false, error: error instanceof Error ? error.message : 'health failed' };
  }
  let metrics: Record<string, unknown> = {};
  try {
    metrics = await collectMetrics(store, registry, engineId);
  } catch (error) {
    metrics = { error: error instanceof Error ? error.message : 'metrics failed' };
  }
  return { engineId, health, metrics };
}

async function collectHealth(store: Store, registry: ConnectorRegistry, engineId: string): Promise<Record<string, unknown>> {
  const { connector } = connectorFor(store, registry, engineId);
  const health = await connector.health(targetFor(store, engineId));
  store.recordEngineHealth(engineId, health);
  const observation = {
    ok: health.ok,
    connections: Number(health.details.connections ?? 0),
    role: health.role,
  };
  store.catalog.recordMetrics(engineId, observation);
  store.catalog.evaluateObservation(engineId, observation);
  if (!health.ok) throw new Error(health.error || 'health check failed');
  return publicHealth(health);
}

async function collectMetrics(store: Store, registry: ConnectorRegistry, engineId: string): Promise<Record<string, unknown>> {
  const { connector } = connectorFor(store, registry, engineId);
  if (!connector.metrics) throw new AppError(400, 'connector does not collect metrics');
  const metrics = await connector.metrics(targetFor(store, engineId));
  const observation = { ok: true, ...metrics };
  const saved = store.catalog.recordMetrics(engineId, observation);
  store.catalog.evaluateObservation(engineId, observation);
  return { ...saved };
}

async function collectValidation(store: Store, registry: ConnectorRegistry, engineId: string): Promise<Record<string, unknown>> {
  const { connector } = connectorFor(store, registry, engineId);
  const validation = await connector.validateConfig(targetFor(store, engineId));
  if (!validation.valid) throw new Error(validation.issues.join('; '));
  return { valid: true, issues: [] };
}

async function collectDiscover(store: Store, registry: ConnectorRegistry, engineId: string): Promise<Record<string, unknown>> {
  const { connector } = connectorFor(store, registry, engineId);
  const discovered = await connector.discover(targetFor(store, engineId));
  return { version: discovered.version, databases: discovered.databases };
}

async function collectBackup(
  store: Store,
  registry: ConnectorRegistry,
  engineId: string,
  actor: string,
  backupDir: string,
): Promise<Record<string, unknown>> {
  const { connector, engine } = connectorFor(store, registry, engineId);
  if (!connector.backup) throw new AppError(400, 'connector does not support backup');
  const manifest = await connector.backup(targetFor(store, engineId));
  fs.mkdirSync(backupDir, { recursive: true });
  const artifactPath = path.join(backupDir, `${engine.id}-${Date.now()}.json`);
  fs.writeFileSync(artifactPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const backup = store.catalog.saveBackup({
    engineId,
    status: 'succeeded',
    format: manifest.format,
    artifactPath,
    actor,
  });
  store.catalog.evaluateBackupAge(engineId);
  return { backupId: backup.id, format: manifest.format, databases: manifest.databases.length, artifactPath };
}

function restoreBackup(store: Store, engineId: string, backupId: string | undefined): Record<string, unknown> {
  if (!backupId) throw new AppError(400, 'backupId is required');
  const backup = store.catalog.getBackup(backupId);
  if (backup.engineId !== engineId) throw new AppError(400, 'Backup belongs to a different engine');
  const manifest = JSON.parse(fs.readFileSync(backup.artifactPath, 'utf8')) as { format?: string; engine?: string; databases?: unknown[] };
  if (manifest.format !== 'dbase-manifest-v1') throw new AppError(400, 'Unsupported backup format');
  const engine = store.getEngine(engineId);
  if (manifest.engine !== engine.kind) throw new AppError(400, 'Backup engine kind does not match');
  return {
    verified: true,
    restored: false,
    format: manifest.format,
    databases: manifest.databases?.length ?? 0,
    note: 'Catalog manifest verified. A logical dump artifact is required before data files can be restored.',
  };
}

async function collectHardening(store: Store, registry: ConnectorRegistry, engineId: string): Promise<Record<string, unknown>> {
  const { connector } = connectorFor(store, registry, engineId);
  if (!connector.harden) throw new AppError(400, 'connector does not support hardening checks');
  const findings = await connector.harden(targetFor(store, engineId));
  const saved = store.catalog.replaceFindings(engineId, findings);
  return { findings: saved, violations: store.catalog.evaluatePolicies().filter((item) => item.engineId === engineId) };
}

async function controlEngine(
  store: Store,
  engineId: string,
  action: 'start' | 'stop' | 'restart' | undefined,
  processController: ProcessController,
): Promise<Record<string, unknown>> {
  if (!action || !['start', 'stop', 'restart'].includes(action)) throw new AppError(400, 'action must be start, stop, or restart');
  const engine = store.getEngine(engineId);
  if (!engine.serviceUnit) throw new AppError(400, 'serviceUnit is required before start, stop, or restart');
  const result = await processController.run(action, engine.serviceUnit);
  return { action, ...result };
}

async function rotateSecret(
  store: Store,
  registry: ConnectorRegistry,
  engineId: string,
  actor: string,
  password: string | undefined,
  apply: boolean | undefined,
): Promise<Record<string, unknown>> {
  if (!password || password.length < 8) throw new AppError(400, 'password must be at least 8 characters');
  if (apply) {
    const { connector } = connectorFor(store, registry, engineId);
    if (!connector.rotatePassword) throw new AppError(400, 'connector cannot apply a password change');
    await connector.rotatePassword(targetFor(store, engineId), password);
  }
  store.setEngineSecret(engineId, password);
  store.catalog.recordSecretVersion(engineId, actor, Boolean(apply));
  return { rotated: true, applied: Boolean(apply), credentialRef: store.getEngine(engineId).credentialRef };
}

function publicHealth(health: HealthReport): Record<string, unknown> {
  return {
    ok: health.ok,
    engine: health.engine,
    version: health.version,
    role: health.role,
    latencyMs: health.latencyMs,
    details: health.details,
    error: health.error,
  };
}

function summarize(result: Record<string, unknown>): string {
  if (typeof result.detail === 'string') return result.detail;
  if (typeof result.error === 'string') return result.error;
  if (result.valid === true) return 'valid';
  if (Array.isArray(result.databases)) return `${result.databases.length} databases`;
  if (typeof result.version === 'string') return result.version;
  if (typeof result.backupId === 'string') return `backup ${result.backupId}`;
  if (result.rotated === true) return result.applied ? 'password applied and stored' : 'password stored';
  if (typeof result.engines === 'number') return `${result.engines} engines synced`;
  return 'ok';
}
