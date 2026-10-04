import { describe, expect, it, vi } from 'vitest';
import { PostgresConnector, POSTGRES_DATABASES_SQL, POSTGRES_HEALTH_SQL } from './connector';
import type { QuerySession } from '../types';

function session(responder: (sql: string) => { rows: Record<string, unknown>[] }): QuerySession {
  return {
    query: vi.fn(async (sql: string) => responder(sql)),
    end: vi.fn(async () => undefined),
  };
}

describe('PostgresConnector', () => {
  it('reports a primary when the server is not in recovery', async () => {
    const queries: string[] = [];
    const connector = new PostgresConnector(async () =>
      session((sql) => {
        queries.push(sql);
        return { rows: [{ version: '16.4', in_recovery: false, connections: 4 }] };
      }),
    );
    await connector.init();
    const report = await connector.health({
      host: 'db.internal',
      port: 5432,
      username: 'warden',
      password: 'secret',
    });
    expect(report.ok).toBe(true);
    expect(report.version).toBe('16.4');
    expect(report.role).toBe('primary');
    expect(report.details.connections).toBe(4);
    expect(queries[0]).toBe(POSTGRES_HEALTH_SQL);
  });

  it('reports a replica when pg_is_in_recovery is true', async () => {
    const connector = new PostgresConnector(async () =>
      session(() => ({ rows: [{ version: '16.4', in_recovery: true, connections: 1 }] })),
    );
    const report = await connector.health({ host: 'replica', port: 5432, username: 'warden' });
    expect(report.role).toBe('replica');
  });

  it('returns a failed health report when the session cannot open', async () => {
    const connector = new PostgresConnector(async () => {
      throw new Error('connection refused');
    });
    const report = await connector.health({ host: 'down', port: 5432, username: 'warden' });
    expect(report.ok).toBe(false);
    expect(report.error).toBe('connection refused');
  });

  it('lists connectable databases', async () => {
    const connector = new PostgresConnector(async () =>
      session((sql) => {
        if (sql === POSTGRES_DATABASES_SQL) {
          return { rows: [{ datname: 'app' }, { datname: 'postgres' }] };
        }
        return { rows: [{ version: '16.4' }] };
      }),
    );
    const discovered = await connector.discover({ host: 'db', port: 5432, username: 'warden' });
    expect(discovered).toEqual({ version: '16.4', databases: ['app', 'postgres'] });
  });

  it('rejects an incomplete target without opening a session', async () => {
    const open = vi.fn();
    const connector = new PostgresConnector(open);
    const report = await connector.health({ host: '', port: 5432, username: '' });
    expect(report.ok).toBe(false);
    expect(report.error).toContain('host is required');
    expect(open).not.toHaveBeenCalled();
  });
});
