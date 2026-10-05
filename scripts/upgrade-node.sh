#!/usr/bin/env bash
# Replace the system Node.js major on a host install. The container image is unchanged.
# Usage: sudo UPGRADE_NODE_CONFIRM=1 bash scripts/upgrade-node.sh <22|24|26>
set -euo pipefail

MAJOR="${1:-}"
case "${MAJOR}" in
  22|24|26) ;;
  *)
    echo "Usage: sudo UPGRADE_NODE_CONFIRM=1 bash scripts/upgrade-node.sh <22|24|26>" >&2
    echo "The control plane requires Node 22 or newer. 24 is the current long-term support line." >&2
    exit 2
    ;;
esac

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi
if [[ "${UPGRADE_NODE_CONFIRM:-}" != 1 ]]; then
  echo "This replaces the nodejs package on this machine. The running process keeps the old Node until you rebuild and restart." >&2
  echo "Re-run with UPGRADE_NODE_CONFIRM=1" >&2
  exit 2
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script installs Node from NodeSource with apt. It does not support this OS." >&2
  exit 1
fi

current=0
if command -v node >/dev/null 2>&1; then
  current="$(node -v | cut -d. -f1 | tr -d v)"
fi
if [[ "${current}" -eq "${MAJOR}" ]]; then
  echo "Node $(node -v) is already major ${MAJOR}."
  exit 0
fi
if [[ "${current}" -gt "${MAJOR}" ]]; then
  echo "Node $(node -v) is newer than ${MAJOR}. Refusing to downgrade." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive
curl -fsSL "https://deb.nodesource.com/setup_${MAJOR}.x" | bash -
apt-get install -y nodejs
hash -r || true
corepack enable || true
pin="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' "${ROOT}/package.json" | head -1)"
if [[ -n "${pin}" ]]; then
  corepack prepare "pnpm@${pin}" --activate || true
fi
echo "Node is now $(node -v)."
echo "Rebuild before serving traffic: bash scripts/update.sh"
echo "A Compose install ignores this script. Test a new image with bash scripts/try-node.sh ${MAJOR}"
