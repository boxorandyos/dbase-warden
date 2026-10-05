# Runtime upgrades

`scripts/update.sh` and `docker compose up --build` rebuild the application on the Node version already selected. They do not move that version forward. The image stays on Node 22, and pnpm stays on the `packageManager` field in `package.json`, until you opt in.

Node 22 is in maintenance until April 2027. Node 24 is the current long-term support line. Node 26 is Current until it enters long-term support. The control plane uses `node:sqlite`, so a major has to pass the test script before it replaces a running server.

## Container install

Build and test a second image. This does not recreate the Compose service and does not open the SQLite volume.

```bash
bash scripts/try-node.sh 24
```

When those tests pass, switch with:

```bash
DBASE_NODE_IMAGE=node:24-bookworm-slim docker compose -f deploy/docker-compose.yml up --build -d
```

`deploy/docker-compose.yml` uses `DBASE_NODE_IMAGE` when it is set and otherwise builds `node:22-bookworm-slim`. The SQLite file stays on the `dbase-data` volume. Copy that volume before the switch if you want a data rollback. Roll the process back by building again without `DBASE_NODE_IMAGE`.

## Host install

`scripts/upgrade-node.sh` replaces the system Node.js package. It is not used by the container.

```bash
sudo UPGRADE_NODE_CONFIRM=1 bash scripts/upgrade-node.sh 24
bash scripts/update.sh
```

Allowed majors are 22, 24, and 26. The script refuses to install an older major than the one already present. `update.sh` reinstalls dependencies from the lockfile and restarts a `dbase-warden` systemd unit only when you created that unit yourself.

## pnpm

Do not install a newer pnpm on the server ahead of the repository. `package.json` says `pnpm@8.15.0`, and the image activates that same field. A newer pnpm belongs in a release that updates `packageManager` and `pnpm-lock.yaml` together. Until that release, installs keep using 8.15.0.

## Databases this product manages

PostgreSQL, MySQL, and MariaDB packages on the host are upgraded only through `scripts/update-packages.sh`, and only for packages already installed. That script does not jump a major that would rewrite an existing data directory. Major upgrades of those engines stay a database-maintenance task outside this control plane.
