import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import type { EngineKind } from '@dbase-warden/engines';
import { AppError } from './errors';

export type Role = 'admin' | 'moderator' | 'viewer';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type MemberRole = 'primary' | 'replica' | 'witness';

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
}

export interface ServerRecord {
  id: string;
  name: string;
  hostname: string;
  sshPort: number;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface EngineRecord {
  id: string;
  serverId: string | null;
  name: string;
  kind: EngineKind;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  credentialRef: string;
  version: string | null;
  lastHealth: {
    ok: boolean;
    at: string;
    role?: string;
    latencyMs?: number;
    error?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClusterRecord {
  id: string;
  name: string;
  kind: EngineKind;
  description: string;
  createdAt: string;
  members: Array<{ engineId: string; role: MemberRole; engineName: string }>;
}

export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  actor: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detail: string;
  createdAt: string;
}

interface EngineRow {
  id: string;
  server_id: string | null;
  name: string;
  kind: EngineKind;
  host: string;
  port: number;
  database_name: string;
  username: string;
  secret: string;
  version: string | null;
  last_health_ok: number | null;
  last_health_at: string | null;
  last_health_json: string | null;
  created_at: string;
  updated_at: string;
}

const ROLES: Role[] = ['admin', 'moderator', 'viewer'];
const KINDS: EngineKind[] = ['postgresql', 'mysql', 'mariadb'];
const MEMBER_ROLES: MemberRole[] = ['primary', 'replica', 'witness'];

function now(): string {
  return new Date().toISOString();
}

function id(): string {
  return crypto.randomUUID();
}

export function credentialRef(engineId: string): string {
  return `local://${engineId}`;
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  migrate(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        ssh_port INTEGER NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS engines (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        database_name TEXT NOT NULL,
        username TEXT NOT NULL,
        secret TEXT NOT NULL,
        version TEXT,
        last_health_ok INTEGER,
        last_health_at TEXT,
        last_health_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (server_id) REFERENCES servers(id)
      );
      CREATE TABLE IF NOT EXISTS clusters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cluster_members (
        cluster_id TEXT NOT NULL,
        engine_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (cluster_id, engine_id),
        FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
        FOREIGN KEY (engine_id) REFERENCES engines(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        payload TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  bootstrapAdmin(input: { username: string; password: string | undefined; allowDevDefault: boolean }): PublicUser | null {
    const existing = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    if (existing.c > 0) return null;
    const password = input.password || (input.allowDevDefault ? 'dbase-admin' : '');
    if (!password) {
      throw new AppError(500, 'DBASE_ADMIN_PASSWORD is required when bootstrapping in production');
    }
    if (password.length < 8) {
      throw new AppError(500, 'Bootstrap admin password must be at least 8 characters');
    }
    return this.createUser({ username: input.username || 'admin', password, role: 'admin' });
  }

  createUser(input: { username: string; password: string; role: Role }): PublicUser {
    const username = input.username.trim();
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
      throw new AppError(400, 'Username must be 3-64 characters and use letters, numbers, ., _, or -');
    }
    if (input.password.length < 8) {
      throw new AppError(400, 'Password must be at least 8 characters');
    }
    if (!ROLES.includes(input.role)) {
      throw new AppError(400, 'Role must be admin, moderator, or viewer');
    }
    const taken = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (taken) throw new AppError(409, 'Username already exists');
    const record: PublicUser = {
      id: id(),
      username,
      role: input.role,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, record.username, bcrypt.hashSync(input.password, 10), record.role, record.createdAt);
    return record;
  }

  verifyUser(username: string, password: string): PublicUser | null {
    const row = this.db
      .prepare('SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?')
      .get(username) as
      | { id: string; username: string; password_hash: string; role: Role; created_at: string }
      | undefined;
    if (!row || !bcrypt.compareSync(password, row.password_hash)) return null;
    return { id: row.id, username: row.username, role: row.role, createdAt: row.created_at };
  }

  listUsers(): PublicUser[] {
    const rows = this.db
      .prepare('SELECT id, username, role, created_at FROM users ORDER BY username')
      .all() as Array<{ id: string; username: string; role: Role; created_at: string }>;
    return rows.map((row) => ({ id: row.id, username: row.username, role: row.role, createdAt: row.created_at }));
  }

  updateUser(userId: string, patch: { role?: Role; password?: string }, actorId: string): PublicUser {
    const row = this.db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(userId) as
      | { id: string; username: string; role: Role; created_at: string }
      | undefined;
    if (!row) throw new AppError(404, 'User not found');
    if (patch.role && !ROLES.includes(patch.role)) {
      throw new AppError(400, 'Role must be admin, moderator, or viewer');
    }
    if (patch.role && patch.role !== 'admin' && row.role === 'admin') {
      this.assertNotLastAdmin(row.id);
    }
    if (patch.password !== undefined && patch.password.length < 8) {
      throw new AppError(400, 'Password must be at least 8 characters');
    }
    if (actorId === userId && patch.role && patch.role !== row.role) {
      throw new AppError(409, 'You cannot change your own role');
    }
    const role = patch.role ?? row.role;
    if (patch.password) {
      this.db.prepare('UPDATE users SET role = ?, password_hash = ? WHERE id = ?').run(role, bcrypt.hashSync(patch.password, 10), userId);
    } else {
      this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    }
    return { id: row.id, username: row.username, role, createdAt: row.created_at };
  }

  deleteUser(userId: string, actorId: string): void {
    const row = this.db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId) as { id: string; role: Role } | undefined;
    if (!row) throw new AppError(404, 'User not found');
    if (row.id === actorId) throw new AppError(409, 'You cannot delete your own account');
    if (row.role === 'admin') this.assertNotLastAdmin(row.id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  private assertNotLastAdmin(userId: string): void {
    const admins = this.db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all() as Array<{ id: string }>;
    if (admins.length === 1 && admins[0]?.id === userId) {
      throw new AppError(409, 'Cannot remove the last admin');
    }
  }

  listServers(): ServerRecord[] {
    return (this.db.prepare('SELECT * FROM servers ORDER BY name').all() as Array<Record<string, unknown>>).map(mapServer);
  }

  createServer(input: { name: string; hostname: string; sshPort?: number; description?: string }): ServerRecord {
    const name = requiredText(input.name, 'name');
    const hostname = requiredText(input.hostname, 'hostname');
    const sshPort = input.sshPort ?? 22;
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      throw new AppError(400, 'sshPort must be an integer between 1 and 65535');
    }
    const timestamp = now();
    const record: ServerRecord = {
      id: id(),
      name,
      hostname,
      sshPort,
      description: input.description?.trim() ?? '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        'INSERT INTO servers (id, name, hostname, ssh_port, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(record.id, record.name, record.hostname, record.sshPort, record.description, record.createdAt, record.updatedAt);
    return record;
  }

  deleteServer(serverId: string): void {
    const row = this.db.prepare('SELECT id FROM servers WHERE id = ?').get(serverId);
    if (!row) throw new AppError(404, 'Server not found');
    const engines = this.db.prepare('SELECT COUNT(*) AS c FROM engines WHERE server_id = ?').get(serverId) as { c: number };
    if (engines.c > 0) throw new AppError(409, 'Detach engine instances before deleting this server');
    this.db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
  }

  listEngines(): EngineRecord[] {
    return (this.db.prepare('SELECT * FROM engines ORDER BY name').all() as unknown as EngineRow[]).map(mapEngine);
  }

  getEngine(engineId: string): EngineRecord {
    const row = this.db.prepare('SELECT * FROM engines WHERE id = ?').get(engineId) as EngineRow | undefined;
    if (!row) throw new AppError(404, 'Engine not found');
    return mapEngine(row);
  }

  getEngineSecret(engineId: string): string {
    const row = this.db.prepare('SELECT secret FROM engines WHERE id = ?').get(engineId) as { secret: string } | undefined;
    if (!row) throw new AppError(404, 'Engine not found');
    return row.secret;
  }

  createEngine(input: {
    name: string;
    kind: string;
    host: string;
    port?: number;
    databaseName?: string;
    username?: string;
    password?: string;
    serverId?: string | null;
  }): EngineRecord {
    const kind = parseKind(input.kind);
    const name = requiredText(input.name, 'name');
    const host = requiredText(input.host, 'host');
    const port = input.port ?? (kind === 'postgresql' ? 5432 : 3306);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AppError(400, 'port must be an integer between 1 and 65535');
    }
    if (input.serverId) {
      const server = this.db.prepare('SELECT id FROM servers WHERE id = ?').get(input.serverId);
      if (!server) throw new AppError(400, 'serverId does not match a registered server');
    }
    const timestamp = now();
    const engineId = id();
    this.db
      .prepare(
        `INSERT INTO engines (
          id, server_id, name, kind, host, port, database_name, username, secret, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        engineId,
        input.serverId ?? null,
        name,
        kind,
        host,
        port,
        input.databaseName?.trim() ?? '',
        input.username?.trim() ?? '',
        input.password ?? '',
        timestamp,
        timestamp,
      );
    return this.getEngine(engineId);
  }

  recordEngineHealth(engineId: string, health: { ok: boolean; version?: string; role?: string; latencyMs: number; error?: string }): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE engines
         SET version = COALESCE(?, version), last_health_ok = ?, last_health_at = ?, last_health_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        health.version ?? null,
        health.ok ? 1 : 0,
        timestamp,
        JSON.stringify({ role: health.role, latencyMs: health.latencyMs, error: health.error }),
        timestamp,
        engineId,
      );
  }

  listClusters(): ClusterRecord[] {
    const clusters = this.db.prepare('SELECT * FROM clusters ORDER BY name').all() as Array<{
      id: string;
      name: string;
      kind: EngineKind;
      description: string;
      created_at: string;
    }>;
    return clusters.map((cluster) => this.hydrateCluster(cluster));
  }

  createCluster(input: { name: string; kind: string; description?: string }): ClusterRecord {
    const name = requiredText(input.name, 'name');
    const kind = parseKind(input.kind);
    const taken = this.db.prepare('SELECT id FROM clusters WHERE name = ?').get(name);
    if (taken) throw new AppError(409, 'Cluster name already exists');
    const clusterId = id();
    const createdAt = now();
    this.db
      .prepare('INSERT INTO clusters (id, name, kind, description, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(clusterId, name, kind, input.description?.trim() ?? '', createdAt);
    return { id: clusterId, name, kind, description: input.description?.trim() ?? '', createdAt, members: [] };
  }

  addClusterMember(clusterId: string, engineId: string, role: string): ClusterRecord {
    if (!MEMBER_ROLES.includes(role as MemberRole)) {
      throw new AppError(400, 'Member role must be primary, replica, or witness');
    }
    const cluster = this.db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId) as
      | { id: string; name: string; kind: EngineKind; description: string; created_at: string }
      | undefined;
    if (!cluster) throw new AppError(404, 'Cluster not found');
    const engine = this.db.prepare('SELECT id, kind, name FROM engines WHERE id = ?').get(engineId) as
      | { id: string; kind: EngineKind; name: string }
      | undefined;
    if (!engine) throw new AppError(404, 'Engine not found');
    if (engine.kind !== cluster.kind) {
      throw new AppError(400, 'Engine kind must match the cluster kind');
    }
    this.db
      .prepare(
        `INSERT INTO cluster_members (cluster_id, engine_id, role) VALUES (?, ?, ?)
         ON CONFLICT(cluster_id, engine_id) DO UPDATE SET role = excluded.role`,
      )
      .run(clusterId, engineId, role);
    return this.hydrateCluster(cluster);
  }

  deleteCluster(clusterId: string): void {
    const row = this.db.prepare('SELECT id FROM clusters WHERE id = ?').get(clusterId);
    if (!row) throw new AppError(404, 'Cluster not found');
    this.db.prepare('DELETE FROM clusters WHERE id = ?').run(clusterId);
  }

  private hydrateCluster(cluster: {
    id: string;
    name: string;
    kind: EngineKind;
    description: string;
    created_at: string;
  }): ClusterRecord {
    const members = this.db
      .prepare(
        `SELECT m.engine_id, m.role, e.name AS engine_name
         FROM cluster_members m JOIN engines e ON e.id = m.engine_id
         WHERE m.cluster_id = ? ORDER BY e.name`,
      )
      .all(cluster.id) as Array<{ engine_id: string; role: MemberRole; engine_name: string }>;
    return {
      id: cluster.id,
      name: cluster.name,
      kind: cluster.kind,
      description: cluster.description,
      createdAt: cluster.created_at,
      members: members.map((member) => ({
        engineId: member.engine_id,
        role: member.role,
        engineName: member.engine_name,
      })),
    };
  }

  createJob(input: {
    type: string;
    actor: string;
    targetType?: string;
    targetId?: string;
    payload: Record<string, unknown>;
  }): JobRecord {
    const record: JobRecord = {
      id: id(),
      type: input.type,
      status: 'queued',
      actor: input.actor,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      payload: input.payload,
      result: null,
      error: null,
      createdAt: now(),
      finishedAt: null,
    };
    this.insertJob(record);
    return record;
  }

  finishJob(jobId: string, outcome: { status: 'succeeded' | 'failed'; result?: Record<string, unknown>; error?: string }): JobRecord {
    const finishedAt = now();
    this.db
      .prepare('UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(outcome.status, outcome.result ? JSON.stringify(outcome.result) : null, outcome.error ?? null, finishedAt, jobId);
    return this.getJob(jobId);
  }

  markJobRunning(jobId: string): void {
    this.db.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(jobId);
  }

  listJobs(): JobRecord[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').all() as Array<Record<string, unknown>>).map(
      mapJob,
    );
  }

  getJob(jobId: string): JobRecord {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, 'Job not found');
    return mapJob(row);
  }

  private insertJob(record: JobRecord): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, type, status, actor, target_type, target_id, payload, result, error, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.type,
        record.status,
        record.actor,
        record.targetType,
        record.targetId,
        JSON.stringify(record.payload),
        record.result ? JSON.stringify(record.result) : null,
        record.error,
        record.createdAt,
        record.finishedAt,
      );
  }

  audit(entry: { actor: string; action: string; resourceType: string; resourceId?: string; detail?: string }): AuditRecord {
    const record: AuditRecord = {
      id: id(),
      actor: entry.actor,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? '',
      detail: entry.detail ?? '',
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO audit_log (id, actor, action, resource_type, resource_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(record.id, record.actor, record.action, record.resourceType, record.resourceId, record.detail, record.createdAt);
    return record;
  }

  listAudit(): AuditRecord[] {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all() as Array<{
      id: string;
      actor: string;
      action: string;
      resource_type: string;
      resource_id: string;
      detail: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      detail: row.detail,
      createdAt: row.created_at,
    }));
  }
}

function requiredText(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new AppError(400, `${field} is required`);
  if (trimmed.length > 200) throw new AppError(400, `${field} is too long`);
  return trimmed;
}

function parseKind(kind: string): EngineKind {
  if (!KINDS.includes(kind as EngineKind)) {
    throw new AppError(400, 'kind must be postgresql, mysql, or mariadb');
  }
  return kind as EngineKind;
}

function mapServer(row: Record<string, unknown>): ServerRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    hostname: String(row.hostname),
    sshPort: Number(row.ssh_port),
    description: String(row.description ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEngine(row: EngineRow): EngineRecord {
  let lastHealth: EngineRecord['lastHealth'] = null;
  if (row.last_health_at) {
    const parsed = row.last_health_json ? (JSON.parse(row.last_health_json) as { role?: string; latencyMs?: number; error?: string }) : {};
    lastHealth = {
      ok: row.last_health_ok === 1,
      at: row.last_health_at,
      role: parsed.role,
      latencyMs: parsed.latencyMs,
      error: parsed.error,
    };
  }
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    kind: row.kind,
    host: row.host,
    port: row.port,
    databaseName: row.database_name,
    username: row.username,
    credentialRef: credentialRef(row.id),
    version: row.version,
    lastHealth,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    status: String(row.status) as JobStatus,
    actor: String(row.actor),
    targetType: row.target_type ? String(row.target_type) : null,
    targetId: row.target_id ? String(row.target_id) : null,
    payload: JSON.parse(String(row.payload ?? '{}')) as Record<string, unknown>,
    result: row.result ? (JSON.parse(String(row.result)) as Record<string, unknown>) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

export function openStore(dbPath: string): Store {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  const store = new Store(db);
  store.migrate();
  if (dbPath !== ':memory:') {
    fs.chmodSync(dbPath, 0o600);
  }
  return store;
}
