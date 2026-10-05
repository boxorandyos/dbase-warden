import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

export const PACKAGE_ALLOWLIST = [
  'postgresql',
  'postgresql-client',
  'mysql-server',
  'mariadb-server',
  'ca-certificates',
  'openssl',
] as const;

export type MaintenanceKind = 'product' | 'packages';

export interface MaintenanceNode {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
}

export interface MaintenanceCall {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  body: { kind: MaintenanceKind };
}

export function hostUpdateAllowed(productDefault: boolean, override = process.env.WARDEN_ALLOW_HOST_UPDATE): boolean {
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  return productDefault;
}

export function parseMaintenanceKind(value: unknown): MaintenanceKind {
  if (value === 'product' || value === 'packages') return value;
  throw new Error('kind must be product or packages');
}

export function maintenanceKeyMatches(expected: string | undefined, presented: string | undefined): boolean {
  if (!expected || !presented) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function slaveMaintenanceUrl(host: string, port: number): string {
  const trimmed = host.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) throw new Error(`Refusing slave host ${host}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Slave port is invalid');
  return `http://${trimmed}:${port}/api/v1/maintenance/apply`;
}

export function planSlaveUpgrades(nodes: MaintenanceNode[], kind: MaintenanceKind): MaintenanceCall[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    url: slaveMaintenanceUrl(node.host, node.port),
    headers: { 'X-Maintenance-Key': node.token, 'Content-Type': 'application/json' },
    body: { kind },
  }));
}

export function describeRuntimes(nodeVersion: string) {
  return [
    {
      id: 'node',
      current: nodeVersion,
      newInstall: '24',
      latestLts: '24',
      note: 'The container image builds on Node 24. This action replaces Node on a host install and then you run the product update. pnpm stays on the version in package.json.',
      canRun: true,
    },
  ];
}

export function planRuntime(component: string, allow: boolean): { component: 'node'; executed: boolean; detail: string } {
  if (component !== 'node') throw new Error('component must be node');
  const detail = 'bash scripts/upgrade-node.sh 24';
  if (!allow) return { component, executed: false, detail: `${detail} (set WARDEN_ALLOW_HOST_UPDATE=1 to run it)` };
  return { component, executed: true, detail: `scheduled: ${detail}` };
}

export async function scheduleRuntime(
  root: string,
  component: string,
  allow: boolean,
): Promise<{ component: 'node'; executed: boolean; detail: string }> {
  const plan = planRuntime(component, allow);
  if (!plan.executed) return plan;
  const script = path.join(root, 'scripts', 'upgrade-node.sh');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', [script, '24'], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, UPGRADE_NODE_CONFIRM: '1' },
    });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
  return plan;
}

export function scriptFor(kind: MaintenanceKind): string {
  return kind === 'packages' ? 'update-packages.sh' : 'update.sh';
}

export async function scheduleMaintenance(
  root: string,
  kind: MaintenanceKind,
  allow: boolean,
): Promise<{ executed: boolean; detail: string }> {
  const script = path.join(root, 'scripts', scriptFor(kind));
  const detail = `bash ${script}`;
  if (!allow) {
    return { executed: false, detail: `${detail} (set WARDEN_ALLOW_HOST_UPDATE=1 to run it)` };
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', [script], { cwd: root, detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
  return { executed: true, detail: `scheduled: ${detail}` };
}

export async function triggerSlaveUpgrades(
  nodes: MaintenanceNode[],
  kind: MaintenanceKind,
  role: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ id: string; name: string; status: number; message: string }>> {
  if (role === 'slave') throw new Error('Only the master can trigger slave upgrades');
  const calls = planSlaveUpgrades(nodes, kind);
  const results = [];
  for (const call of calls) {
    try {
      const response = await fetchImpl(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string; detail?: string };
      results.push({
        id: call.id,
        name: call.name,
        status: response.status,
        message: payload.detail || payload.message || '',
      });
    } catch (error) {
      results.push({
        id: call.id,
        name: call.name,
        status: 0,
        message: error instanceof Error ? error.message : 'request failed',
      });
    }
  }
  return results;
}
