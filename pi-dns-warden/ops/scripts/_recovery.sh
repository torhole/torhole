#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
HOST_ROOT_DIR="${TORHOLE_HOST_ROOT_DIR:-$ROOT_DIR}"
RUN_DIR="${ROOT_DIR}/run"
LOCK_FILE="${RUN_DIR}/recovery.lock"
STATUS_FILE="${RUN_DIR}/recovery-status.json"
# shellcheck disable=SC2034  # consumed by scripts that source this library
WATCHDOG_PAUSE_FILE="${RUN_DIR}/watchdog.pause"
DEFAULT_BACKUP_DIR="${ROOT_DIR}/backups"
DEFAULT_SAFETY_DIR="${ROOT_DIR}/restore-safety"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-${TORHOLE_PROJECT_NAME:-$(basename "${TORHOLE_HOST_ROOT_DIR:-$ROOT_DIR}")}}"
BACKUP_MANAGER_IMAGE_DEFAULT="${PROJECT_NAME}-backup-manager"
BACKUP_MANAGER_IMAGE="${BACKUP_MANAGER_IMAGE:-$BACKUP_MANAGER_IMAGE_DEFAULT}"
CAPTURED_VOLUMES=()

RECOVERY_VOLUMES=(
  prometheus_data
  grafana_data
  loki_data
  alloy_data
  dockhand_data
  alertmanager_data
  caddy_data
  caddy_config
)

ensure_recovery_dirs() {
  mkdir -p "$RUN_DIR" "$DEFAULT_BACKUP_DIR" "$DEFAULT_SAFETY_DIR"
}

to_host_path() {
  local path="$1"

  if [[ "$ROOT_DIR" == "$HOST_ROOT_DIR" ]]; then
    printf '%s\n' "$path"
    return 0
  fi

  printf '%s%s\n' "$HOST_ROOT_DIR" "${path#"$ROOT_DIR"}"
}

load_recovery_env() {
  local env_file="${ROOT_DIR}/.env"

  if [[ -f "$env_file" ]]; then
    # shellcheck disable=SC1091
    source "$ROOT_DIR/ops/lib/load-env.sh"
    load_env_file "$env_file"
  fi

  BACKUP_MANAGER_IMAGE="${BACKUP_MANAGER_IMAGE:-$BACKUP_MANAGER_IMAGE_DEFAULT}"
}

acquire_recovery_lock() {
  ensure_recovery_dirs
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "Another recovery operation is already running." >&2
    exit 1
  fi
}

