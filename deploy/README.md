# Deploy

The shipped footprint is the simple single-node profile. `Dockerfile` builds the control plane and the web console into one image. `docker-compose.yml` runs that image with a SQLite volume.

Highly available and multi-region control planes are described as target profiles in `docs/ARCHITECTURE.md`. This directory does not include manifests for them.

```bash
export DBASE_JWT_SECRET="$(openssl rand -hex 32)"
export DBASE_ADMIN_PASSWORD="$(openssl rand -base64 18)"
docker compose -f deploy/docker-compose.yml up --build
```

The console and API are both served on port 3101 in that profile. Local development uses the Vite server on port 8188 instead.

The image builds on Node 22. `DBASE_NODE_IMAGE` selects a different base for a trial build. See `docs/RUNTIME_UPGRADES.md` before pointing a running volume at that image.
