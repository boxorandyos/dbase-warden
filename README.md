# Dbase Warden

Control plane for **PostgreSQL**, **MySQL**, and **MariaDB** inventory: **health**, **metrics**, **backup catalogs**, **policies**, and **jobs**—delivered as a **web console** and **REST API** (Node). The control plane keeps its own state in **SQLite**.

**Repository:** [github.com/boxorandyos/dbase-warden](https://github.com/boxorandyos/dbase-warden)

The shipped install is one container. There is no `deploy.sh` and no systemd unit in this repo.

---

## What it does

- Register PostgreSQL, MySQL, and MariaDB instances and collect health, metrics, and hardening checks.
- Record backup catalogs, verify those catalogs, rotate `local://` secrets, and plan start, stop, and restart against a service unit.
- Sign operators in with refresh sessions, TOTP, and optional LDAP or OIDC. Roles are admin, moderator, and viewer.
- Track environments, `dw_` service accounts, runbooks, fleet alert rules, and a platform snapshot that a master can push to registered nodes.

The **supported install** is **Linux** with Docker, or a local Node.js 22 toolchain for development. Host package updates target Debian/Ubuntu package names and run only when you opt in.

---

## Quick reference

| Action | Command / location |
|--------|-------------------|
| **Production install** | `docker compose -f deploy/docker-compose.yml up --build` |
| **Upgrade (CLI)** | `git pull` then `bash scripts/update.sh` |
| **Local API + console** | `pnpm --filter @dbase-warden/control-plane dev` and `pnpm --filter @dbase-warden/web-console dev` |
| **Environment** | `.env.example` and `apps/control-plane/.env.example` |
| **Required secrets** | `DBASE_JWT_SECRET`, `DBASE_ADMIN_PASSWORD` (8+ characters) |

Install path = **wherever you clone the repo**. The container stores SQLite on the `dbase-data` volume.

---

## Ports

| Port | Service |
|------|---------|
| **3101** | REST API. In the Compose profile the same port also serves the built console. |
| **8188** | Console dev server (Vite). It proxies `/api` to port 3101. |

Health check: `GET http://<host>:3101/api/health`

The databases you inventory listen on their own ports. This product does not publish them.

---

## Production install

**Requirements:** Docker, and two secrets you generate yourself. The image is built from `deploy/Dockerfile` (Node 22, pnpm 8.15.0). `deploy/docker-compose.yml` runs that image with a SQLite volume.

```bash
git clone https://github.com/boxorandyos/dbase-warden.git
cd dbase-warden
export DBASE_JWT_SECRET="$(openssl rand -hex 32)"
export DBASE_ADMIN_PASSWORD="$(openssl rand -base64 18)"
docker compose -f deploy/docker-compose.yml up --build
```

Open `http://<host>:3101`. The bootstrap admin username defaults to `admin`. Highly available and multi-region control planes are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). This repository does not ship manifests for them.

### Configuration highlights

Copy `.env.example` for local runs. The Compose file sets production values itself and refuses to start without `DBASE_JWT_SECRET` and `DBASE_ADMIN_PASSWORD`.

- **API bind:** `HOST=0.0.0.0`, `PORT=3101`.
- **SQLite file:** `DBASE_DB_PATH`. In Compose this is `/data/dbase.sqlite` on the `dbase-data` volume. File mode is `0600`.
- **CORS:** `CORS_ORIGIN`. Compose defaults to `http://localhost:3101`. Local Vite uses `http://localhost:8188`.
- **Console files:** `WEB_DIST` points at the built console. Compose sets `/app/apps/web-console/dist`. Leave it unset for the Vite dev server.
- **Process control:** `DBASE_ALLOW_PROCESS_CONTROL=1` runs the planned `systemctl` start, stop, or restart. The default records the plan and does not call `systemctl`.
- **Host updates:** `DBASE_ALLOW_HOST_UPDATE=1` runs `scripts/update.sh` or `scripts/update-packages.sh`. Otherwise the API records the planned command. `WARDEN_ALLOW_HOST_UPDATE=1` runs the script even when the dbase flag is unset; `WARDEN_ALLOW_HOST_UPDATE=0` plans it.
- **Node role:** `DBASE_NODE_ROLE=master` on the node that may trigger slaves. A slave accepts `POST /api/v1/maintenance/apply` when `X-Maintenance-Key` matches `DBASE_MAINTENANCE_KEY`.

When the user table is empty and `DBASE_ADMIN_PASSWORD` is unset outside production, the API creates `admin` / `dbase-admin` and prints a warning. Do not use that password on a shared machine.

---

## Upgrading