write_recovery_status() {
  local operation="$1"
  local status="$2"
  local message="$3"
  local archive="${4:-}"

  ensure_recovery_dirs

  python3 - "$STATUS_FILE" "$operation" "$status" "$message" "$archive" <<'PY'
import datetime
import json
import os
import sys

status_file, operation, status, message, archive = sys.argv[1:6]
now = datetime.datetime.now(datetime.timezone.utc).isoformat()

payload = {
    "updated_at": now,
    "operation": operation,
    "status": status,
    "message": message,
}

if archive:
    payload["archive"] = archive

if os.path.exists(status_file):
    try:
        with open(status_file, "r", encoding="utf-8") as handle:
            current = json.load(handle)
    except Exception:
        current = {}
else:
    current = {}

if status == "running":
    payload["started_at"] = now
elif current.get("started_at"):
    payload["started_at"] = current["started_at"]

if status in {"success", "error"}:
    payload["finished_at"] = now

with open(status_file, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
PY
}

helper_backup_volume() {
  local docker_volume="$1"
  local output_dir="$2"
  local logical_name="$3"
  local host_output_dir

  host_output_dir="$(to_host_path "$output_dir")"

  docker run --rm \
    -v "${docker_volume}:/volume:ro" \
    -v "${host_output_dir}:/backup" \
    "$BACKUP_MANAGER_IMAGE" \
    sh -lc "tar -C /volume -czf /backup/${logical_name}.tar.gz ."
}

helper_restore_volume() {
  local docker_volume="$1"
  local input_dir="$2"
  local logical_name="$3"
  local host_input_dir

  host_input_dir="$(to_host_path "$input_dir")"

  docker run --rm \
    -v "${docker_volume}:/volume" \
    -v "${host_input_dir}:/backup:ro" \
    "$BACKUP_MANAGER_IMAGE" \
    sh -lc "find /volume -mindepth 1 -delete && tar -C /volume -xzf /backup/${logical_name}.tar.gz"
}

ensure_helper_image() {
  if docker image inspect "$BACKUP_MANAGER_IMAGE" >/dev/null 2>&1; then
    return 0
  fi

  # shellcheck disable=SC1091
  source "${ROOT_DIR}/ops/scripts/_compose.sh"
  "${COMPOSE[@]}" -f "${ROOT_DIR}/docker-compose.yml" -f "${ROOT_DIR}/docker-compose.monitoring.yml" build backup-manager
}

copy_project_tree() {
  local destination="$1"
  local -a project_paths=(
    VERSION
    .env
    docker-compose.yml
    docker-compose.monitoring.yml
    deploy.sh
    dnscrypt
    monitoring
    ops
    pihole
    tor
    tor-image
  )

  mkdir -p "$destination"
  if [[ -f "$ROOT_DIR/.torhole-revision" ]]; then
    project_paths+=(.torhole-revision)
  fi
  tar -C "$ROOT_DIR" -cf - "${project_paths[@]}" | tar -C "$destination" -xf -
}

backup_volumes() {
  local destination="$1"
  local logical
  local docker_volume

  mkdir -p "$destination"
  ensure_helper_image
  CAPTURED_VOLUMES=()

  for logical in "${RECOVERY_VOLUMES[@]}"; do
    docker_volume="${PROJECT_NAME}_${logical}"

    if docker volume inspect "$docker_volume" >/dev/null 2>&1; then
      helper_backup_volume "$docker_volume" "$destination" "$logical"
      if [[ ! -s "$destination/${logical}.tar.gz" ]]; then
        echo "Expected backup payload missing for volume: ${docker_volume}" >&2
        exit 1
      fi
      CAPTURED_VOLUMES+=("$logical")
    fi
  done
}

write_backup_metadata() {
  local destination="$1"
  local archive_name="$2"

  python3 - "$destination" "$archive_name" "$PROJECT_NAME" "${RECOVERY_VOLUMES[@]}" -- "${CAPTURED_VOLUMES[@]}" <<'PY'
import datetime
import json
import os
import socket
import sys

destination = sys.argv[1]
archive_name = sys.argv[2]
project_name = sys.argv[3]
separator = sys.argv.index("--")
volumes = sys.argv[4:separator]
captured = sys.argv[separator + 1:]

payload = {
    "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "hostname": socket.gethostname(),
    "project_name": project_name,
    "archive_name": archive_name,
    "configured_volumes": volumes,
    "captured_volumes": captured,
    "format_version": 2,
}

with open(os.path.join(destination, "metadata.json"), "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
PY
}

backup_to_archive() {
  local archive="$1"
  local workdir

  ensure_recovery_dirs
  workdir="$(mktemp -d "${RUN_DIR}/backup.XXXXXX")"
  trap 'rm -rf "$workdir"' RETURN

  mkdir -p "$workdir/project" "$workdir/volumes"
  copy_project_tree "$workdir/project"
  backup_volumes "$workdir/volumes"
  write_backup_metadata "$workdir" "$(basename "$archive")"

  mkdir -p "$(dirname "$archive")"
  tar -C "$workdir" -czf "$archive" metadata.json project volumes
  validate_archive_safety "$archive"
}

validate_archive_safety() {
  local archive="$1"
  local entry

  while IFS= read -r entry; do
    if [[ "$entry" == /* || "$entry" == *".."* ]]; then
      echo "Unsafe archive entry: $entry" >&2
      exit 1
    fi
  done < <(tar -tzf "$archive")
}

restore_project_tree() {
  local source_root="$1"
  local legacy=0

  if [[ -d "$source_root/project" ]]; then
    source_root="$source_root/project"
  else
    legacy=1
  fi

  rm -rf \
    "${ROOT_DIR}/dnscrypt" \
    "${ROOT_DIR}/monitoring" \
    "${ROOT_DIR}/ops" \
    "${ROOT_DIR}/pihole" \
    "${ROOT_DIR}/tor" \
    "${ROOT_DIR}/tor-image"

  rm -f \
    "${ROOT_DIR}/.env" \
    "${ROOT_DIR}/docker-compose.yml" \
    "${ROOT_DIR}/docker-compose.monitoring.yml" \
    "${ROOT_DIR}/deploy.sh"

  if [[ "$legacy" -eq 1 ]]; then
    tar -C "$source_root" -cf - \
      .env \
      docker-compose.yml \
      docker-compose.monitoring.yml \
      deploy.sh \
      dnscrypt \
      monitoring \
      ops \
      pihole \
      tor \
      tor-image | tar -C "$ROOT_DIR" -xf -
  else
    tar -C "$source_root" -cf - . | tar -C "$ROOT_DIR" -xf -
  fi
}

restore_volumes() {
  local source_root="$1"
  local logical
  local docker_volume

  if [[ ! -d "$source_root/volumes" ]]; then
    return 0
  fi

  ensure_helper_image

  for logical in "${RECOVERY_VOLUMES[@]}"; do
    if [[ ! -f "$source_root/volumes/${logical}.tar.gz" ]]; then
      continue
    fi

    docker_volume="${PROJECT_NAME}_${logical}"
    docker volume create "$docker_volume" >/dev/null
    helper_restore_volume "$docker_volume" "$source_root/volumes" "$logical"
  done
}
