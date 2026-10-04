# Deploy

Deployment-related assets and documentation for progressive footprints:

- simple single-node profile
- standard HA profile
- cluster/enterprise profile

`Dockerfile` builds the control plane and the web console into one image. `docker-compose.yml` runs that image with a SQLite volume.

```bash
export DBASE_JWT_SECRET="$(openssl rand -hex 32)"
export DBASE_ADMIN_PASSWORD="$(openssl rand -base64 18)"
docker compose -f deploy/docker-compose.yml up --build
```

The console and API are both served on port 3101 in that profile. Local development uses the Vite server on port 8188 instead.