`scripts/update.sh` fast-forwards the configured branch (default `origin` / `main`), runs `pnpm install --frozen-lockfile` and `pnpm build`, and restarts a systemd unit named `dbase-warden` **only if you created that unit yourself**. The repo does not include the unit file. With the Compose install, rebuild the image instead:

```bash
cd /path/to/dbase-warden
git pull
docker compose -f deploy/docker-compose.yml up --build -d
```

The SQLite volume is kept across recreates. Copy the volume before an upgrade you may need to undo.

Rebuilding the image uses Node 24. The SQLite volume is unchanged. Maintenance → Move Node to 24 is the host-install path. pnpm stays on the version in `package.json`: [docs/RUNTIME_UPGRADES.md](docs/RUNTIME_UPGRADES.md).

`scripts/update-packages.sh` (root) upgrades installed packages from a fixed list: `postgresql`, `postgresql-client`, `mysql-server`, `mariadb-server`, `ca-certificates`, `openssl`. Packages that are not installed are skipped. It does not install a database server that is missing.

The console **Maintenance** page (admin) can request a product rebuild, the package upgrade, or a fan-out to registered slaves. Those calls stay planned until the host-update flag above is set.

`GET /metrics` is Prometheus text. **Snapshots** captures and applies the platform document (environments, runbooks, alert rules, policies). **Identity** stores LDAP and OIDC providers.

---

## Development

Requires Node.js 22 or newer and pnpm 8.15.0. The container image builds on Node 24, the current long-term support release.

```bash
pnpm install
pnpm --filter @dbase-warden/engines build
pnpm --filter @dbase-warden/control-plane dev    # http://localhost:3101
pnpm --filter @dbase-warden/web-console dev      # http://localhost:8188
```

```bash
pnpm test
pnpm build
```

Set `DBASE_JWT_SECRET` and `DBASE_ADMIN_PASSWORD` in the environment or in `apps/control-plane/.env` before pointing the API at anything other than your own laptop.

---

## Operations

Compose logs:

```bash
docker compose -f deploy/docker-compose.yml logs -f control-plane
```

Host update scripts append to `/var/log/dbase-warden-update.log` unless `DBASE_UPDATE_LOG` is set.

### What this install does and does not do

Engine passwords stay in the control-plane SQLite file. Backup artifacts are catalogs of database names and sizes. Restore checks that catalog and does not replay data files. MySQL and MariaDB promotion updates the recorded topology and does not change server `read_only`. Human users can read every environment; the console filters the current one. A service account pinned to an environment is rejected when it asks for another. Jobs run inside the request that creates them. Fleet alerts are evaluated when an operator asks, not on a timer.

---

## Troubleshooting (short)

| Issue | What to check |
|-------|----------------|
| **Compose exits immediately** | `DBASE_JWT_SECRET` and `DBASE_ADMIN_PASSWORD` are set in the shell that runs Compose. |
| **Port in use** | Listener on **3101** (API and production console) or **8188** (Vite). |
| **Console calls the wrong API** | Local Vite proxies `/api` to 3101. Production serves both from 3101. `CORS_ORIGIN` must match the browser origin. |
| **Empty inventory after restart** | Compose volume `dbase-data`. A local run uses `DBASE_DB_PATH` (default `./data/dbase.sqlite` under the control-plane package). |
| **Start/stop did not change the database** | `DBASE_ALLOW_PROCESS_CONTROL` is unset or `0`, so the API stored a plan. |
| **Update did not restart the process** | `scripts/update.sh` restarts `dbase-warden.service` only when that unit exists. The Compose service needs `docker compose up --build -d`. |

---

## Documentation in this repo

| Resource | Path |
|----------|------|
| HTTP API | [docs/API.md](docs/API.md) |
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Roadmap | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Console theme | [docs/UI_THEME.md](docs/UI_THEME.md) |
| Container image | [deploy/README.md](deploy/README.md) |
| Node major upgrades | [docs/RUNTIME_UPGRADES.md](docs/RUNTIME_UPGRADES.md) |

---

## Tech stack (summary)

| Layer | Stack |
|-------|--------|
| **UI** | React, TypeScript, Vite |
| **API** | Node.js 22, Express, SQLite (`node:sqlite`), JWT and refresh |
| **Engines** | PostgreSQL, MySQL, and MariaDB connectors in `services/engines` |

---

## Contributing

1. Branch from `main`.
2. Keep changes focused.
3. Run `pnpm test` and `pnpm build` for the packages you touch.
4. Open a pull request with a clear description.

Commit messages use conventional prefixes (`feat:`, `fix:`, `docs:`, …).

---

## Security

Report vulnerabilities privately to the maintainers. Do not open public issues for unfixed exploits. Set `DBASE_JWT_SECRET` and `DBASE_ADMIN_PASSWORD` before any shared deployment, and keep the SQLite file private.
