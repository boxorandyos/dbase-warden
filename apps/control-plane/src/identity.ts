import { createHash, createHmac, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { signAccessToken, signChallengeToken, type AuthToken } from './auth';
import { AppError } from './errors';
import type { PublicUser, Role, Store } from './store';

export interface DirectoryIdentity {
  username: string;
  email: string;
  name: string;
  groups: string[];
}

export interface LdapConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: string;
}

export interface DirectoryClient {
  authenticate(config: LdapConfig, username: string, password: string): Promise<DirectoryIdentity | null>;
}

export interface OidcClient {
  authorizationUrl(config: OidcConfig, state: string, nonce: string): Promise<string>;
  exchange(config: OidcConfig, code: string, nonce: string): Promise<DirectoryIdentity & { sub: string }>;
}

export interface LoginSuccess {
  twoFactorRequired?: false;
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export interface LoginChallenge {
  twoFactorRequired: true;
  challengeToken: string;
  user: PublicUser;
}

const SECRET_KEYS = new Set(['bindPassword', 'clientSecret']);

export class Identity {
  directory: DirectoryClient = new LdapDirectory();
  oidc: OidcClient = new FetchOidcClient();

  constructor(private readonly db: DatabaseSync) {}

  login(store: Store, secret: string, username: string, password: string, meta: { ip: string; userAgent: string }): LoginSuccess | LoginChallenge {
    const user = store.verifyUser(username, password);
    if (!user) throw new AppError(401, 'Invalid username or password');
    if (user.totpEnabled) {
      return { twoFactorRequired: true, challengeToken: signChallengeToken(user, secret), user: publicView(user) };
    }
    return this.issue(secret, user, meta);
  }

  verifySecondFactor(store: Store, secret: string, challengeToken: string, code: string, meta: { ip: string; userAgent: string }): LoginSuccess {
    const decoded = this.readChallenge(challengeToken, secret);
    const row = this.db.prepare('SELECT secret, enabled FROM user_totp WHERE user_id = ?').get(decoded.sub) as
      | { secret: string; enabled: number }
      | undefined;
    if (!row?.enabled || !verifyTotp(row.secret, code)) throw new AppError(401, 'Invalid authentication code');
    const user = store.userById(decoded.sub);
    if (!user) throw new AppError(401, 'Invalid or expired token');
    return this.issue(secret, user, meta);
  }

  refresh(store: Store, secret: string, refreshToken: string, meta: { ip: string; userAgent: string }): LoginSuccess {
    const session = this.sessionByRefresh(refreshToken);
    if (!session) throw new AppError(401, 'Invalid or expired token');
    const user = store.userById(session.user_id);
    if (!user) throw new AppError(401, 'Invalid or expired token');
    this.db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
    return this.issue(secret, user, meta);
  }

  logout(refreshToken: string): void {
    const hash = hashToken(refreshToken);
    this.db.prepare(`UPDATE user_sessions SET revoked_at = ? WHERE refresh_hash = ? AND revoked_at IS NULL`).run(new Date().toISOString(), hash);
  }

  logoutAll(userId: string): void {
    this.db.prepare(`UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), userId);
  }

  listSessions(userId: string): Array<{ id: string; ip: string; userAgent: string; createdAt: string; expiresAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, ip, user_agent, created_at, expires_at FROM user_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
      )
      .all(userId, new Date().toISOString()) as Array<{ id: string; ip: string; user_agent: string; created_at: string; expires_at: string }>;
    return rows.map((row) => ({ id: row.id, ip: row.ip, userAgent: row.user_agent, createdAt: row.created_at, expiresAt: row.expires_at }));
  }

  revokeSession(userId: string, sessionId: string): void {
    const result = this.db
      .prepare(`UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), sessionId, userId);
    if (result.changes === 0) throw new AppError(404, 'Session not found');
  }

  sessionLive(sid: string): boolean {
    const row = this.db
      .prepare(`SELECT id FROM user_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`)
      .get(sid, new Date().toISOString());
    return Boolean(row);
  }

