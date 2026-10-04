export type EngineKind = 'postgresql' | 'mysql' | 'mariadb';

export type InstanceRole = 'primary' | 'replica' | 'unknown';

export interface EngineTarget {
  host: string;
  port: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  timeoutMs?: number;
}

export interface HealthReport {
  ok: boolean;
  engine: EngineKind;
  version?: string;
  role?: InstanceRole;
  latencyMs: number;
  details: Record<string, unknown>;
  error?: string;
}

export interface DiscoverReport {
  version: string;
  databases: string[];
}

export interface ConfigValidation {
  valid: boolean;
  issues: string[];
}

export interface QuerySession {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface MetricSnapshot {
  connections: number;
  maxConnections?: number;
  sizeBytes?: number | null;
  replicationLagMs?: number | null;
  role?: InstanceRole;
}

export interface BackupDatabase {
  name: string;
  sizeBytes: number | null;
}

export interface BackupManifest {
  format: 'dbase-manifest-v1';
  engine: EngineKind;
  version?: string;
  databases: BackupDatabase[];
  capturedAt: string;
}

export interface HardeningFinding {
  checkId: string;
  severity: 'high' | 'medium' | 'low';
  passed: boolean;
  detail: string;
}

export interface EngineConnector {
  readonly kind: EngineKind;
  readonly implemented: boolean;
  init(): Promise<void>;
  shutdown(): Promise<void>;
  health(target: EngineTarget): Promise<HealthReport>;
  discover(target: EngineTarget): Promise<DiscoverReport>;
  validateConfig(target: EngineTarget): Promise<ConfigValidation>;
  metrics?(target: EngineTarget): Promise<MetricSnapshot>;
  backup?(target: EngineTarget): Promise<BackupManifest>;
  harden?(target: EngineTarget): Promise<HardeningFinding[]>;
  promote?(target: EngineTarget): Promise<{ detail: string }>;
  rotatePassword?(target: EngineTarget, nextPassword: string): Promise<void>;
}

export function assertIdentifier(value: string, label = 'username'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new ConnectorError(`${label} must be a simple identifier`);
  }
  return value;
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}
