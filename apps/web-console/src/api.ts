const TOKEN_KEY = 'dbase_token';

export interface ApiUser {
  id: string;
  username: string;
  role: 'admin' | 'moderator' | 'viewer';
  createdAt: string;
  mustChangePassword?: boolean;
  totpEnabled?: boolean;
  email?: string;
  authProvider?: string;
}

export interface ServerRecord {
  id: string;
  name: string;
  hostname: string;
  sshPort: number;
  description: string;
  environmentId: string | null;
}

export interface EngineRecord {
  id: string;
  serverId: string | null;
  name: string;
  kind: 'postgresql' | 'mysql' | 'mariadb';
  host: string;
  port: number;
  databaseName: string;
  username: string;
  credentialRef: string;
  serviceUnit: string;
  environmentId: string | null;
  version: string | null;
  lastHealth: { ok: boolean; at: string; role?: string; latencyMs?: number; error?: string } | null;
}

export interface ClusterRecord {
  id: string;
  name: string;
  kind: string;
  description: string;
  environmentId: string | null;
  members: Array<{ engineId: string; role: string; engineName: string }>;
}

export interface JobRecord {
  id: string;
  type: string;
  status: string;
  actor: string;
  error: string | null;
  createdAt: string;
  result: Record<string, unknown> | null;
}

export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  resourceType: string;
  detail: string;
  createdAt: string;
}

export interface ConnectorInfo {
  kind: string;
  implemented: boolean;
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; message?: string; data?: T };
  const authAttempt = ['/auth/login', '/auth/verify-2fa', '/auth/first-login/change-password', '/auth/ldap', '/auth/refresh'].some((item) => path.includes(item));
  if (response.status === 401 && !authAttempt) {
    setToken(null);
    if (!window.location.pathname.startsWith('/login')) window.location.assign('/login');
  }
  if (!response.ok || body.success === false) {
    throw new ApiError(body.message || `Request failed (${response.status})`, response.status);
  }
  return body.data as T;
}
