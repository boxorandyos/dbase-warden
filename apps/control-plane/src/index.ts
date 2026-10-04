import path from 'node:path';
import { createDefaultRegistry } from '@dbase-warden/engines';
import { createApp } from './app';
import { plannedProcessController, systemProcessController } from './operations';
import { openStore } from './store';

const port = Number(process.env.PORT || process.env.DBASE_API_PORT || 3101);
const host = process.env.HOST || '0.0.0.0';
const dbPath = process.env.DBASE_DB_PATH || './data/dbase.sqlite';
const jwtSecret = process.env.DBASE_JWT_SECRET || '';

if (!jwtSecret && process.env.NODE_ENV === 'production') {
  throw new Error('DBASE_JWT_SECRET is required in production');
}

const store = openStore(dbPath);
const admin = store.bootstrapAdmin({
  username: process.env.DBASE_ADMIN_USERNAME || 'admin',
  password: process.env.DBASE_ADMIN_PASSWORD,
  allowDevDefault: process.env.NODE_ENV !== 'production',
});

if (admin && !process.env.DBASE_ADMIN_PASSWORD) {
  console.warn('Bootstrapped admin user "admin" with the development password "dbase-admin". Set DBASE_ADMIN_PASSWORD before exposing this service.');
}

const registry = createDefaultRegistry();
void registry.initAll().then(() => {
  const app = createApp({
    store,
    registry,
    jwtSecret: jwtSecret || 'dev-only-change-me',
    corsOrigin: process.env.CORS_ORIGIN,
    webDist: process.env.WEB_DIST,
    backupDir: process.env.DBASE_BACKUP_DIR || path.join(path.dirname(dbPath === ':memory:' ? './data/dbase.sqlite' : dbPath), 'backups'),
    processController: process.env.DBASE_ALLOW_PROCESS_CONTROL === '1' ? systemProcessController() : plannedProcessController(),
    maintenance: {
      allowHostUpdate: process.env.DBASE_ALLOW_HOST_UPDATE === '1',
      nodeRole: process.env.DBASE_NODE_ROLE === 'slave' ? 'slave' : 'master',
      maintenanceKey: process.env.DBASE_MAINTENANCE_KEY,
      root: process.env.DBASE_ROOT || path.resolve(process.cwd(), '..', '..'),
    },
  });
  const server = app.listen(port, host, () => {
    console.log(`Dbase Warden control plane listening on ${host}:${port}`);
  });
  const shutdown = async () => {
    server.close();
    await registry.shutdownAll();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
});
