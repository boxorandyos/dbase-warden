import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import type { EngineConnector } from '@dbase-warden/engines';
import { ConnectorRegistry } from '@dbase-warden/engines';
import { createApp } from './app';
import { openStore, type Store } from './store';

class CapablePostgres implements EngineConnector {
  readonly kind = 'postgresql' as const;
  readonly implemented = true;
  rotated: string[] = [];

  async init(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async health() {
    return { ok: true, engine: this.kind, version: '16.4', role: 'primary' as const, latencyMs: 2, details: { connections: 4 } };
  }
  async discover() {
    return { version: '16.4', databases: ['app'] };
  }
  async validateConfig() {
    return { valid: true, issues: [] };
  }
  async metrics() {
    return { connections: 150, maxConnections: 200, sizeBytes: 4096, replicationLagMs: 45000, role: 'replica' as const };
  }
  async backup() {
    return { format: 'dbase-manifest-v1' as const, engine: this.kind, version: '16.4', databases: [{ name: 'app', sizeBytes: 4096 }], capturedAt: new Date().toISOString() };
  }
  async harden() {
    return [{ checkId: 'ssl', severity: 'high' as const, passed: false, detail: 'ssl is off' }];
  }
  async promote() {
    return { detail: 'pg_promote issued' };
  }
  async rotatePassword(_target: unknown, nextPassword: string) {
    this.rotated.push(nextPassword);
  }
}

describe('platform operations', () => {
  let store: Store;
  const connector = new CapablePostgres();
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbase-backups-'));
  const app = () => createApp({ store, registry, jwtSecret: 'test-secret', backupDir });

  beforeAll(() => {
    store = openStore(':memory:');
    store.createUser({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
    store.createUser({ username: 'ops', password: 'ops-pass-12', role: 'moderator' });
  });

  async function token(username = 'ops', password = 'ops-pass-12'): Promise<string> {
    const response = await request(app()).post('/api/v1/auth/login').send({ username, password });
    return response.body.data.accessToken as string;
  }

  it('isolates a service account to its environment', async () => {
    const admin = await token('admin', 'admin-pass-1');
    const created = await request(app()).post('/api/v1/environments').set('Authorization', `Bearer ${admin}`).send({ name: 'staging' });
    expect(created.status).toBe(201);
    const account = await request(app()).post('/api/v1/service-accounts').set('Authorization', `Bearer ${admin}`).send({
      name: 'staging-bot',
      role: 'viewer',
      environmentId: created.body.data.id,
    });
    expect(account.status).toBe(201);
    expect(account.body.data.token.startsWith('dw_')).toBe(true);
    expect(JSON.stringify(account.body.data)).not.toContain('token_hash');

    const ops = await token();
    await request(app()).post('/api/v1/servers').set('Authorization', `Bearer ${ops}`).send({ name: 'prod-db', hostname: '10.1.0.5' });
    const visible = await request(app()).get('/api/v1/servers').set('Authorization', `Bearer ${account.body.data.token}`);
    expect(visible.status).toBe(200);
    expect(visible.body.data).toEqual([]);
    const users = await request(app()).get('/api/v1/users').set('Authorization', `Bearer ${account.body.data.token}`);
    expect(users.status).toBe(403);
    const crossed = await request(app())
      .get('/api/v1/servers?environmentId=env-default')
      .set('Authorization', `Bearer ${account.body.data.token}`);
    expect(crossed.status).toBe(403);
  });

  it('collects metrics, fires alerts, writes a backup, and verifies restore', async () => {
    const ops = await token();
    const engine = await request(app()).post('/api/v1/engines').set('Authorization', `Bearer ${ops}`).send({
      name: 'metrics-db',
      kind: 'postgresql',
      host: 'db.internal',
      username: 'warden',
      password: 'secret-pass',
      serviceUnit: 'postgresql',
    });
    const metrics = await request(app()).post('/api/v1/jobs').set('Authorization', `Bearer ${ops}`).send({
      type: 'engine.metrics',
      engineId: engine.body.data.id,
    });
    expect(metrics.status).toBe(201);
    expect(metrics.body.data.result.connections).toBe(150);

    const alerts = await request(app()).get('/api/v1/alerts').set('Authorization', `Bearer ${ops}`);
    const messages = alerts.body.data.map((alert: { message: string; status: string }) => `${alert.status}:${alert.message}`);
    expect(messages).toContain('firing:150 connections');
    expect(messages.some((message: string) => message.startsWith('firing:lag'))).toBe(true);

    const backup = await request(app()).post('/api/v1/jobs').set('Authorization', `Bearer ${ops}`).send({
      type: 'engine.backup',
      engineId: engine.body.data.id,
    });
    expect(backup.status).toBe(201);
    expect(fs.existsSync(backup.body.data.result.artifactPath)).toBe(true);
    const text = fs.readFileSync(backup.body.data.result.artifactPath, 'utf8');
    expect(text).not.toContain('secret-pass');

    const restored = await request(app()).post('/api/v1/jobs').set('Authorization', `Bearer ${ops}`).send({
      type: 'engine.restore',
      engineId: engine.body.data.id,
      backupId: backup.body.data.result.backupId,
    });
    expect(restored.status).toBe(201);
    expect(restored.body.data.result.verified).toBe(true);
    expect(restored.body.data.result.restored).toBe(false);

    const control = await request(app()).post('/api/v1/jobs').set('Authorization', `Bearer ${ops}`).send({
      type: 'engine.control',
      engineId: engine.body.data.id,
      action: 'restart',
    });
    expect(control.body.data.result.executed).toBe(false);
    expect(control.body.data.result.detail).toContain('planned: systemctl restart postgresql');
  });

  it('promotes a replica, rotates a secret, scans hardening, and exports audit', async () => {
    const ops = await token();
    const admin = await token('admin', 'admin-pass-1');
    const primary = await request(app()).post('/api/v1/engines').set('Authorization', `Bearer ${ops}`).send({
      name: 'primary',
      kind: 'postgresql',
      host: '10.0.0.1',
      username: 'warden',
      password: 'old-password',
    });
    const replica = await request(app()).post('/api/v1/engines').set('Authorization', `Bearer ${ops}`).send({
      name: 'replica',
      kind: 'postgresql',
      host: '10.0.0.2',
      username: 'warden',
      password: 'old-password',
    });
    const cluster = await request(app()).post('/api/v1/clusters').set('Authorization', `Bearer ${ops}`).send({ name: 'ha', kind: 'postgresql' });
    await request(app()).post(`/api/v1/clusters/${cluster.body.data.id}/members`).set('Authorization', `Bearer ${ops}`).send({ engineId: primary.body.data.id, role: 'primary' });
    await request(app()).post(`/api/v1/clusters/${cluster.body.data.id}/members`).set('Authorization', `Bearer ${ops}`).send({ engineId: replica.body.data.id, role: 'replica' });
    const failover = await request(app()).post('/api/v1/jobs').set('Authorization', `Bearer ${ops}`).send({
      type: 'engine.promote',
      clusterId: cluster.body.data.id,
      engineId: replica.body.data.id,
    });
    expect(failover.status).toBe(201);
    const roles = Object.fromEntries(failover.body.data.result.members.map((member: { engineName: string; role: string }) => [member.engineName, member.role]));
    expect(roles.replica).toBe('primary');
    expect(roles.primary).toBe('replica');

    const rotated = await request(app()).post('/api/v1/jobs').set('Authorization', `Bearer ${admin}`).send({
      type: 'secret.rotate',
      engineId: primary.body.data.id,
      password: 'new-password',
      apply: true,
    });
    expect(rotated.status).toBe(201);
    expect(JSON.stringify(rotated.body)).not.toContain('new-password');
    expect(connector.rotated).toEqual(['new-password']);
    expect(store.getEngineSecret(primary.body.data.id)).toBe('new-password');

    const scan = await request(app()).post('/api/v1/jobs').set('Authorization', `Bearer ${ops}`).send({
      type: 'engine.harden',
      engineId: primary.body.data.id,
    });
    expect(scan.status).toBe(201);
    const violations = await request(app()).post('/api/v1/policies/evaluate').set('Authorization', `Bearer ${ops}`);
    expect(violations.body.data.some((item: { detail: string }) => item.detail === 'ssl is off')).toBe(true);

    const runbook = await request(app()).post('/api/v1/runbooks').set('Authorization', `Bearer ${ops}`).send({
      title: 'Promote staging',
      body: 'Confirm lag, promote the replica, then point writers at the new primary.',
      clusterId: cluster.body.data.id,
    });
    expect(runbook.status).toBe(201);

    const exported = await request(app()).get('/api/v1/audit/export?format=csv').set('Authorization', `Bearer ${ops}`);
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('secret.rotate');
    expect(exported.text).not.toContain('new-password');
  });
});
