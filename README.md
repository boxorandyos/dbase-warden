# Dbase Warden

Dbase Warden is a database/server management platform in the Warden family, designed to follow the same user experience patterns as Nginx Warden and Mail Warden while focusing on data infrastructure.

## Mission

Build a single system that scales from:

- a basic single-node deployment
- to multi-node production clusters

And that provides:

- **Management** (provisioning, lifecycle, backups, automation)
- **Monitoring** (health, metrics, logs, alerting, SLO visibility)
- **Security** (access controls, hardening, auditability, threat reduction)

## Target managed platforms

Initial focus includes:

- MySQL
- MariaDB
- PostgreSQL

The architecture is intentionally extensible for additional SQL engines and supporting services.

## Product pillars

1. **Control Plane First**  
   A central API/service layer coordinates inventory, policies, jobs, and orchestration.
2. **Operator UX Consistency**  
   GUI behavior mirrors Nginx Warden and Mail Warden, with a Dbase-specific color theme.
3. **Progressive Complexity**  
   The same workflows should work for simple setups and large clusters.
4. **Security by Default**  
   Least-privilege access, auditable actions, and secure defaults everywhere.

## Repository layout

- `docs/` architecture, roadmap, UI theme, and the [v1 API contract](docs/API.md)
- `apps/control-plane/` versioned HTTP API, auth, inventory, jobs, and audit
- `apps/web-console/` operator console aligned with the Warden family shell
- `services/engines/` connector interface and the PostgreSQL, MySQL, and MariaDB connectors
- `deploy/` container image for the combined API and console

## Run locally

Requires Node.js 22 and pnpm 8.

```bash
pnpm install
pnpm --filter @dbase-warden/engines build
pnpm --filter @dbase-warden/control-plane dev
pnpm --filter @dbase-warden/web-console dev
```

The API listens on port **3101**. The console listens on port **8188** and proxies `/api` to the control plane.

When the user table is empty and `DBASE_ADMIN_PASSWORD` is unset outside production, the API creates `admin` / `dbase-admin` and prints a warning. Set `DBASE_ADMIN_PASSWORD` (8+ characters) and `DBASE_JWT_SECRET` before any shared deployment. See `.env.example`.

```bash
pnpm test
pnpm build
```

## Current status

The control plane and console cover inventory, jobs, metrics, alerts, events, backups, hardening policies, service accounts, secret rotation, cluster promotion, runbooks, and environments. PostgreSQL, MySQL, and MariaDB connectors collect health, metrics, backup catalogs, and hardening checks. Operators can create and disable alert rules and policies, record events, verify a backup catalog, rotate a `local://` secret, and plan start, stop, and restart when an engine has a service unit.

Engine passwords stay in the control-plane database file. Backup artifacts are catalogs of database names and sizes, and restore verifies that catalog without replaying data files. Process control plans a `systemctl` action and runs it only when `DBASE_ALLOW_PROCESS_CONTROL=1`. MySQL and MariaDB promotion updates the recorded topology and does not change server `read_only`. Human users can read every environment; the console filters the current one. A service account pinned to an environment is rejected by the API if it asks for another. Jobs run inside the request that creates them.
