#!/usr/bin/env bash
set -euo pipefail

script_source="${BASH_SOURCE[0]:-$0}"
ROOT_DIR="${TORHOLE_ROOT_DIR:-$(cd "$(dirname "$script_source")/../.." && pwd)}"
OUTPUT=""
RUN_PRIVACY_CHECK=1

usage() {
  cat <<'EOF'
Usage: ./ops/scripts/80-hardware-validation.sh [--output FILE] [--skip-privacy-check]

Creates a redacted Markdown hardware-validation report using read-only checks.
It does not restart containers, rotate Tor circuits, alter configuration, or
include hostnames, client addresses, DNS query history, credentials, or exits.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || { echo "ERROR: --output requires a path" >&2; exit 2; }
      OUTPUT="$2"
      shift 2
      ;;
    --skip-privacy-check)
      RUN_PRIVACY_CHECK=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

require_command docker
require_command python3

tmp_report="$(mktemp)"
tmp_privacy="$(mktemp)"
trap 'rm -f "$tmp_report" "$tmp_privacy"' EXIT

model="not exposed"
if [[ -r /proc/device-tree/model ]]; then
  model="$(tr -d '\000' </proc/device-tree/model)"
fi

os_name="unknown"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  os_name="${PRETTY_NAME:-unknown}"
fi

temperature="not exposed"
if [[ -r /sys/class/thermal/thermal_zone0/temp ]]; then
  temperature="$(awk '{ printf "%.1f C", $1 / 1000 }' /sys/class/thermal/thermal_zone0/temp)"
fi

throttle="not exposed"
if command -v vcgencmd >/dev/null 2>&1; then
  throttle="$(vcgencmd get_throttled 2>/dev/null || printf 'unavailable')"
fi

docker_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || printf 'unavailable')"
compose_version="$(docker compose version --short 2>/dev/null || printf 'unavailable')"
container_total="$(docker ps --format '{{.Names}}' | wc -l | tr -d ' ')"
unhealthy_containers="$(docker ps --filter health=unhealthy --format '{{.Names}}' | sort | paste -sd ', ' -)"
[[ -n "$unhealthy_containers" ]] || unhealthy_containers="none"
restart_total="$(docker inspect $(docker ps -q) --format '{{.RestartCount}}' 2>/dev/null | awk '{ total += $1 } END { print total + 0 }')"
failed_units="not available"
if command -v systemctl >/dev/null 2>&1; then
  failed_units="$(systemctl --failed --no-legend 2>/dev/null | awk 'NF { count++ } END { print count + 0 }')"
fi

disk_summary="$(df -hP / | awk 'NR == 2 { print $3 " used of " $2 " (" $5 ")" }')"
memory_summary="$(awk '/MemTotal/ { total=$2 } /MemAvailable/ { available=$2 } END { printf "%.1f GiB available of %.1f GiB", available/1048576, total/1048576 }' /proc/meminfo)"

backup_count=0
backup_oldest="none"
backup_newest="none"
backup_bytes=0
backup_dir="${TORHOLE_BACKUP_DIR:-${ROOT_DIR}/backups}"
if [[ -d "$backup_dir" ]]; then
  backup_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'torhole-backup-*.tar.gz' | wc -l | tr -d ' ')"
  if [[ "$backup_count" -gt 0 ]]; then
    oldest_path="$(find "$backup_dir" -maxdepth 1 -type f -name 'torhole-backup-*.tar.gz' -printf '%T@ %p\n' | sort -n | awk 'NR == 1 { $1=""; sub(/^ /, ""); print }')"
    newest_path="$(find "$backup_dir" -maxdepth 1 -type f -name 'torhole-backup-*.tar.gz' -printf '%T@ %p\n' | sort -n | tail -n 1 | awk '{ $1=""; sub(/^ /, ""); print }')"
    backup_oldest="$(date -u -r "$oldest_path" +%Y-%m-%dT%H:%M:%SZ)"
    backup_newest="$(date -u -r "$newest_path" +%Y-%m-%dT%H:%M:%SZ)"
    backup_bytes="$(find "$backup_dir" -maxdepth 1 -type f -name 'torhole-backup-*.tar.gz' -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }')"
  fi
fi
backup_size="$(python3 -c 'import sys; n=int(sys.argv[1]); print(f"{n / 1024**3:.1f} GiB")' "$backup_bytes")"

privacy_result="skipped"
privacy_exit=0
if [[ "$RUN_PRIVACY_CHECK" == "1" ]]; then
  if [[ ! -r "$ROOT_DIR/.env" ]]; then
    echo "ERROR: $ROOT_DIR/.env is not readable; run this report with sudo or use --skip-privacy-check." >&2
    exit 1
  fi
  if "$ROOT_DIR/ops/scripts/21-verify-privacy.sh" >"$tmp_privacy" 2>&1; then
    privacy_result="pass"
  else
    privacy_result="fail"
    privacy_exit=1
  fi
fi

git_revision="not a Git checkout"
if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_revision="$(git -C "$ROOT_DIR" rev-parse HEAD)"
fi

cat >"$tmp_report" <<EOF
# Torhole Raspberry Pi validation report

- Generated (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Repository revision: ${git_revision}
- Privacy verification: ${privacy_result}

## Hardware and operating system

| Signal | Result |
|---|---|
| Model | ${model} |
| Architecture | $(uname -m) |
| Operating system | ${os_name} |
| Kernel | $(uname -r) |
| Uptime | $(uptime -p) |
| Memory | ${memory_summary} |
| Root storage | ${disk_summary} |
| SoC temperature | ${temperature} |
| Raspberry Pi throttle state | ${throttle} |

## Torhole runtime

| Signal | Result |
|---|---|
| Docker | ${docker_version} |
| Docker Compose | ${compose_version} |
| Running containers | ${container_total} |
| Unhealthy containers | ${unhealthy_containers} |
| Total container restarts | ${restart_total} |
| Failed systemd units | ${failed_units} |

## Recovery history

| Signal | Result |
|---|---|
| Backup archives | ${backup_count} |
| Oldest archive | ${backup_oldest} |
| Newest archive | ${backup_newest} |
| Backup storage | ${backup_size} |

## Privacy and redaction

The privacy check verifies active services, DNS resolution through every active
plane, Tor egress, Tor control authentication, and dnscrypt network isolation.
This report intentionally excludes hostnames, local addresses, credentials,
DNS queries, client identities, Tor exit addresses, and raw service logs.
EOF

if [[ -n "$OUTPUT" ]]; then
  mkdir -p "$(dirname "$OUTPUT")"
  cp "$tmp_report" "$OUTPUT"
  printf 'Validation report written to %s\n' "$OUTPUT"
else
  cat "$tmp_report"
fi

if [[ "$privacy_exit" != "0" ]]; then
  echo "ERROR: privacy verification failed; run ops/scripts/21-verify-privacy.sh locally for private diagnostic details." >&2
fi
exit "$privacy_exit"
