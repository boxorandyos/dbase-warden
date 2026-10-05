import { describe, expect, it, beforeAll } from 'vitest';
import { planRuntime } from './maintenance';
import request from 'supertest';
import { ConnectorRegistry } from '@dbase-warden/engines';
import { createApp } from './app';
import { openStore, type Store } from './store';

describe('runtime plan', () => {
  it('offers Node 24 and stays planned until host updates are enabled', () => {
    expect(planRuntime('node', false).executed).toBe(false);
    expect(planRuntime('node', false).detail).toContain('upgrade-node.sh 24');
    expect(planRuntime('node', true).executed).toBe(true);
    expect(() => planRuntime('postgres', true)).toThrow(/component/);
  });
});

describe('maintenance', () => {
  let store: Store;
  const calls: Array<{ url: string; key?: string; kind?: string }> = [];

  beforeAll(() => {
    store = openStore(':memory:');
    store.createUser({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
  });

  function app(role: 'master' | 'slave' = 'master') {
    return createApp({
      store,
      registry: new ConnectorRegistry(),
      jwtSecret: 'test-secret',
      maintenance: {
        allowHostUpdate: false,
        nodeRole: role,
        maintenanceKey: 'slave-key',
        schedule: async (kind) => ({ executed: false, detail: `planned ${kind}` }),
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          const body = JSON.parse(String(init?.body ?? '{}')) as { kind?: string };
          calls.push({ url: String(url), key: headers.get('x-maintenance-key') ?? undefined, kind: body.kind });
          return new Response(JSON.stringify({ detail: 'planned product' }), { status: 202 });
        },
      },
    });
  }

  async function token(): Promise<string> {
    const response = await request(app()).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin-pass-1' });
    return response.body.data.accessToken as string;
  }

  it('plans a local product update and accepts the same job from the master key', async () => {
    const admin = await token();
    const local = await request(app()).post('/api/v1/maintenance/product').set('Authorization', `Bearer ${admin}`);
    expect(local.status).toBe(202);
    expect(local.body.data.executed).toBe(false);
    expect(local.body.data.detail).toContain('product');

    const denied = await request(app()).post('/api/v1/maintenance/apply').send({ kind: 'packages' });
    expect(denied.status).toBe(401);
    const remote = await request(app())
      .post('/api/v1/maintenance/apply')
      .set('X-Maintenance-Key', 'slave-key')
      .send({ kind: 'packages' });
    expect(remote.status).toBe(202);
    expect(remote.body.data.detail).toContain('packages');
  });

  it('registers a slave and asks it to upgrade without returning the token again', async () => {
    const admin = await token();
    const created = await request(app()).post('/api/v1/warden-nodes').set('Authorization', `Bearer ${admin}`).send({
      name: 'db-b',
      host: '10.2.0.8',
      port: 3101,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.token.startsWith('dw_')).toBe(true);

    const listed = await request(app()).get('/api/v1/warden-nodes').set('Authorization', `Bearer ${admin}`);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.data.token);

    calls.length = 0;
    const triggered = await request(app()).post('/api/v1/maintenance/slaves').set('Authorization', `Bearer ${admin}`).send({ kind: 'product' });
    expect(triggered.status).toBe(200);
    expect(calls).toEqual([
      { url: 'http://10.2.0.8:3101/api/v1/maintenance/apply', key: created.body.data.token, kind: 'product' },
    ]);
    expect(JSON.stringify(triggered.body)).not.toContain(created.body.data.token);

    const slave = await request(app('slave')).post('/api/v1/maintenance/slaves').set('Authorization', `Bearer ${admin}`).send({ kind: 'product' });
    expect(slave.status).toBe(403);
  });
});