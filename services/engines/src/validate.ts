import type { ConfigValidation, EngineTarget } from './types';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateTarget(target: EngineTarget, defaultPort: number): ConfigValidation {
  const issues: string[] = [];
  if (!target.host || !target.host.trim()) {
    issues.push('host is required');
  }
  const port = target.port || defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push('port must be an integer between 1 and 65535');
  }
  if (!target.username || !target.username.trim()) {
    issues.push('username is required');
  }
  if (target.database && !IDENT.test(target.database)) {
    issues.push('database name must be a simple identifier');
  }
  return { valid: issues.length === 0, issues };
}
