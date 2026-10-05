#!/usr/bin/env bash
# Build the control-plane image with another Node major and run the tests.
# The Compose service and the SQLite volume are not changed.
# Usage: bash scripts/try-node.sh <22|24|26>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAJOR="${1:-}"
case "${MAJOR}" in
  22|24|26) ;;
  *)
    echo "Usage: bash scripts/try-node.sh <22|24|26>" >&2
    exit 2
    ;;
esac
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required." >&2
  exit 1
fi

image="node:${MAJOR}-bookworm-slim"
tag="dbase-warden:node${MAJOR}"
echo "Building ${tag} from ${image}"
docker build \
  --build-arg NODE_IMAGE="${image}" \
  -f "${ROOT}/deploy/Dockerfile" \
  -t "${tag}" \
  "${ROOT}"
docker run --rm "${tag}" pnpm test
echo "Tests passed on ${image}. The running container was not replaced."
echo "To switch the Compose service after that result:"
echo "  DBASE_NODE_IMAGE=${image} docker compose -f deploy/docker-compose.yml up --build -d"
echo "The SQLite volume is reused. Copy it first if you want a rollback of the data file."
