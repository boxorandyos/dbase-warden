import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import type { ConnectorRegistry } from '@dbase-warden/engines';
import { authenticate, authorize, signAccessToken } from './auth';
import { AppError } from './errors';
import { isEngineJobType, plannedProcessController, runEngineJob, type OperationDeps, type ProcessController } from './operations';
import {
  maintenanceKeyMatches,
  parseMaintenanceKind,
  scheduleMaintenance,
  triggerSlaveUpgrades,
  type MaintenanceKind,
} from './maintenance';
import type { Role, Store } from './store';

export interface AppOptions {
  store: Store;
  registry: ConnectorRegistry;
  jwtSecret: string;
  corsOrigin?: string;
  webDist?: string;
  backupDir?: string;
  processController?: ProcessController;
  maintenance?: {
    allowHostUpdate?: boolean;
    nodeRole?: 'master' | 'slave';
    maintenanceKey?: string;
    root?: string;
    fetch?: typeof fetch;
    schedule?: (kind: MaintenanceKind) => Promise<{ executed: boolean; detail: string }>;
  };
}

const writers: Role[] = ['admin', 'moderator'];

export function createApp(options: AppOptions): express.Express {
  const app = express();
  const origin = options.corsOrigin ?? 'http://localhost:8188';
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: origin === '*' ? true : origin.split(',').map((item) => item.trim()) }));
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  const auth = authenticate(options.jwtSecret, (token) => options.store.catalog.findServiceAccount(token));
  const deps: OperationDeps = {
    backupDir: options.backupDir ?? path.join(process.cwd(), 'data', 'backups'),
    processController: options.processController ?? plannedProcessController(),
  };

  const respondJob = (res: express.Response, job: { status: string; error: string | null }, created = false) => {
    const ok = job.status === 'succeeded';
    res.status(ok ? (created ? 201 : 200) : 422).json({ success: ok, message: job.error ?? undefined, data: job });
  };

  api.get('/health', (_req, res) => {
    res.json({ success: true, message: 'API is running', timestamp: new Date().toISOString() });
  });

  api.get('/v1/info', (_req, res) => {
    res.json({
      success: true,
      data: {
        product: 'dbase-warden',
        apiVersion: 'v1',
        connectors: options.registry.describe(),
      },
    });
  });

  api.post('/v1/auth/login', (req, res, next) => {
    try {
      const username = String(req.body?.username ?? '');
      const password = String(req.body?.password ?? '');
      const user = options.store.verifyUser(username, password);
      if (!user) throw new AppError(401, 'Invalid username or password');
      options.store.audit({ actor: user.username, action: 'auth.login', resourceType: 'user', resourceId: user.id });
      res.json({
        success: true,
        data: { accessToken: signAccessToken(user, options.jwtSecret), user },
      });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/auth/me', auth, (req, res) => {
    res.json({ success: true, data: req.user });
  });

  api.get('/v1/servers', auth, (req, res, next) => {
    try {
      res.json({ success: true, data: options.store.listServers(environmentScope(req)) });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/servers', auth, authorize(...writers), (req, res, next) => {
    try {
      const server = options.store.createServer({ ...(req.body ?? {}), environmentId: forcedEnvironment(req) });
      options.store.audit({
        actor: req.user!.username,
        action: 'server.create',
        resourceType: 'server',
        resourceId: server.id,
        detail: server.hostname,
      });
      res.status(201).json({ success: true, data: server });
    } catch (error) {
      next(error);
    }
  });

  api.delete('/v1/servers/:id', auth, authorize(...writers), (req, res, next) => {
    try {
      options.store.deleteServer(req.params.id);
      options.store.audit({
        actor: req.user!.username,
        action: 'server.delete',
        resourceType: 'server',
        resourceId: req.params.id,
      });
      res.json({ success: true, data: { id: req.params.id } });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/engines', auth, (req, res, next) => {
    try {
      res.json({ success: true, data: options.store.listEngines(environmentScope(req)) });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/engines', auth, authorize(...writers), (req, res, next) => {
    try {
      const engine = options.store.createEngine({ ...(req.body ?? {}), environmentId: forcedEnvironment(req) });
      options.store.audit({
        actor: req.user!.username,
        action: 'engine.create',
        resourceType: 'engine',
        resourceId: engine.id,
        detail: `${engine.kind} ${engine.host}:${engine.port}`,
      });
      res.status(201).json({ success: true, data: engine });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/engines/:id/health', auth, authorize(...writers), async (req, res, next) => {
    try {
      const job = await runEngineJob(
        options.store,
        options.registry,
        { type: 'engine.health', engineId: req.params.id, actor: req.user!.username },
        deps,
      );
      respondJob(res, job);
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/clusters', auth, (req, res, next) => {
    try {
      res.json({ success: true, data: options.store.listClusters(environmentScope(req)) });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/clusters', auth, authorize(...writers), (req, res, next) => {
    try {
      const cluster = options.store.createCluster({ ...(req.body ?? {}), environmentId: forcedEnvironment(req) });
      options.store.audit({
        actor: req.user!.username,
        action: 'cluster.create',
        resourceType: 'cluster',
        resourceId: cluster.id,
        detail: cluster.name,
      });
      res.status(201).json({ success: true, data: cluster });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/clusters/:id/members', auth, authorize(...writers), (req, res, next) => {
    try {
      const cluster = options.store.addClusterMember(req.params.id, String(req.body?.engineId ?? ''), String(req.body?.role ?? ''));
      options.store.audit({
        actor: req.user!.username,
        action: 'cluster.member.add',
        resourceType: 'cluster',
        resourceId: cluster.id,
        detail: String(req.body?.engineId ?? ''),
      });
      res.status(201).json({ success: true, data: cluster });
    } catch (error) {
      next(error);
    }
  });

  api.delete('/v1/clusters/:id', auth, authorize(...writers), (req, res, next) => {
    try {
      options.store.deleteCluster(req.params.id);
      options.store.audit({
        actor: req.user!.username,
        action: 'cluster.delete',
        resourceType: 'cluster',
        resourceId: req.params.id,
      });
      res.json({ success: true, data: { id: req.params.id } });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/connectors', auth, (_req, res) => {
    res.json({ success: true, data: options.registry.describe() });
  });

  api.get('/v1/jobs', auth, (_req, res) => {
    res.json({ success: true, data: options.store.listJobs() });
  });

  api.post('/v1/jobs', auth, authorize(...writers), async (req, res, next) => {
    try {
      const type = String(req.body?.type ?? '');
      if (!isEngineJobType(type)) {
        throw new AppError(400, `type must be one of ${['engine.health', 'engine.validate', 'engine.discover', 'engine.metrics', 'engine.backup', 'engine.restore', 'engine.harden', 'engine.control', 'engine.promote', 'server.sync', 'secret.rotate'].join(', ')}`);
      }
      const job = await runEngineJob(
        options.store,
        options.registry,
        {
          type,
          engineId: req.body?.engineId ? String(req.body.engineId) : undefined,
          serverId: req.body?.serverId ? String(req.body.serverId) : undefined,
          clusterId: req.body?.clusterId ? String(req.body.clusterId) : undefined,
          action: req.body?.action,
          password: req.body?.password ? String(req.body.password) : undefined,
          apply: Boolean(req.body?.apply),
          backupId: req.body?.backupId ? String(req.body.backupId) : undefined,
          actor: req.user!.username,
        },
        deps,
      );
      respondJob(res, job, true);
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/audit', auth, (_req, res) => {
    res.json({ success: true, data: options.store.listAudit() });
  });

  api.get('/v1/audit/export', auth, (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const body = options.store.catalog.exportAudit(format);
    res.type(format === 'csv' ? 'text/csv' : 'application/json').send(body);
  });

  api.get('/v1/environments', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listEnvironments() });
  });

  api.post('/v1/environments', auth, authorize('admin'), (req, res, next) => {
    try {
      const environment = options.store.catalog.createEnvironment(req.body ?? {});
      options.store.audit({ actor: req.user!.username, action: 'environment.create', resourceType: 'environment', resourceId: environment.id, detail: environment.name });
      res.status(201).json({ success: true, data: environment });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/service-accounts', auth, authorize('admin'), (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listServiceAccounts() });
  });

  api.post('/v1/service-accounts', auth, authorize('admin'), (req, res, next) => {
    try {
      const account = options.store.catalog.createServiceAccount({
        name: String(req.body?.name ?? ''),
        role: req.body?.role,
        environmentId: req.body?.environmentId ? String(req.body.environmentId) : null,
      });
      options.store.audit({ actor: req.user!.username, action: 'service_account.create', resourceType: 'service_account', resourceId: account.id, detail: account.role });
      res.status(201).json({ success: true, data: account });
    } catch (error) {
      next(error);
    }
  });

  api.delete('/v1/service-accounts/:id', auth, authorize('admin'), (req, res, next) => {
    try {
      options.store.catalog.deleteServiceAccount(req.params.id);
      options.store.audit({ actor: req.user!.username, action: 'service_account.delete', resourceType: 'service_account', resourceId: req.params.id });
      res.json({ success: true, data: { id: req.params.id } });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/alerts/rules', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listRules() });
  });

  api.post('/v1/alerts/rules', auth, authorize(...writers), (req, res, next) => {
    try {
      const rule = options.store.catalog.createRule({
        name: String(req.body?.name ?? ''),
        kind: String(req.body?.kind ?? ''),
        threshold: Number(req.body?.threshold),
      });
      options.store.audit({
        actor: req.user!.username,
        action: 'alert_rule.create',
        resourceType: 'alert_rule',
        resourceId: rule.id,
        detail: rule.kind,
      });
      res.status(201).json({ success: true, data: rule });
    } catch (error) {
      next(error);
    }
  });

  api.patch('/v1/alerts/rules/:id', auth, authorize(...writers), (req, res, next) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') throw new AppError(400, 'enabled must be true or false');
      const rule = options.store.catalog.setRuleEnabled(req.params.id, req.body.enabled);
      options.store.audit({
        actor: req.user!.username,
        action: 'alert_rule.update',
        resourceType: 'alert_rule',
        resourceId: rule.id,
        detail: rule.enabled ? 'enabled' : 'disabled',
      });
      res.json({ success: true, data: rule });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/alerts', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listAlerts() });
  });

  api.get('/v1/metrics/:engineId', auth, (req, res) => {
    res.json({ success: true, data: options.store.catalog.latestMetrics(req.params.engineId) });
  });

  api.get('/v1/events', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listEvents() });
  });

  api.post('/v1/events', auth, authorize(...writers), (req, res, next) => {
    try {
      const event = options.store.catalog.recordEvent({
        source: String(req.body?.source ?? ''),
        severity: req.body?.severity,
        message: String(req.body?.message ?? ''),
        resourceType: String(req.body?.resourceType ?? ''),
        resourceId: req.body?.resourceId ? String(req.body.resourceId) : undefined,
      });
      res.status(201).json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/backups', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listBackups() });
  });

  api.get('/v1/findings', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listFindings() });
  });

  api.get('/v1/policies', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listPolicies() });
  });

  api.post('/v1/policies', auth, authorize('admin'), (req, res, next) => {
    try {
      const policy = options.store.catalog.createPolicy(req.body ?? {});
      options.store.audit({
        actor: req.user!.username,
        action: 'policy.create',
        resourceType: 'policy',
        resourceId: policy.id,
        detail: policy.kind,
      });
      res.status(201).json({ success: true, data: policy });
    } catch (error) {
      next(error);
    }
  });

  api.patch('/v1/policies/:id', auth, authorize('admin'), (req, res, next) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') throw new AppError(400, 'enabled must be true or false');
      const policy = options.store.catalog.setPolicyEnabled(req.params.id, req.body.enabled);
      options.store.audit({
        actor: req.user!.username,
        action: 'policy.update',
        resourceType: 'policy',
        resourceId: policy.id,
        detail: policy.enabled ? 'enabled' : 'disabled',
      });
      res.json({ success: true, data: policy });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/policies/violations', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.evaluatePolicies() });
  });

  api.post('/v1/policies/evaluate', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.evaluatePolicies() });
  });

  api.get('/v1/runbooks', auth, (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listRunbooks() });
  });

  api.post('/v1/runbooks', auth, authorize(...writers), (req, res, next) => {
    try {
      const runbook = options.store.catalog.saveRunbook(req.body ?? {});
      options.store.audit({ actor: req.user!.username, action: 'runbook.save', resourceType: 'runbook', resourceId: runbook.id, detail: runbook.title });
      res.status(201).json({ success: true, data: runbook });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/secrets/:engineId', auth, authorize('admin'), (req, res) => {
    res.json({ success: true, data: options.store.catalog.listSecretVersions(req.params.engineId) });
  });

  api.get('/v1/users', auth, authorize('admin'), (_req, res) => {
    res.json({ success: true, data: options.store.listUsers() });
  });

  api.post('/v1/users', auth, authorize('admin'), (req, res, next) => {
    try {
      const user = options.store.createUser({
        username: String(req.body?.username ?? ''),
        password: String(req.body?.password ?? ''),
        role: req.body?.role,
      });
      options.store.audit({
        actor: req.user!.username,
        action: 'user.create',
        resourceType: 'user',
        resourceId: user.id,
        detail: user.role,
      });
      res.status(201).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  });

  api.patch('/v1/users/:id', auth, authorize('admin'), (req, res, next) => {
    try {
      const user = options.store.updateUser(
        req.params.id,
        { role: req.body?.role, password: req.body?.password },
        req.user!.id,
      );
      options.store.audit({
        actor: req.user!.username,
        action: 'user.update',
        resourceType: 'user',
        resourceId: user.id,
        detail: user.role,
      });
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  });

  api.delete('/v1/users/:id', auth, authorize('admin'), (req, res, next) => {
    try {
      options.store.deleteUser(req.params.id, req.user!.id);
      options.store.audit({
        actor: req.user!.username,
        action: 'user.delete',
        resourceType: 'user',
        resourceId: req.params.id,
      });
      res.json({ success: true, data: { id: req.params.id } });
    } catch (error) {
      next(error);
    }
  });

  const maintenance = options.maintenance ?? {};
  const nodeRole = maintenance.nodeRole ?? 'master';
  const schedule =
    maintenance.schedule ??
    ((kind: MaintenanceKind) =>
      scheduleMaintenance(maintenance.root ?? path.resolve(process.cwd(), '..', '..'), kind, Boolean(maintenance.allowHostUpdate)));

  api.post('/v1/maintenance/apply', async (req, res, next) => {
    try {
      const presented = req.header('x-maintenance-key') ?? undefined;
      if (!maintenanceKeyMatches(maintenance.maintenanceKey, presented)) {
        throw new AppError(401, 'Invalid maintenance key');
      }
      const kind = parseMaintenanceKind(req.body?.kind);
      const result = await schedule(kind);
      res.status(202).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/maintenance/product', auth, authorize('admin'), async (req, res, next) => {
    try {
      const result = await schedule('product');
      options.store.audit({ actor: req.user!.username, action: 'maintenance.product', resourceType: 'node', detail: result.detail });
      res.status(202).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/maintenance/packages', auth, authorize('admin'), async (req, res, next) => {
    try {
      const result = await schedule('packages');
      options.store.audit({ actor: req.user!.username, action: 'maintenance.packages', resourceType: 'node', detail: result.detail });
      res.status(202).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/warden-nodes', auth, authorize('admin'), (_req, res) => {
    res.json({ success: true, data: options.store.catalog.listWardenNodes() });
  });

  api.post('/v1/warden-nodes', auth, authorize('admin'), (req, res, next) => {
    try {
      const node = options.store.catalog.createWardenNode({
        name: String(req.body?.name ?? ''),
        host: String(req.body?.host ?? ''),
        port: req.body?.port === undefined ? undefined : Number(req.body.port),
      });
      options.store.audit({ actor: req.user!.username, action: 'warden_node.create', resourceType: 'node', resourceId: node.id, detail: node.host });
      res.status(201).json({ success: true, data: node });
    } catch (error) {
      next(error);
    }
  });

  api.delete('/v1/warden-nodes/:id', auth, authorize('admin'), (req, res, next) => {
    try {
      options.store.catalog.deleteWardenNode(req.params.id);
      options.store.audit({ actor: req.user!.username, action: 'warden_node.delete', resourceType: 'node', resourceId: req.params.id });
      res.json({ success: true, data: { id: req.params.id } });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/maintenance/slaves', auth, authorize('admin'), async (req, res, next) => {
    try {
      if (nodeRole === 'slave') throw new AppError(403, 'Only the master can trigger slave upgrades');
      const kind = parseMaintenanceKind(req.body?.kind ?? 'product');
      const nodeId = req.body?.nodeId ? String(req.body.nodeId) : undefined;
      const nodes = options.store.catalog.wardenNodesForUpgrade(nodeId);
      const results = await triggerSlaveUpgrades(nodes, kind, nodeRole, maintenance.fetch);
      options.store.audit({
        actor: req.user!.username,
        action: 'maintenance.slaves',
        resourceType: 'node',
        detail: `${kind}:${results.length}`,
      });
      res.json({ success: true, data: { kind, results } });
    } catch (error) {
      next(error);
    }
  });

  api.use((req, res) => {
    res.status(404).json({ success: false, message: `Route ${req.method} ${req.originalUrl} not found` });
  });

  app.use('/api', api);

  if (options.webDist) {
    const webDist = options.webDist;
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(webDist, 'index.html'), (error) => {
        if (error) next();
      });
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ success: false, message });
  });

  return app;
}

function environmentScope(req: express.Request): string | undefined {
  const requested = typeof req.query.environmentId === 'string' ? req.query.environmentId : undefined;
  if (req.user?.environmentId) {
    if (requested && requested !== req.user.environmentId) {
      throw new AppError(403, 'Service account is scoped to another environment');
    }
    return req.user.environmentId;
  }
  return requested;
}

function forcedEnvironment(req: express.Request): string | undefined {
  return req.user?.environmentId || (req.body?.environmentId ? String(req.body.environmentId) : undefined);
}
