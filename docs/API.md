# Dbase Warden API contract (v1)

## Versioning

- Product routes live under `/api/v1`.
- A breaking change ships as `/api/v2` and keeps `/api/v1` available until an explicit retirement note in this document.
- Additive fields and new routes are backward compatible inside `v1`.
- `GET /api/health` is unversioned liveness and is not part of the resource contract.
- `GET /api/v1/info` reports `apiVersion` and the connector registry.

## Envelope

Success:

```json
{ "success": true, "data": {} }
```

Failure:

```json
{ "success": false, "message": "why" }
```

Health matches the Warden family shape: `{ "success": true, "message": "API is running", "timestamp": "..." }`.

## Authentication

`POST /api/v1/auth/login` with `{ "username", "password" }` returns `{ accessToken, user }`.

Send `Authorization: Bearer <accessToken>` on every other `/api/v1` route except `GET /api/v1/info`.

Roles, aligned with Nginx Warden:

| Role | Access |
|------|--------|
| `viewer` | Read inventory, jobs, audit, and connectors |
| `moderator` | Viewer plus register servers, engines, clusters, and run jobs |
| `admin` | Moderator plus user administration |

Tokens expire after 12 hours.

## Resources

| Method | Path | Roles |
|--------|------|-------|
| `GET` | `/api/health` | public |
| `GET` | `/api/v1/info` | public |
| `POST` | `/api/v1/auth/login` | public |
| `GET` | `/api/v1/auth/me` | any |
| `GET` | `/api/v1/servers` | any |
| `POST` | `/api/v1/servers` | moderator, admin |
| `DELETE` | `/api/v1/servers/:id` | moderator, admin |
| `GET` | `/api/v1/engines` | any |
| `POST` | `/api/v1/engines` | moderator, admin |
| `POST` | `/api/v1/engines/:id/health` | moderator, admin |
| `GET` | `/api/v1/clusters` | any |
| `POST` | `/api/v1/clusters` | moderator, admin |
| `POST` | `/api/v1/clusters/:id/members` | moderator, admin |
| `DELETE` | `/api/v1/clusters/:id` | moderator, admin |
| `GET` | `/api/v1/connectors` | any |
| `GET` | `/api/v1/jobs` | any |
| `POST` | `/api/v1/jobs` | moderator, admin |
| `GET` | `/api/v1/audit` | any |
| `GET` | `/api/v1/users` | admin |
| `POST` | `/api/v1/users` | admin |
| `PATCH` | `/api/v1/users/:id` | admin |
| `DELETE` | `/api/v1/users/:id` | admin |

### Engine registration

```json
{
  "name": "orders",
  "kind": "postgresql",
  "host": "10.0.0.5",
  "port": 5432,
  "databaseName": "orders",
  "username": "warden",
  "password": "stored-as-a-secret",
  "serverId": "optional-server-id"
}
```

The response includes `credentialRef` (`local://<engine-id>`) and never returns the password. The secret is stored in the control-plane database file (mode `0600`). Replace this local provider before production use.

`kind` is `postgresql`, `mysql`, or `mariadb`. All three connectors implement health, discovery, metrics, backup catalogs, hardening, promotion, and password rotation. Optional `serviceUnit` is the systemd unit used by `engine.control`.

`POST /api/v1/jobs` with `type: "secret.rotate"` accepts `engineId`, `password`, and `apply`. `apply: true` runs the connector statement. The password is never written to the job result or the audit export.

### Jobs

`POST /api/v1/jobs` body: `{ "type": "engine.health" | "engine.validate" | "engine.discover", "engineId": "..." }`.

The phase 1 runner records `queued` → `running` → `succeeded` or `failed` and writes an audit event. A failed probe returns HTTP 422 with the job in `data` so the audit trail is still visible to the caller.

## Errors

| Status | When |
|--------|------|
| 400 | Invalid body |
| 401 | Missing or invalid token, bad login |
| 403 | Role does not allow the action |
| 404 | Unknown resource or route |
| 409 | Conflict (duplicate name, last admin, server still has engines) |
| 422 | Job finished with a failed probe |
| 500 | Unexpected failure |

## Operations added after the foundation