  setupTotp(user: PublicUser): { secret: string; otpauthUrl: string } {
    const secret = base32Encode(randomBytes(20));
    this.db
      .prepare(
        `INSERT INTO user_totp (user_id, secret, enabled, created_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = 0`,
      )
      .run(user.id, secret, new Date().toISOString());
    const label = encodeURIComponent(`Dbase Warden:${user.username}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Dbase%20Warden&period=30&digits=6` };
  }

  enableTotp(userId: string, code: string): void {
    const row = this.db.prepare('SELECT secret FROM user_totp WHERE user_id = ?').get(userId) as { secret: string } | undefined;
    if (!row || !verifyTotp(row.secret, code)) throw new AppError(400, 'Invalid authentication code');
    this.db.prepare('UPDATE user_totp SET enabled = 1 WHERE user_id = ?').run(userId);
  }

  disableTotp(userId: string, code: string): void {
    const row = this.db.prepare('SELECT secret, enabled FROM user_totp WHERE user_id = ?').get(userId) as
      | { secret: string; enabled: number }
      | undefined;
    if (!row?.enabled || !verifyTotp(row.secret, code)) throw new AppError(400, 'Invalid authentication code');
    this.db.prepare('UPDATE user_totp SET enabled = 0 WHERE user_id = ?').run(userId);
  }

