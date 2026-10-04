import { Client } from 'pg';
import type {
  BackupManifest,
  ConfigValidation,
  DiscoverReport,
  EngineConnector,
  EngineTarget,
  HardeningFinding,
  HealthReport,
  MetricSnapshot,
  QuerySession,
} from '../types';
import { assertIdentifier, sqlLiteral } from '../types';
import { validateTarget } from '../validate';

export type SessionOpener = (target: EngineTarget) => Promise<QuerySession>;

const VERSION_SQL = `SELECT current_setting('server_version') AS version, pg_is_in_recovery() AS in_recovery, (SELECT count(*)::int FROM pg_stat_activity) AS connections`;
const DATABASES_SQL = `SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname`;
const METRICS_SQL = `SELECT (SELECT count(*)::int FROM pg_stat_activity) AS connections, (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections, pg_is_in_recovery() AS in_recovery, (SELECT COALESCE(SUM(pg_database_size(datname)), 0)::bigint FROM pg_database WHERE datallowconn AND NOT datistemplate) AS size_bytes, CASE WHEN pg_is_in_recovery() THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 ELSE NULL END AS replication_lag_ms`;
const BACKUP_SQL = `SELECT datname, pg_database_size(datname)::bigint AS size_bytes FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname`;
const SSL_SQL = `SHOW ssl`;
const PASSWORD_SQL = `SHOW password_encryption`;
const SUPERUSER_SQL = `SELECT count(*)::int AS superusers FROM pg_roles WHERE rolsuper`;

function asBoolean(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}

export async function openPgSession(target: EngineTarget): Promise<QuerySession> {
  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database || 'postgres',
    user: target.username,
    password: target.password,
    connectionTimeoutMillis: target.timeoutMs ?? 5000,
    ssl: target.ssl ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();
  return {
    query: async (sql) => {
      const result = await client.query(sql);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    end: () => client.end(),
  };
}

export class PostgresConnector implements EngineConnector {
  readonly kind = 'postgresql' as const;
  readonly implemented = true;
  private ready = false;

  constructor(private readonly open: SessionOpener = openPgSession) {}

  async init(): Promise<void> {
    this.ready = true;
  }

  async shutdown(): Promise<void> {
    this.ready = false;
  }

  async validateConfig(target: EngineTarget): Promise<ConfigValidation> {
    return validateTarget(target, 5432);
  }

  async health(target: EngineTarget): Promise<HealthReport> {
    const started = Date.now();
    const validation = await this.validateConfig(target);
    if (!validation.valid) {
      return {
        ok: false,
        engine: this.kind,
        latencyMs: Date.now() - started,
        details: { issues: validation.issues, initialized: this.ready },
        error: validation.issues.join('; '),
      };
    }

    let session: QuerySession | undefined;
    try {
      session = await this.open(target);
      const result = await session.query(VERSION_SQL);
      const row = result.rows[0] ?? {};
      const inRecovery = asBoolean(row.in_recovery);
      return {
        ok: true,
        engine: this.kind,
        version: row.version != null ? String(row.version) : undefined,
        role: inRecovery ? 'replica' : 'primary',
        latencyMs: Date.now() - started,
        details: {
          connections: Number(row.connections ?? 0),
          initialized: this.ready,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'PostgreSQL health check failed';
      return {
        ok: false,
        engine: this.kind,
        latencyMs: Date.now() - started,
        details: { initialized: this.ready },
        error: message,
      };
    } finally {
      await session?.end().catch(() => undefined);
    }
  }

  async discover(target: EngineTarget): Promise<DiscoverReport> {
    const validation = await this.validateConfig(target);
    if (!validation.valid) {
      throw new Error(validation.issues.join('; '));
    }
    const session = await this.open(target);
    try {
      const versionResult = await session.query(`SELECT current_setting('server_version') AS version`);
      const databases = await session.query(DATABASES_SQL);
      return {
        version: String(versionResult.rows[0]?.version ?? ''),
        databases: databases.rows.map((row) => String(row.datname)),
      };
    } finally {
      await session.end();
    }
  }

  async metrics(target: EngineTarget): Promise<MetricSnapshot> {
    const session = await this.openValid(target);
    try {
      const result = await session.query(METRICS_SQL);
      const row = result.rows[0] ?? {};
      const lag = row.replication_lag_ms == null ? null : Number(row.replication_lag_ms);
      return {
        connections: Number(row.connections ?? 0),
        maxConnections: Number(row.max_connections ?? 0),
        sizeBytes: Number(row.size_bytes ?? 0),
        replicationLagMs: Number.isFinite(lag) ? lag : null,
        role: asBoolean(row.in_recovery) ? 'replica' : 'primary',
      };
    } finally {
      await session.end();
    }
  }

  async backup(target: EngineTarget): Promise<BackupManifest> {
    const session = await this.openValid(target);
    try {
      const version = await session.query(`SELECT current_setting('server_version') AS version`);
      const databases = await session.query(BACKUP_SQL);
      return {
        format: 'dbase-manifest-v1',
        engine: this.kind,
        version: String(version.rows[0]?.version ?? ''),
        databases: databases.rows.map((row) => ({
          name: String(row.datname),
          sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
        })),
        capturedAt: new Date().toISOString(),
      };
    } finally {
      await session.end();
    }
  }

  async harden(target: EngineTarget): Promise<HardeningFinding[]> {
    const session = await this.openValid(target);
    try {
      const ssl = await session.query(SSL_SQL);
      const encryption = await session.query(PASSWORD_SQL);
      const supers = await session.query(SUPERUSER_SQL);
      const sslOn = String(ssl.rows[0]?.ssl ?? '').toLowerCase() === 'on';
      const encryptionMode = String(encryption.rows[0]?.password_encryption ?? '');
      const superusers = Number(supers.rows[0]?.superusers ?? 0);
      return [
        { checkId: 'ssl', severity: 'high', passed: sslOn, detail: sslOn ? 'ssl is on' : 'ssl is off' },
        {
          checkId: 'password_encryption',
          severity: 'high',
          passed: encryptionMode === 'scram-sha-256',
          detail: `password_encryption=${encryptionMode || 'unknown'}`,
        },
        {
          checkId: 'superuser_count',
          severity: 'medium',
          passed: superusers <= 2,
          detail: `${superusers} superuser roles`,
        },
      ];
    } finally {
      await session.end();
    }
  }

  async promote(target: EngineTarget): Promise<{ detail: string }> {
    const session = await this.openValid(target);
    try {
      await session.query('SELECT pg_promote(false)');
      return { detail: 'pg_promote issued' };
    } finally {
      await session.end();
    }
  }

  async rotatePassword(target: EngineTarget, nextPassword: string): Promise<void> {
    if (!target.username) throw new Error('username is required to rotate a password');
    if (nextPassword.length < 8) throw new Error('password must be at least 8 characters');
    const session = await this.openValid(target);
    try {
      const role = assertIdentifier(target.username);
      await session.query(`ALTER ROLE ${role} PASSWORD ${sqlLiteral(nextPassword)}`);
    } finally {
      await session.end();
    }
  }

  private async openValid(target: EngineTarget): Promise<QuerySession> {
    const validation = await this.validateConfig(target);
    if (!validation.valid) throw new Error(validation.issues.join('; '));
    return this.open(target);
  }
}

export const POSTGRES_HEALTH_SQL = VERSION_SQL;
export const POSTGRES_DATABASES_SQL = DATABASES_SQL;
export const POSTGRES_METRICS_SQL = METRICS_SQL;
export const POSTGRES_BACKUP_SQL = BACKUP_SQL;
