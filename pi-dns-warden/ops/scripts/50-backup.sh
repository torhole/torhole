#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

# shellcheck disable=SC1091
source "${ROOT_DIR}/ops/scripts/_recovery.sh"

load_recovery_env
acquire_recovery_lock
ensure_recovery_dirs

BACKUP_DIR="${TORHOLE_BACKUP_DIR:-${DEFAULT_BACKUP_DIR}}"
BACKUP_PREFIX="${TORHOLE_BACKUP_PREFIX:-torhole-backup}"
ARCHIVE="${BACKUP_DIR}/${BACKUP_PREFIX}-${STAMP}.tar.gz"

write_recovery_status "backup" "running" "Creating recovery archive" "$ARCHIVE"

if backup_to_archive "$ARCHIVE"; then
  write_recovery_status "backup" "success" "Backup archive created" "$ARCHIVE"
  echo "Backup written to: $ARCHIVE"
else
  write_recovery_status "backup" "error" "Backup failed" "$ARCHIVE"
  exit 1
fi
