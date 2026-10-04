# Control plane

HTTP API for inventory, auth, jobs, and audit.

- `GET /api/health` liveness
- `/api/v1/*` versioned resources (see `docs/API.md`)
- SQLite file from `DBASE_DB_PATH` (default `./data/dbase.sqlite`)
- JWT roles: `admin`, `moderator`, `viewer`

```bash
pnpm --filter @dbase-warden/control-plane dev
pnpm --filter @dbase-warden/control-plane test
```
