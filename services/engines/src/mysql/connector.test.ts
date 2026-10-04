import { describe, expect, it, vi } from 'vitest';
import { MysqlConnector, MYSQL_HEALTH_SQL } from './connector';
import type { QuerySession } from '../types';

function session(responder: (sql: string) => { rows: Record<string, unknown>[] } | Promise<{ rows: Record<string, unknown>[] }>): QuerySession {
  return {
    query: vi.fn(async (sql: string) => responder(sql)),
    end: vi.fn(async () => undefined),
  };
}

describe('MysqlConnector', () => {
  it('reports a primary from read_only = 0', async () => {
    const connector = new MysqlConnector('mysql', async () =>
      session((sql) => {
        expect(sql).toBe(MYSQL_HEALTH_SQL);
        return { rows: [{ version: '8.4.0', read_only: 0, connections: 3 }] };
      }),
    );
    const report = await connector.health({ host: 'db', port: 3306, username: 'warden' });
    expect(report.ok).toBe(true);
    expect(report.role).toBe('primary');
    expect(report.version).toBe('8.4.0');
  });

  it('reads replication lag and flags an insecure transport', async () => {
    const connector = new MysqlConnector('mysql', async () =>
      session((sql) => {
        if (sql.startsWith('SHOW REPLICA')) return { rows: [{ Seconds_Behind_Source: 2 }] };
        if (sql.includes('require_secure_transport')) return { rows: [{ Value: 'OFF' }] };
        if (sql.includes('local_infile')) return { rows: [{ Value: 'OFF' }] };
        if (sql.includes('VERSION()')) return { rows: [{ version: '8.4.0' }] };
        return { rows: [{ connections: 12, max_connections: 100, read_only: 1, size_bytes: 50 }] };
      }),
    );
    const metrics = await connector.metrics({ host: 'db', port: 3306, username: 'warden' });
    expect(metrics.replicationLagMs).toBe(2000);
    expect(metrics.role).toBe('replica');
    const findings = await connector.harden({ host: 'db', port: 3306, username: 'warden' });
    expect(findings.find((finding) => finding.checkId === 'require_secure_transport')?.passed).toBe(false);
  });

  it('rotates a password with a quoted statement', async () => {
    const queries: string[] = [];
    const connector = new MysqlConnector('mysql', async () =>
      session((sql) => {
        queries.push(sql);
        return { rows: [] };
      }),
    );
    await connector.rotatePassword({ host: 'db', port: 3306, username: 'warden', password: 'old-password' }, "new'pass");
    expect(queries.at(-1)).toBe(`ALTER USER warden@'%' IDENTIFIED BY 'new''pass'`);
  });
});
