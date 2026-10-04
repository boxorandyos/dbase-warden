import mysql from 'mysql2/promise';
import type {
  BackupManifest,
  ConfigValidation,
  DiscoverReport,
  EngineConnector,
  EngineKind,
  EngineTarget,
  HardeningFinding,
  HealthReport,
  MetricSnapshot,
  QuerySession,
} from '../types';
import { assertIdentifier, sqlLiteral } from '../types';
import { validateTarget } from '../validate';

export type SessionOpener = (target: EngineTarget) => Promise<QuerySession>;

const HEALTH_SQL = `SELECT VERSION() AS version, @@read_only AS read_only, (SELECT COUNT(*) FROM information_schema.processlist) AS connections`;
const DATABASES_SQL = `SELECT schema_name AS datname FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys') ORDER BY schema_name`;
const METRICS_SQL = `SELECT (SELECT COUNT(*) FROM information_schema.processlist) AS connections, @@global.max_connections AS max_connections, @@read_only AS read_only, (SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables) AS size_bytes`;
const BACKUP_SQL = `SELECT table_schema AS datname, COALESCE(SUM(data_length + index_length), 0) AS size_bytes FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys') GROUP BY table_schema ORDER BY table_schema`;

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'ON';
}

function lagFrom(rows: Record<string, unknown>[]): number | null {
  const row = rows[0];
  if (!row) return null;
  const raw = row.Seconds_Behind_Source ?? row.Seconds_Behind_Master;
  if (raw == null) return null;
  const lag = Number(raw);
  return Number.isFinite(lag) ? lag * 1000 : null;
}

export async function openMysqlSession(target: EngineTarget): Promise<QuerySession> {
  const connection = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.username,
    password: target.password,
    database: target.database || undefined,
    connectTimeout: target.timeoutMs ?? 5000,
    ssl: target.ssl ? { rejectUnauthorized: true } : undefined,
  });
  return {
    query: async (sql) => {
      const [rows] = await connection.query(sql);
      return { rows: (Array.isArray(rows) ? rows : []) as Record<string, unknown>[] };
    },
    end: () => connection.end(),
  };
}

export class MysqlConnector implements EngineConnector {
  readonly implemented = true;

  constructor(
    readonly kind: Extract<EngineKind, 'mysql' | 'mariadb'> = 'mysql',
    private readonly open: SessionOpener = openMysqlSession,
  ) {}

  async init(): Promise<void> {}

  async shutdown(): Promise<void> {}

  async validateConfig(target: EngineTarget): Promise<ConfigValidation> {
    return validateTarget(target, 3306);
  }

  async health(target: EngineTarget): Promise<HealthReport> {
    const started = Date.now();
    const validation = await this.validateConfig(target);
    if (!validation.valid) {
      return {
        ok: false,
        engine: this.kind,
        latencyMs: Date.now() - started,
        details: { issues: validation.issues },
        error: validation.issues.join('; '),
      };
    }
    let session: QuerySession | undefined;
    try {
      session = await this.open(target);
      const result = await session.query(HEALTH_SQL);
      const row = result.rows[0] ?? {};
      const version = row.version != null ? String(row.version) : undefined;
      return {
        ok: true,
        engine: this.kind,
        version,
        role: asBoolean(row.read_only) ? 'replica' : 'primary',
        latencyMs: Date.now() - started,
        details: { connections: Number(row.connections ?? 0) },
      };
    } catch (error) {
      return {
        ok: false,
        engine: this.kind,
        latencyMs: Date.now() - started,
        details: {},
        error: error instanceof Error ? error.message : 'MySQL health check failed',
      };
    } finally {
      await session?.end().catch(() => undefined);
    }
  }

  async discover(target: EngineTarget): Promise<DiscoverReport> {
    const session = await this.openValid(target);
    try {
      const version = await session.query('SELECT VERSION() AS version');
      const databases = await session.query(DATABASES_SQL);
      return {
        version: String(version.rows[0]?.version ?? ''),
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
      let replicationLagMs: number | null = null;
      try {
        replicationLagMs = lagFrom((await session.query('SHOW REPLICA STATUS')).rows);
      } catch {
        try {
          replicationLagMs = lagFrom((await session.query('SHOW SLAVE STATUS')).rows);
        } catch {
          replicationLagMs = null;
        }
      }
      return {
        connections: Number(row.connections ?? 0),
        maxConnections: Number(row.max_connections ?? 0),
        sizeBytes: Number(row.size_bytes ?? 0),
        replicationLagMs,
        role: asBoolean(row.read_only) ? 'replica' : 'primary',
      };
    } finally {
      await session.end();
    }
  }

  async backup(target: EngineTarget): Promise<BackupManifest> {
    const session = await this.openValid(target);
    try {
      const version = await session.query('SELECT VERSION() AS version');
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
      const secure = await session.query(`SHOW VARIABLES LIKE 'require_secure_transport'`);
      const infile = await session.query(`SHOW VARIABLES LIKE 'local_infile'`);
      const version = await session.query('SELECT VERSION() AS version');
      const secureOn = String(secure.rows[0]?.Value ?? '').toUpperCase() === 'ON';
      const infileOff = String(infile.rows[0]?.Value ?? '').toUpperCase() === 'OFF';
      const versionText = String(version.rows[0]?.version ?? '');
      const familyOk = this.kind === 'mariadb' ? /mariadb/i.test(versionText) : !/mariadb/i.test(versionText);
      return [
        {
          checkId: 'require_secure_transport',
          severity: 'high',
          passed: secureOn,
          detail: secureOn ? 'require_secure_transport is ON' : 'require_secure_transport is OFF',
        },
        {
          checkId: 'local_infile',
          severity: 'medium',
          passed: infileOff,
          detail: infileOff ? 'local_infile is OFF' : 'local_infile is ON',
        },
        {
          checkId: 'engine_family',
          severity: 'low',
          passed: familyOk,
          detail: versionText || 'version unavailable',
        },
      ];
    } finally {
      await session.end();
    }
  }

  async promote(): Promise<{ detail: string }> {
    return { detail: `${this.kind} promotion is recorded; switch read_only on the replica using the server's orchestration` };
  }

  async rotatePassword(target: EngineTarget, nextPassword: string): Promise<void> {
    if (!target.username) throw new Error('username is required to rotate a password');
    if (nextPassword.length < 8) throw new Error('password must be at least 8 characters');
    const session = await this.openValid(target);
    try {
      const user = assertIdentifier(target.username);
      await session.query(`ALTER USER ${user}@'%' IDENTIFIED BY ${sqlLiteral(nextPassword)}`);
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

export const MYSQL_HEALTH_SQL = HEALTH_SQL;
export const MYSQL_DATABASES_SQL = DATABASES_SQL;
