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

export interface EngineConnector {
  readonly kind: EngineKind;
  readonly implemented: boolean;
  init(): Promise<void>;
  shutdown(): Promise<void>;
  health(target: EngineTarget): Promise<HealthReport>;
  discover(target: EngineTarget): Promise<DiscoverReport>;
  validateConfig(target: EngineTarget): Promise<ConfigValidation>;
}

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}
