#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck disable=SC1091
source "${ROOT_DIR}/ops/scripts/_recovery.sh"

AUTO_RESTART=0
ASSUME_YES=0

usage() {
  echo "Usage: sudo ./ops/scripts/60-restore.sh [--yes] [--auto-restart] /absolute/path/to/torhole-backup-YYYYMMDD-HHMMSS.tar.gz"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --auto-restart)
      AUTO_RESTART=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      break
      ;;
  esac
done

[[ $# -eq 1 ]] || usage

ARCHIVE="$1"
[[ -f "$ARCHIVE" ]] || { echo "Archive not found: $ARCHIVE" >&2; exit 1; }

load_recovery_env
acquire_recovery_lock
ensure_recovery_dirs

STAMP="$(date +%Y%m%d-%H%M%S)"
SAFETY_ARCHIVE="${DEFAULT_SAFETY_DIR}/pre-restore-${STAMP}.tar.gz"
WORKDIR="$(mktemp -d "${RUN_DIR}/restore.XXXXXX")"
trap 'rm -rf "$WORKDIR"; rm -f "$WATCHDOG_PAUSE_FILE"' EXIT

write_recovery_status "restore" "running" "Preparing restore" "$ARCHIVE"
# Extract and validate the exact staged payload before backup, shutdown or
# replacement. Never reopen a potentially changed input after shutdown.
if ! python3 "$RECOVERY_ARCHIVE_TOOL" extract "$ARCHIVE" "$WORKDIR/extract"; then
  write_recovery_status "restore" "error" "Backup preflight failed; installation unchanged" "$ARCHIVE"
  exit 1
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo "This will stop the Torhole stack, restore project files and service volumes, and may replace current state."
  read -r -p "Type RESTORE to continue: " CONFIRM
  [[ "$CONFIRM" == "RESTORE" ]] || {
    echo "Restore aborted."
    write_recovery_status "restore" "error" "Restore aborted by operator" "$ARCHIVE"
    exit 1
  }
fi

write_recovery_status "restore" "running" "Creating safety backup" "$ARCHIVE"
backup_to_archive "$SAFETY_ARCHIVE"

touch "$WATCHDOG_PAUSE_FILE"
write_recovery_status "restore" "running" "Stopping stack for restore" "$ARCHIVE"
"${ROOT_DIR}/ops/scripts/90-down.sh"

write_recovery_status "restore" "running" "Restoring project files" "$ARCHIVE"
restore_project_tree "$WORKDIR/extract"

write_recovery_status "restore" "running" "Restoring service volumes" "$ARCHIVE"
restore_volumes "$WORKDIR/extract"

write_recovery_status "restore" "running" "Rendering and validating restored config" "$ARCHIVE"
"${ROOT_DIR}/ops/scripts/17-render-alertmanager.sh"
"${ROOT_DIR}/ops/scripts/16-render-reverse-proxy-dns.sh"
"${ROOT_DIR}/ops/scripts/13-render-prometheus.sh"
"${ROOT_DIR}/ops/scripts/14-render-caddy-topology.sh"
"${ROOT_DIR}/ops/scripts/19-validate-stack.sh" --allow-image-pulls

if [[ "$AUTO_RESTART" -eq 1 ]]; then
  write_recovery_status "restore" "running" "Restarting restored stack" "$ARCHIVE"
  "${ROOT_DIR}/ops/scripts/20-up.sh"
fi

write_recovery_status "restore" "success" "Restore completed successfully" "$ARCHIVE"
echo "Restore complete."
echo "Safety backup written to: $SAFETY_ARCHIVE"
