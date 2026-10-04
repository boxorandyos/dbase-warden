import type { ConnectorRegistry, EngineTarget, HealthReport } from '@dbase-warden/engines';
import { ConnectorError } from '@dbase-warden/engines';
import { AppError } from './errors';
import type { JobRecord, Store } from './store';

const JOB_TYPES = ['engine.health', 'engine.validate', 'engine.discover'] as const;
export type EngineJobType = (typeof JOB_TYPES)[number];

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

export async function runEngineJob(
  store: Store,
  registry: ConnectorRegistry,
  input: { type: EngineJobType; engineId: string; actor: string },
): Promise<JobRecord> {
  const engine = store.getEngine(input.engineId);
  let connector;
  try {
    connector = registry.get(engine.kind);
  } catch (error) {
    if (error instanceof ConnectorError) throw new AppError(400, error.message);
    throw error;
  }

  const job = store.createJob({
    type: input.type,
    actor: input.actor,
    targetType: 'engine',
    targetId: engine.id,
    payload: { engineId: engine.id, kind: engine.kind },
  });
  store.markJobRunning(job.id);

  try {
    const target = targetFor(store, engine.id);
    if (input.type === 'engine.health') {
      const health = await connector.health(target);
      store.recordEngineHealth(engine.id, health);
      store.audit({
        actor: input.actor,
        action: 'engine.health',
        resourceType: 'engine',
        resourceId: engine.id,
        detail: health.ok ? `ok ${health.version ?? ''}`.trim() : `failed: ${health.error ?? 'unknown'}`,
      });
      return store.finishJob(job.id, {
        status: health.ok ? 'succeeded' : 'failed',
        result: publicHealth(health),
        error: health.ok ? undefined : health.error,
      });
    }
    if (input.type === 'engine.validate') {
      const validation = await connector.validateConfig(target);
      store.audit({
        actor: input.actor,
        action: 'engine.validate',
        resourceType: 'engine',
        resourceId: engine.id,
        detail: validation.valid ? 'valid' : validation.issues.join('; '),
      });
      return store.finishJob(job.id, {
        status: validation.valid ? 'succeeded' : 'failed',
        result: { valid: validation.valid, issues: validation.issues },
        error: validation.valid ? undefined : validation.issues.join('; '),
      });
    }
    const discovered = await connector.discover(target);
    store.audit({
      actor: input.actor,
      action: 'engine.discover',
      resourceType: 'engine',
      resourceId: engine.id,
      detail: `${discovered.databases.length} databases`,
    });
    return store.finishJob(job.id, {
      status: 'succeeded',
      result: { version: discovered.version, databases: discovered.databases },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Job failed';
    store.audit({
      actor: input.actor,
      action: input.type,
      resourceType: 'engine',
      resourceId: engine.id,
      detail: `failed: ${message}`,
    });
    return store.finishJob(job.id, { status: 'failed', error: message });
  }
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
