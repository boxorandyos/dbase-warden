import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import type { EngineConnector } from '@dbase-warden/engines';
import { ConnectorRegistry } from '@dbase-warden/engines';
import { createApp } from './app';
import { openStore, type Store } from './store';

class FakePostgres implements EngineConnector {
  readonly kind = 'postgresql' as const;
  readonly implemented = true;

  async init(): Promise<void> {}
  async shutdown(): Promise<void> {}

  async health(target: { host: string }) {
    if (target.host === 'down.internal') {
      return { ok: false, engine: this.kind, latencyMs: 5, details: {}, error: 'connection refused' };
    }
    return { ok: true, engine: this.kind, version: '16.4', role: 'primary' as const, latencyMs: 4, details: { connections: 2 } };
  }

  async discover() {
    return { version: '16.4', databases: ['postgres', 'app'] };
  }

  async validateConfig(target: { host?: string; username?: string }) {
    const issues: string[] = [];
    if (!target.host) issues.push('host is required');
    if (!target.username) issues.push('username is required');
    return { valid: issues.length === 0, issues };
  }
}

class UnavailableMysql implements EngineConnector {
  readonly kind = 'mysql' as const;
  readonly implemented = false;
  async init(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async health() {
    return { ok: false, engine: this.kind, latencyMs: 0, details: {}, error: 'mysql connector is registered but not implemented' };
  }
  async discover() {
    throw new Error('mysql connector is registered but not implemented');
  }
  async validateConfig() {
    return { valid: true, issues: [] };
  }
}

describe('control plane API', () => {
  let store: Store;
  const registry = new ConnectorRegistry();
  registry.register(new FakePostgres());
  registry.register(new UnavailableMysql());
  const app = () => createApp({ store, registry, jwtSecret: 'test-secret' });

  beforeAll(() => {
    store = openStore(':memory:');
    store.createUser({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
    store.createUser({ username: 'ops', password: 'ops-pass-12', role: 'moderator' });
    store.createUser({ username: 'guest', password: 'guest-pass', role: 'viewer' });
  });

  async function token(username: string, password: string): Promise<string> {
    const response = await request(app()).post('/api/v1/auth/login').send({ username, password });
    return response.body.data.accessToken as string;
  }

  it('exposes unversioned health and versioned product info', async () => {
    const health = await request(app()).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.success).toBe(true);
    expect(health.body.message).toBe('API is running');

    const info = await request(app()).get('/api/v1/info');
    expect(info.body.data.apiVersion).toBe('v1');
    expect(info.body.data.connectors).toEqual([
      { kind: 'postgresql', implemented: true },
      { kind: 'mysql', implemented: false },
    ]);
  });

  it('rejects bad credentials and accepts a valid login', async () => {
    const denied = await request(app()).post('/api/v1/auth/login').send({ username: 'admin', password: 'nope' });
    expect(denied.status).toBe(401);
    expect(denied.body.success).toBe(false);

    const ok = await request(app()).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin-pass-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.role).toBe('admin');
    expect(ok.body.data.accessToken).toEqual(expect.any(String));
  });

  it('lets a moderator register inventory and keeps secrets out of responses', async () => {
    const ops = await token('ops', 'ops-pass-12');
    const viewer = await token('guest', 'guest-pass');

    const forbidden = await request(app()).post('/api/v1/servers').set('Authorization', `Bearer ${viewer}`).send({
      name: 'edge',
      hostname: '10.0.0.8',
    });
    expect(forbidden.status).toBe(403);

    const server = await request(app()).post('/api/v1/servers').set('Authorization', `Bearer ${ops}`).send({
      name: 'db-a',
      hostname: '10.0.0.5',
    });
    expect(server.status).toBe(201);

    const engine = await request(app()).post('/api/v1/engines').set('Authorization', `Bearer ${ops}`).send({
      name: 'orders',
      kind: 'postgresql',
      host: '10.0.0.5',
      port: 5432,
      username: 'warden',
      password: 'super-secret',
      databaseName: 'orders',
      serverId: server.body.data.id,
    });
    expect(engine.status).toBe(201);
    expect(JSON.stringify(engine.body)).not.toContain('super-secret');
    expect(engine.body.data.credentialRef).toBe(`local://${engine.body.data.id}`);

    const cluster = await request(app()).post('/api/v1/clusters').set('Authorization', `Bearer ${ops}`).send({
      name: 'orders-ha',
      kind: 'postgresql',
    });
    const member = await request(app())
      .post(`/api/v1/clusters/${cluster.body.data.id}/members`)
      .set('Authorization', `Bearer ${ops}`)
      .send({ engineId: engine.body.data.id, role: 'primary' });
    expect(member.status).toBe(201);
    expect(member.body.data.members[0].role).toBe('primary');

    const blockedDelete = await request(app()).delete(`/api/v1/servers/${server.body.data.id}`).set('Authorization', `Bearer ${ops}`);
    expect(blockedDelete.status).toBe(409);
  });

  it('records a successful health job and a failed probe', async () => {
    const ops = await token('ops', 'ops-pass-12');
    const healthy = await request(app()).post('/api/v1/engines').set('Authorization', `Bearer ${ops}`).send({
      name: 'healthy',
      kind: 'postgresql',
      host: 'db.internal',
      username: 'warden',
      password: 'pw-not-shown',
    });
    const job = await request(app())
      .post(`/api/v1/engines/${healthy.body.data.id}/health`)
      .set('Authorization', `Bearer ${ops}`);
    expect(job.status).toBe(200);
    expect(job.body.data.status).toBe('succeeded');
    expect(job.body.data.result.version).toBe('16.4');
    expect(JSON.stringify(job.body)).not.toContain('pw-not-shown');

    const listed = await request(app()).get('/api/v1/engines').set('Authorization', `Bearer ${ops}`);
    const updated = listed.body.data.find((item: { id: string }) => item.id === healthy.body.data.id);
    expect(updated.lastHealth.ok).toBe(true);
    expect(updated.version).toBe('16.4');

    const down = await request(app()).post('/api/v1/engines').set('Authorization', `Bearer ${ops}`).send({
      name: 'down',
      kind: 'postgresql',
      host: 'down.internal',
      username: 'warden',
    });
    const failed = await request(app()).post('/api/v1/jobs').set('Authorization', `Bearer ${ops}`).send({
      type: 'engine.health',
      engineId: down.body.data.id,
    });
    expect(failed.status).toBe(422);
    expect(failed.body.success).toBe(false);
    expect(failed.body.message).toBe('connection refused');
    expect(failed.body.data.status).toBe('failed');

    const audit = await request(app()).get('/api/v1/audit').set('Authorization', `Bearer ${ops}`);
    expect(audit.body.data.some((entry: { action: string }) => entry.action === 'engine.health')).toBe(true);
  });

  it('fails mysql health through the registered placeholder connector', async () => {
    const ops = await token('ops', 'ops-pass-12');
    const engine = await request(app()).post('/api/v1/engines').set('Authorization', `Bearer ${ops}`).send({
      name: 'shop',
      kind: 'mysql',
      host: 'mysql.internal',
      username: 'root',
    });
    const job = await request(app()).post('/api/v1/jobs').set('Authorization', `Bearer ${ops}`).send({
      type: 'engine.health',
      engineId: engine.body.data.id,
    });
    expect(job.status).toBe(422);
    expect(job.body.data.error).toMatch(/not implemented/);
  });

  it('restricts user administration to admins and protects the last admin', async () => {
    const admin = await token('admin', 'admin-pass-1');
    const viewer = await token('guest', 'guest-pass');
    const denied = await request(app()).get('/api/v1/users').set('Authorization', `Bearer ${viewer}`);
    expect(denied.status).toBe(403);

    const created = await request(app()).post('/api/v1/users').set('Authorization', `Bearer ${admin}`).send({
      username: 'audit',
      password: 'audit-pass',
      role: 'viewer',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.password).toBeUndefined();

    const me = await request(app()).get('/api/v1/auth/me').set('Authorization', `Bearer ${admin}`);
    const selfDelete = await request(app()).delete(`/api/v1/users/${me.body.data.id}`).set('Authorization', `Bearer ${admin}`);
    expect(selfDelete.status).toBe(409);

    const removed = await request(app()).delete(`/api/v1/users/${created.body.data.id}`).set('Authorization', `Bearer ${admin}`);
    expect(removed.status).toBe(200);
  });

  it('returns the shared not-found envelope', async () => {
    const response = await request(app()).get('/api/v1/missing');
    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });
});