These routes use the same envelope, roles, and `/api/v1` version.

| Method | Path | Roles |
|--------|------|-------|
| `GET` `POST` | `/api/v1/environments` | read: any, create: admin |
| `GET` `POST` `DELETE` | `/api/v1/service-accounts` | admin. Create returns the `dw_` token once |
| `GET` `POST` | `/api/v1/alerts/rules` | read: any, create: moderator, admin |
| `PATCH` | `/api/v1/alerts/rules/:id` | moderator, admin. Body `{ "enabled": true \| false }` |
| `GET` | `/api/v1/alerts` | any |
| `GET` | `/api/v1/metrics/:engineId` | any |
| `GET` `POST` | `/api/v1/events` | read: any, ingest: moderator, admin |
| `GET` | `/api/v1/backups` | any |
| `GET` | `/api/v1/findings` | any |
| `GET` `POST` | `/api/v1/policies` | read: any, create: admin |
| `PATCH` | `/api/v1/policies/:id` | admin. Body `{ "enabled": true \| false }` |
| `GET` | `/api/v1/policies/violations` | any. Read-only evaluation |
| `POST` | `/api/v1/policies/evaluate` | any. Same payload as the GET |
| `GET` `POST` | `/api/v1/runbooks` | read: any, write: moderator, admin |
| `GET` | `/api/v1/secrets/:engineId` | admin. Versions only, never the secret |
| `GET` | `/api/v1/audit/export?format=json\|csv` | any |

`POST /api/v1/maintenance/product` and `POST /api/v1/maintenance/packages` are admin-only. They plan `scripts/update.sh` or `scripts/update-packages.sh` and run the script when `DBASE_ALLOW_HOST_UPDATE=1`. Package updates upgrade installed packages from a fixed list: `postgresql`, `postgresql-client`, `mysql-server`, `mariadb-server`, `ca-certificates`, `openssl`.

`POST /api/v1/warden-nodes` registers a slave control plane. The response includes a `dw_` token once. The slave sets that value as `DBASE_MAINTENANCE_KEY` and `DBASE_NODE_ROLE=slave`. `POST /api/v1/maintenance/slaves` on a master calls each slave's `POST /api/v1/maintenance/apply` with `X-Maintenance-Key`. `POST /api/v1/warden-nodes/heartbeat` updates `lastSeenAt` for that token. `POST /api/v1/platform/sync` pushes environments, runbooks, alert rules, and policies to each registered node.

Sign-in returns an access token and a refresh token, and opens a session. `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/sessions`, and `POST /api/v1/auth/logout-all` manage that session. `POST /api/v1/auth/2fa/setup` and `POST /api/v1/auth/2fa/enable` turn on TOTP. A user created by an admin has `mustChangePassword` until `POST /api/v1/auth/first-login/change-password`. LDAP and OIDC providers are stored with `POST /api/v1/identity/providers`. `POST /api/v1/auth/ldap` binds with a provider. `GET /api/v1/auth/oidc/start` redirects to the issuer.

`GET /metrics` is Prometheus text. `GET /api/v1/metrics` is the same sample as JSON. `POST /api/v1/platform/snapshots` stores the platform document, and `POST /api/v1/platform/snapshots/:id/apply` restores it. `GET /api/v1/platform/logs` tails the configured update log. `WARDEN_ALLOW_HOST_UPDATE=1` runs host maintenance even when `DBASE_ALLOW_HOST_UPDATE` is unset, and `0` forces the planned response.

`POST /api/v1/jobs` accepts:

`engine.health`, `engine.validate`, `engine.discover`, `engine.metrics`, `engine.backup`, `engine.restore`, `engine.harden`, `engine.control`, `engine.promote`, `server.sync`, `secret.rotate`.

Inventory lists accept `environmentId`. A service account pinned to an environment cannot read another one.

Backups are `dbase-manifest-v1` catalogs (database names and sizes). Restore verifies the catalog and does not replay data files. Start, stop, and restart record a `systemctl` plan unless `DBASE_ALLOW_PROCESS_CONTROL=1`. Password rotation stores a new `local://` version and, when `apply` is true, issues `ALTER ROLE` or `ALTER USER` through the connector.
