import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import type { ConnectorRegistry } from '@dbase-warden/engines';
import { authenticate, authorize, signAccessToken } from './auth';
import { AppError } from './errors';
import { isEngineJobType, runEngineJob } from './operations';
import type { Role, Store } from './store';

export interface AppOptions {
  store: Store;
  registry: ConnectorRegistry;
  jwtSecret: string;
  corsOrigin?: string;
  webDist?: string;
}

const writers: Role[] = ['admin', 'moderator'];

export function createApp(options: AppOptions): express.Express {
  const app = express();
  const origin = options.corsOrigin ?? 'http://localhost:8188';
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: origin === '*' ? true : origin.split(',').map((item) => item.trim()) }));
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  const auth = authenticate(options.jwtSecret);

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

  api.get('/v1/servers', auth, (_req, res) => {
    res.json({ success: true, data: options.store.listServers() });
  });

  api.post('/v1/servers', auth, authorize(...writers), (req, res, next) => {
    try {
      const server = options.store.createServer(req.body ?? {});
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

  api.get('/v1/engines', auth, (_req, res) => {
    res.json({ success: true, data: options.store.listEngines() });
  });

  api.post('/v1/engines', auth, authorize(...writers), (req, res, next) => {
    try {
      const engine = options.store.createEngine(req.body ?? {});
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
      const job = await runEngineJob(options.store, options.registry, {
        type: 'engine.health',
        engineId: req.params.id,
        actor: req.user!.username,
      });
      res.status(job.status === 'succeeded' ? 200 : 422).json({
        success: job.status === 'succeeded',
        message: job.error ?? undefined,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/clusters', auth, (_req, res) => {
    res.json({ success: true, data: options.store.listClusters() });
  });

  api.post('/v1/clusters', auth, authorize(...writers), (req, res, next) => {
    try {
      const cluster = options.store.createCluster(req.body ?? {});
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
        throw new AppError(400, 'type must be engine.health, engine.validate, or engine.discover');
      }
      const job = await runEngineJob(options.store, options.registry, {
        type,
        engineId: String(req.body?.engineId ?? ''),
        actor: req.user!.username,
      });
      res.status(job.status === 'succeeded' ? 201 : 422).json({
        success: job.status === 'succeeded',
        message: job.error ?? undefined,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/audit', auth, (_req, res) => {
    res.json({ success: true, data: options.store.listAudit() });
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
