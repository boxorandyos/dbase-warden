import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { ConnectorRegistry } from '@dbase-warden/engines';
import { createApp } from './app';
import { totpCode } from './identity';
import { openStore, type Store } from './store';

describe('identity and fleet parity', () => {
  let store: Store;
  const registry = new ConnectorRegistry();
  const app = () =>
    createApp({
      store,
      registry,
      jwtSecret: 'test-secret',
      maintenance: { maintenanceKey: 'slave-key', nodeRole: 'master', fetch: fetchImpl },
      updateLogPath: '/tmp/dbase-warden-update-test.log',
    });
  const calls: Array<{ url: string; key?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), key: headers.get('x-maintenance-key') ?? undefined });
    return new Response(JSON.stringify({ success: true }), { status: 202 });
  };

  beforeAll(() => {
    store = openStore(':memory:');
    store.createUser({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
  });

  async function token(): Promise<string> {
    const response = await request(app()).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin-pass-1' });
    return response.body.data.accessToken as string;
  }

  it('issues a refresh token, rotates it, and ends the session', async () => {
    const login = await request(app()).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin-pass-1' });
    expect(login.body.data.refreshToken).toEqual(expect.any(String));
    const refresh = await request(app()).post('/api/v1/auth/refresh').send({ refreshToken: login.body.data.refreshToken });
    expect(refresh.status).toBe(200);
    expect(refresh.body.data.accessToken).toEqual(expect.any(String));
    const again = await request(app()).post('/api/v1/auth/refresh').send({ refreshToken: login.body.data.refreshToken });
    expect(again.status).toBe(401);
    const sessions = await request(app()).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${refresh.body.data.accessToken}`);
    expect(sessions.body.data.length).toBeGreaterThan(0);
    await request(app()).post('/api/v1/auth/logout').send({ refreshToken: refresh.body.data.refreshToken });
    const ended = await request(app()).get('/api/v1/servers').set('Authorization', `Bearer ${refresh.body.data.accessToken}`);
    expect(ended.status).toBe(401);
  });

  it('requires a second factor after TOTP is enabled', async () => {
    const access = await token();
    const setup = await request(app()).post('/api/v1/auth/2fa/setup').set('Authorization', `Bearer ${access}`);
    const code = totpCode(setup.body.data.secret);
    const enabled = await request(app()).post('/api/v1/auth/2fa/enable').set('Authorization', `Bearer ${access}`).send({ code });
    expect(enabled.status).toBe(200);
    const challenge = await request(app()).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin-pass-1' });
    expect(challenge.body.data.twoFactorRequired).toBe(true);
    expect(challenge.body.data.accessToken).toBeUndefined();
    const verified = await request(app())
      .post('/api/v1/auth/verify-2fa')
      .send({ challengeToken: challenge.body.data.challengeToken, code: totpCode(setup.body.data.secret) });
    expect(verified.status).toBe(200);
    expect(verified.body.data.accessToken).toEqual(expect.any(String));
    await request(app()).post('/api/v1/auth/2fa/disable').set('Authorization', `Bearer ${verified.body.data.accessToken}`).send({ code: totpCode(setup.body.data.secret) });
  });

  it('changes the password and accepts an injected directory login', async () => {
    const created = await request(app()).post('/api/v1/users').set('Authorization', `Bearer ${await token()}`).send({
      username: 'new-admin',
      password: 'temp-pass-1',
      role: 'admin',
    });
    expect(created.body.data.mustChangePassword).toBe(true);
    const first = await request(app()).post('/api/v1/auth/login').send({ username: 'new-admin', password: 'temp-pass-1' });
    const changed = await request(app())
      .post('/api/v1/auth/first-login/change-password')
      .set('Authorization', `Bearer ${first.body.data.accessToken}`)
      .send({ currentPassword: 'temp-pass-1', newPassword: 'changed-pass-1' });
    expect(changed.status).toBe(200);
    const old = await request(app()).post('/api/v1/auth/login').send({ username: 'new-admin', password: 'temp-pass-1' });
    expect(old.status).toBe(401);

    const provider = await request(app()).post('/api/v1/identity/providers').set('Authorization', `Bearer ${await token()}`).send({
      name: 'directory',
      type: 'ldap',
      config: { url: 'ldap://directory.example', searchBase: 'dc=example,dc=com' },
    });
    store.identity.directory = {
      async authenticate() {
        return { username: 'ada', email: 'ada@example.com', name: 'Ada', groups: ['admins'] };
      },
    };
    const ldap = await request(app()).post('/api/v1/auth/ldap').send({ providerId: provider.body.data.id, username: 'ada', password: 'secret' });
    expect(ldap.status).toBe(200);
    expect(ldap.body.data.user.role).toBe('admin');
    expect(JSON.stringify(ldap.body)).not.toContain('bindPassword');
  });

  it('snapshots platform config, exposes metrics, and syncs a registered node', async () => {
    const access = await token();
    const snapshot = await request(app()).post('/api/v1/platform/snapshots').set('Authorization', `Bearer ${access}`);
    expect(snapshot.status).toBe(201);
    const metrics = await request(app()).get('/metrics');
    expect(metrics.text).toContain('warden_up 1');
    const json = await request(app()).get('/api/v1/metrics').set('Authorization', `Bearer ${access}`);
    expect(json.body.data.alertRules).toBeGreaterThan(0);
    const node = await request(app()).post('/api/v1/warden-nodes').set('Authorization', `Bearer ${access}`).send({ name: 'standby', host: '10.2.0.9', port: 3101 });
    const beat = await request(app()).post('/api/v1/warden-nodes/heartbeat').set('X-Maintenance-Key', node.body.data.token);
    expect(beat.status).toBe(200);
    const sync = await request(app()).post('/api/v1/platform/sync').set('Authorization', `Bearer ${access}`);
    expect(sync.body.data).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/v1/platform/sync/apply');
    expect(calls[0]?.key).toBe(node.body.data.token);
    const violations = await request(app()).get('/api/v1/policies/violations').set('Authorization', `Bearer ${access}`);
    expect(violations.body.data.some((item: { detail: string }) => item.detail.includes('MFA'))).toBe(true);
  });
});