  changePassword(store: Store, userId: string, currentPassword: string, nextPassword: string): void {
    if (nextPassword.length < 8) throw new AppError(400, 'Password must be at least 8 characters');
    const row = this.db.prepare('SELECT username, password_hash FROM users WHERE id = ?').get(userId) as
      | { username: string; password_hash: string }
      | undefined;
    if (!row) throw new AppError(404, 'User not found');
    const verified = store.verifyUser(row.username, currentPassword);
    if (!verified || verified.id !== userId) throw new AppError(401, 'Current password is incorrect');
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(nextPassword), userId);
    this.logoutAll(userId);
  }

  listProviders(): Array<{ id: string; name: string; type: string; enabled: boolean; config: Record<string, string> }> {
    const rows = this.db.prepare('SELECT id, name, type, enabled, config_json FROM identity_providers ORDER BY name').all() as Array<{
      id: string;
      name: string;
      type: string;
      enabled: number;
      config_json: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled === 1,
      config: redact(JSON.parse(row.config_json) as Record<string, string>),
    }));
  }

  publicProviders(): Array<{ id: string; name: string; type: string }> {
    return this.listProviders()
      .filter((item) => item.enabled)
      .map(({ id, name, type }) => ({ id, name, type }));
  }

  saveProvider(input: { id?: string; name: string; type: string; enabled?: boolean; config: Record<string, string> }): { id: string } {
    const name = input.name.trim();
    if (!name) throw new AppError(400, 'name is required');
    if (input.type !== 'ldap' && input.type !== 'oidc') throw new AppError(400, 'type must be ldap or oidc');
    const config = { ...input.config };
    if (input.type === 'ldap' && (!config.url || !config.searchBase)) throw new AppError(400, 'LDAP url and searchBase are required');
    if (input.type === 'oidc' && (!config.issuer || !config.clientId || !config.redirectUrl)) {
      throw new AppError(400, 'OIDC issuer, clientId, and redirectUrl are required');
    }
    if (!config.searchFilter) config.searchFilter = '(uid={{username}})';
    if (!config.scopes) config.scopes = 'openid email profile';
    if (input.id) {
      const existing = this.db.prepare('SELECT config_json FROM identity_providers WHERE id = ?').get(input.id) as { config_json: string } | undefined;
      if (!existing) throw new AppError(404, 'Identity provider not found');
      const previous = JSON.parse(existing.config_json) as Record<string, string>;
      for (const key of SECRET_KEYS) {
        if (!config[key]) config[key] = previous[key] ?? '';
      }
      this.db
        .prepare('UPDATE identity_providers SET name = ?, type = ?, enabled = ?, config_json = ? WHERE id = ?')
        .run(name, input.type, input.enabled === false ? 0 : 1, JSON.stringify(config), input.id);
      return { id: input.id };
    }
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO identity_providers (id, name, type, enabled, config_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, input.type, input.enabled === false ? 0 : 1, JSON.stringify(config), new Date().toISOString());
    return { id };
  }

  async loginLdap(store: Store, secret: string, providerId: string, username: string, password: string, meta: { ip: string; userAgent: string }): Promise<LoginSuccess | LoginChallenge> {
    const provider = this.providerConfig(providerId, 'ldap');
    const identity = await this.directory.authenticate(
      {
        url: provider.url,
        bindDn: provider.bindDn ?? '',
        bindPassword: provider.bindPassword ?? '',
        searchBase: provider.searchBase,
        searchFilter: provider.searchFilter || '(uid={{username}})',
      },
      username,
      password,
    );
    if (!identity) throw new AppError(401, 'Invalid username or password');
    const user = this.upsertExternal(store, 'ldap', `${providerId}:${identity.username}`, identity);
    if (user.totpEnabled) return { twoFactorRequired: true, challengeToken: signChallengeToken(user, secret), user: publicView(user) };
    return this.issue(secret, user, meta);
  }

  async startOidc(providerId: string): Promise<string> {
    const provider = this.providerConfig(providerId, 'oidc');
    const state = randomBytes(24).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    this.db.prepare('INSERT INTO oidc_states (state, provider_id, nonce, expires_at) VALUES (?, ?, ?, ?)').run(state, providerId, nonce, expires);
    return this.oidc.authorizationUrl(
      {
        issuer: provider.issuer,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret ?? '',
        redirectUrl: provider.redirectUrl,
        scopes: provider.scopes || 'openid email profile',
      },
      state,
      nonce,
    );
  }

  async finishOidc(store: Store, secret: string, code: string, state: string, meta: { ip: string; userAgent: string }): Promise<LoginSuccess | LoginChallenge> {
    const saved = this.db.prepare('SELECT provider_id, nonce, expires_at FROM oidc_states WHERE state = ?').get(state) as
      | { provider_id: string; nonce: string; expires_at: string }
      | undefined;
    this.db.prepare('DELETE FROM oidc_states WHERE state = ?').run(state);
    if (!saved || Date.parse(saved.expires_at) < Date.now()) throw new AppError(400, 'OIDC state expired');
    const provider = this.providerConfig(saved.provider_id, 'oidc');
    const identity = await this.oidc.exchange(
      {
        issuer: provider.issuer,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret ?? '',
        redirectUrl: provider.redirectUrl,
        scopes: provider.scopes || 'openid email profile',
      },
      code,
      saved.nonce,
    );
    const user = this.upsertExternal(store, 'oidc', identity.sub, identity);
    if (user.totpEnabled) return { twoFactorRequired: true, challengeToken: signChallengeToken(user, secret), user: publicView(user) };
    return this.issue(secret, user, meta);
  }

  exportPlatform(store: Store): string {
    const body = {
      environments: store.catalog.listEnvironments(),
      runbooks: store.catalog.listRunbooks(),
      policies: store.catalog.listPolicies(),
      alertRules: store.catalog.listRules(),
    };
    return JSON.stringify(body);
  }

  createSnapshot(store: Store, actor: string): { id: string; actor: string; createdAt: string } {
    const record = { id: crypto.randomUUID(), actor, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO config_snapshots (id, actor, body, created_at) VALUES (?, ?, ?, ?)').run(record.id, actor, this.exportPlatform(store), record.createdAt);
    return record;
  }

  listSnapshots(): Array<{ id: string; actor: string; createdAt: string }> {
    const rows = this.db.prepare('SELECT id, actor, created_at FROM config_snapshots ORDER BY created_at DESC').all() as Array<{
      id: string;
      actor: string;
      created_at: string;
    }>;
    return rows.map((row) => ({ id: row.id, actor: row.actor, createdAt: row.created_at }));
  }

  applyDocument(store: Store, document: unknown): void {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO config_snapshots (id, actor, body, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'sync', JSON.stringify(document), new Date().toISOString());
    this.applySnapshot(store, id);
  }

  applySnapshot(store: Store, snapshotId: string): void {
    const row = this.db.prepare('SELECT body FROM config_snapshots WHERE id = ?').get(snapshotId) as { body: string } | undefined;
    if (!row) throw new AppError(404, 'Snapshot not found');
    const body = JSON.parse(row.body) as {
      environments: Array<{ id: string; name: string; description: string; createdAt: string }>;
      runbooks: Array<{ id: string; clusterId: string | null; environmentId: string | null; title: string; body: string; createdAt: string; updatedAt: string }>;
      policies: Array<{ id: string; name: string; kind: string; threshold: number | null; enabled: boolean; environmentId: string | null }>;
      alertRules: Array<{ id: string; name: string; kind: string; threshold: number; enabled: boolean }>;
    };
    this.db.exec('BEGIN');
    try {
      for (const item of body.environments ?? []) {
        this.db
          .prepare(
            `INSERT INTO environments (id, name, description, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description`,
          )
          .run(item.id, item.name, item.description, item.createdAt);
      }
      this.db.prepare('DELETE FROM runbooks').run();
      for (const item of body.runbooks ?? []) {
        this.db
          .prepare('INSERT INTO runbooks (id, cluster_id, environment_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(item.id, item.clusterId, item.environmentId, item.title, item.body, item.createdAt, item.updatedAt);
      }
      this.db.prepare('DELETE FROM policies').run();
      for (const item of body.policies ?? []) {
        this.db
          .prepare('INSERT INTO policies (id, name, kind, threshold, enabled, environment_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(item.id, item.name, item.kind, item.threshold, item.enabled ? 1 : 0, item.environmentId);
      }
      this.db.prepare('DELETE FROM alert_rules').run();
      for (const item of body.alertRules ?? []) {
        this.db
          .prepare('INSERT INTO alert_rules (id, name, kind, threshold, enabled, environment_id) VALUES (?, ?, ?, ?, ?, NULL)')
          .run(item.id, item.name, item.kind, item.threshold, item.enabled ? 1 : 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    void store;
  }

  private issue(secret: string, user: PublicUser, meta: { ip: string; userAgent: string }): LoginSuccess {
    const refreshToken = randomBytes(32).toString('hex');
    const sessionId = crypto.randomUUID();
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare('INSERT INTO user_sessions (id, user_id, refresh_hash, expires_at, revoked_at, ip, user_agent, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
      .run(sessionId, user.id, hashToken(refreshToken), expires, meta.ip.slice(0, 200), meta.userAgent.slice(0, 400), new Date().toISOString());
    return { accessToken: signAccessToken(user, secret, sessionId), refreshToken, user: publicView(user) };
  }

  private sessionByRefresh(refreshToken: string): { id: string; user_id: string } | undefined {
    return this.db
      .prepare(`SELECT id, user_id FROM user_sessions WHERE refresh_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
      .get(hashToken(refreshToken), new Date().toISOString()) as { id: string; user_id: string } | undefined;
  }

  private readChallenge(token: string, secret: string): AuthToken {
    try {
      const decoded = jwt.verify(token, secret) as AuthToken;
      if (decoded.purpose !== '2fa') throw new AppError(401, 'Invalid or expired token');
      return decoded;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(401, 'Invalid or expired token');
    }
  }

  private providerConfig(id: string, type: string): Record<string, string> & { type: string } {
    const row = this.db.prepare('SELECT type, enabled, config_json FROM identity_providers WHERE id = ?').get(id) as
      | { type: string; enabled: number; config_json: string }
      | undefined;
    if (!row || row.enabled !== 1 || row.type !== type) throw new AppError(404, 'Identity provider not found');
    return { type: row.type, ...(JSON.parse(row.config_json) as Record<string, string>) };
  }

  private upsertExternal(store: Store, provider: string, externalId: string, identity: DirectoryIdentity): PublicUser {
    const existing = this.db.prepare('SELECT id FROM users WHERE external_id = ? AND auth_provider = ?').get(externalId, provider) as { id: string } | undefined;
    const role: Role = identity.groups.some((group) => group.toLowerCase() === 'admins') ? 'admin' : 'viewer';
    if (existing) {
      const user = store.userById(existing.id);
      if (!user) throw new AppError(401, 'Invalid username or password');
      return user;
    }
    const username = uniqueUsername(this.db, identity.username || identity.email.split('@')[0] || 'user');
    return store.createUser({
      username,
      password: randomBytes(24).toString('hex'),
      role,
      email: identity.email,
      authProvider: provider,
      externalId,
      mustChangePassword: false,
    });
  }
}

export function prometheusText(sample: { jobs: Record<string, number>; nodes: number; alertRules: number; firing: number }): string {
  const lines = [
    '# HELP warden_up Control plane is serving.',
    '# TYPE warden_up gauge',
    'warden_up 1',
    '# HELP warden_nodes Registered fleet nodes.',
    '# TYPE warden_nodes gauge',
    `warden_nodes ${sample.nodes}`,
    '# HELP warden_alert_rules Configured alert rules.',
    '# TYPE warden_alert_rules gauge',
    `warden_alert_rules ${sample.alertRules}`,
    '# HELP warden_alerts_firing Firing alert events.',
    '# TYPE warden_alerts_firing gauge',
    `warden_alerts_firing ${sample.firing}`,
    '# HELP warden_jobs Jobs by status.',
    '# TYPE warden_jobs gauge',
  ];
  for (const status of ['succeeded', 'failed', 'running', 'queued']) {
    lines.push(`warden_jobs{status="${status}"} ${sample.jobs[status] ?? 0}`);
  }
  return `${lines.join('\n')}\n`;
}

export function tailAllowlistedLog(filePath: string, maxLines = 200): { path: string; content: string; exists: boolean } {
  const resolved = filePath.trim();
  if (!resolved || resolved.includes('\0')) return { path: resolved, content: '', exists: false };
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return { path: resolved, content: '', exists: false };
  const content = fs.readFileSync(resolved, 'utf8').split('\n').slice(-maxLines).join('\n');
  return { path: resolved, content, exists: true };
}

export function totpCode(secret: string, now = Date.now()): string {
  const raw = decodeBase32(secret);
  if (!raw) return '';
  return hotp(raw, Math.floor(now / 30000));
}

export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const token = code.trim();
  if (!/^\d{6}$/.test(token)) return false;
  const raw = decodeBase32(secret);
  if (!raw) return false;
  const counter = Math.floor(now / 30000);
  for (let delta = -1; delta <= 1; delta += 1) {
    if (hotp(raw, counter + delta) === token) return true;
  }
  return false;
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1_000_000).padStart(6, '0');
}

function base32Encode(value: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  let output = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = value.toUpperCase().replace(/=+$/g, '');
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index < 0) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

function publicView(user: PublicUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    environmentId: user.environmentId ?? null,
    mustChangePassword: Boolean(user.mustChangePassword),
    totpEnabled: Boolean(user.totpEnabled),
    email: user.email ?? '',
    authProvider: user.authProvider ?? 'local',
  };
}

function redact(config: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    copy[key] = SECRET_KEYS.has(key) ? '' : value;
    if (SECRET_KEYS.has(key)) copy[`${key}Set`] = value ? 'true' : 'false';
  }
  return copy;
}

function uniqueUsername(db: DatabaseSync, base: string): string {
  const cleaned = base.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 48) || 'user';
  let candidate = cleaned.length >= 3 ? cleaned : `${cleaned}usr`;
  let suffix = 1;
  while (db.prepare('SELECT id FROM users WHERE username = ?').get(candidate)) {
    suffix += 1;
    candidate = `${cleaned.slice(0, 40)}-${suffix}`;
  }
  return candidate;
}

class LdapDirectory implements DirectoryClient {
  async authenticate(config: LdapConfig, username: string, password: string): Promise<DirectoryIdentity | null> {
    if (!password) return null;
    const { Client } = await import('ldapts');
    const client = new Client({ url: config.url });
    try {
      if (config.bindDn) await client.bind(config.bindDn, config.bindPassword);
      const filter = config.searchFilter.replaceAll('{{username}}', ldapEscape(username));
      const { searchEntries } = await client.search(config.searchBase, { scope: 'sub', filter, sizeLimit: 2 });
      const entry = searchEntries[0] as { dn?: string; mail?: string | string[]; cn?: string | string[]; memberOf?: string | string[] } | undefined;
      if (!entry?.dn) return null;
      await client.bind(entry.dn, password);
      const mail = first(entry.mail);
      const name = first(entry.cn) || username;
      const groups = (Array.isArray(entry.memberOf) ? entry.memberOf : entry.memberOf ? [entry.memberOf] : []).map(String);
      return { username, email: mail || `${username}@local`, name, groups };
    } catch {
      return null;
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}

class FetchOidcClient implements OidcClient {
  async authorizationUrl(config: OidcConfig, state: string, nonce: string): Promise<string> {
    const discovery = await discover(config.issuer);
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUrl);
    url.searchParams.set('scope', config.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    return url.toString();
  }

  async exchange(config: OidcConfig, code: string, nonce: string): Promise<DirectoryIdentity & { sub: string }> {
    const discovery = await discover(config.issuer);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUrl,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new AppError(401, 'OIDC token exchange failed');
    const payload = (await response.json()) as { id_token?: string };
    if (!payload.id_token) throw new AppError(401, 'OIDC token exchange failed');
    const claims = await verifyIdToken(payload.id_token, discovery.jwks_uri, config.issuer, config.clientId);
    if (claims.nonce !== nonce) throw new AppError(401, 'OIDC nonce mismatch');
    const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : [];
    return {
      sub: String(claims.sub),
      username: String(claims.preferred_username || claims.email || claims.sub),
      email: String(claims.email || ''),
      name: String(claims.name || claims.preferred_username || claims.sub),
      groups,
    };
  }
}

async function discover(issuer: string): Promise<{ authorization_endpoint: string; token_endpoint: string; jwks_uri: string }> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const response = await fetch(new URL('.well-known/openid-configuration', base));
  if (!response.ok) throw new AppError(502, 'OIDC discovery failed');
  return (await response.json()) as { authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
}

async function verifyIdToken(token: string, jwksUri: string, issuer: string, audience: string): Promise<Record<string, unknown>> {
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) throw new AppError(401, 'OIDC token is invalid');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString()) as { kid?: string; alg?: string };
  if (header.alg !== 'RS256') throw new AppError(401, 'OIDC token algorithm is not supported');
  const jwks = (await (await fetch(jwksUri)).json()) as { keys: Array<{ kid?: string; kty?: string }> };
  const jwk = jwks.keys.find((key) => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) throw new AppError(401, 'OIDC signing key was not found');
  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  const valid = verifySignature('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, 'base64url'));
  if (!valid) throw new AppError(401, 'OIDC token signature is invalid');
  const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as Record<string, unknown>;
  const aud = claims.aud;
  const audienceOk = aud === audience || (Array.isArray(aud) && aud.includes(audience));
  if (claims.iss !== issuer || !audienceOk) throw new AppError(401, 'OIDC token claims are invalid');
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new AppError(401, 'OIDC token expired');
  return claims;
}

function ldapEscape(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return value ? String(value) : '';
}
