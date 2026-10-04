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

The response includes `credentialRef` (`local://<engine-id>`) and never returns the password. Phase 1 stores that secret in the control-plane database file (mode `0600`). Replace this local provider before production use.

`kind` is `postgresql`, `mysql`, or `mariadb`. PostgreSQL is the reference connector. MySQL and MariaDB are registered plugins whose probes fail with a clear not-implemented error.

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
| `GET` | `/api/v1/alerts` | any |
| `GET` | `/api/v1/metrics/:engineId` | any |
| `GET` `POST` | `/api/v1/events` | read: any, ingest: moderator, admin |
| `GET` | `/api/v1/backups` | any |
| `GET` | `/api/v1/findings` | any |
| `GET` `POST` | `/api/v1/policies` | read: any, create: admin |
| `POST` | `/api/v1/policies/evaluate` | any |
| `GET` `POST` | `/api/v1/runbooks` | read: any, write: moderator, admin |
| `GET` | `/api/v1/secrets/:engineId` | admin. Versions only, never the secret |
| `GET` | `/api/v1/audit/export?format=json\|csv` | any |

`POST /api/v1/jobs` accepts:

`engine.health`, `engine.validate`, `engine.discover`, `engine.metrics`, `engine.backup`, `engine.restore`, `engine.harden`, `engine.control`, `engine.promote`, `server.sync`, `secret.rotate`.

Inventory lists accept `environmentId`. A service account pinned to an environment cannot read another one.

Backups are `dbase-manifest-v1` catalogs (database names and sizes). Restore verifies the catalog and does not replay data files. Start, stop, and restart record a `systemctl` plan unless `DBASE_ALLOW_PROCESS_CONTROL=1`. Password rotation stores a new `local://` version and, when `apply` is true, issues `ALTER ROLE` or `ALTER USER` through the connector.
