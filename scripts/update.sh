#!/usr/bin/env bash
# Update this Dbase Warden install from git, rebuild, and restart the unit when it exists.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${DBASE_UPDATE_LOG:-/var/log/dbase-warden-update.log}"
log() { echo "[$(date -Is)] $*" | tee -a "$LOG_FILE"; }

cd "$ROOT"
if [[ -d .git ]]; then
  remote="${UPDATE_GIT_REMOTE:-origin}"
  branch="${UPDATE_GIT_BRANCH:-main}"
  git fetch "$remote"
  git pull --ff-only "$remote" "$branch"
fi
corepack pnpm install --frozen-lockfile
corepack pnpm build
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^dbase-warden.service'; then
  systemctl restart dbase-warden
  log "restarted dbase-warden"
else
  log "build finished; restart the control plane to pick it up"
fi
