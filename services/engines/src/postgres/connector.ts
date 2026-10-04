import { Client } from 'pg';
import type {
  ConfigValidation,
  DiscoverReport,
  EngineConnector,
  EngineTarget,
  HealthReport,
  QuerySession,
} from '../types';
import { validateTarget } from '../validate';

export type SessionOpener = (target: EngineTarget) => Promise<QuerySession>;

const VERSION_SQL = `SELECT current_setting('server_version') AS version, pg_is_in_recovery() AS in_recovery, (SELECT count(*)::int FROM pg_stat_activity) AS connections`;
const DATABASES_SQL = `SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname`;

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
}

export const POSTGRES_HEALTH_SQL = VERSION_SQL;
export const POSTGRES_DATABASES_SQL = DATABASES_SQL;
