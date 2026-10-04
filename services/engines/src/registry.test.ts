import { describe, expect, it } from 'vitest';
import { ConnectorRegistry, createDefaultRegistry } from './registry';
import { PlaceholderConnector } from './placeholder';
import { ConnectorError } from './types';
import type { EngineConnector } from './types';

class TrackingConnector implements EngineConnector {
  readonly kind = 'postgresql' as const;
  readonly implemented = true;
  inits = 0;
  shutdowns = 0;

  async init(): Promise<void> {
    this.inits += 1;
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }

  async health() {
    return { ok: true, engine: this.kind, latencyMs: 0, details: {} };
  }

  async discover() {
    return { version: 'test', databases: [] };
  }

  async validateConfig() {
    return { valid: true, issues: [] };
  }
}

describe('ConnectorRegistry', () => {
  it('initializes and shuts down every registered plugin', async () => {
    const registry = new ConnectorRegistry();
    const postgres = new TrackingConnector();
    const mysql = new PlaceholderConnector('mysql');
    registry.register(postgres);
    registry.register(mysql);

    await registry.initAll();
    expect(registry.isInitialized).toBe(true);
    expect(postgres.inits).toBe(1);

    await registry.shutdownAll();
    expect(registry.isInitialized).toBe(false);
    expect(postgres.shutdowns).toBe(1);
  });

  it('describes implementation status and rejects unknown kinds', () => {
    const registry = createDefaultRegistry();
    expect(registry.describe()).toEqual([
      { kind: 'postgresql', implemented: true },
      { kind: 'mysql', implemented: true },
      { kind: 'mariadb', implemented: true },
    ]);
    expect(() => registry.get('cockroach' as 'mysql')).toThrow(ConnectorError);
  });

  it('placeholder health explains that the plugin is not implemented', async () => {
    const mysql = new PlaceholderConnector('mysql');
    const report = await mysql.health({ host: 'db', port: 3306, username: 'root' });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/not implemented/);
  });
});
