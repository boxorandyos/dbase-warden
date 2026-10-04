#!/usr/bin/env bash
# Upgrade installed database packages. Package names are fixed in this script.
set -euo pipefail
LOG_FILE="${DBASE_UPDATE_LOG:-/var/log/dbase-warden-update.log}"
PACKAGES=(postgresql postgresql-client mysql-server mariadb-server ca-certificates openssl)
log() { echo "[$(date -Is)] $*" | tee -a "$LOG_FILE"; }

if [[ "${EUID}" -ne 0 ]]; then
  log "package update requires root"
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >>"$LOG_FILE" 2>&1
installed=()
for package in "${PACKAGES[@]}"; do
  if dpkg -s "$package" >/dev/null 2>&1; then
    installed+=("$package")
  else
    log "skip $package (not installed)"
  fi
done
if [[ ${#installed[@]} -eq 0 ]]; then
  log "no allowlisted packages are installed"
  exit 0
fi
apt-get install -y --only-upgrade "${installed[@]}" >>"$LOG_FILE" 2>&1
log "package update finished: ${installed[*]}"
