#!/usr/bin/env bash
set -euo pipefail

DURATION_HOURS=24
INTERVAL_SECONDS=60
OUTPUT="torhole-soak-$(date -u +%Y%m%d-%H%M%S).csv"

usage() {
  cat <<'EOF'
Usage: ./ops/scripts/81-soak-observe.sh [--hours N] [--interval SECONDS] [--output FILE]

Records a read-only CSV of Raspberry Pi and Torhole health. It does not rotate
Tor circuits, restart services, change configuration, or record DNS queries,
clients, local addresses, credentials, or Tor exit addresses.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours)
      [[ $# -ge 2 ]] || { echo "ERROR: --hours requires a value" >&2; exit 2; }
      DURATION_HOURS="$2"
      shift 2
      ;;
    --interval)
      [[ $# -ge 2 ]] || { echo "ERROR: --interval requires a value" >&2; exit 2; }
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo "ERROR: --output requires a path" >&2; exit 2; }
      OUTPUT="$2"
      shift 2
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

python3 - "$DURATION_HOURS" "$INTERVAL_SECONDS" <<'PY'
import sys
hours = float(sys.argv[1])
interval = int(sys.argv[2])
if hours <= 0 or interval < 10:
    raise SystemExit("hours must be positive and interval must be at least 10 seconds")
PY

mkdir -p "$(dirname "$OUTPUT")"
printf '%s\n' 'timestamp_utc,temp_c,load_1m,mem_available_mib,disk_used_pct,running_containers,unhealthy_containers,restart_total,tor_bootstrap_pct,tor_circuit_established,tor_control_up,tor_egress_result_available,tor_egress_is_tor,tor_egress_verifier_available' >"$OUTPUT"

deadline="$(python3 -c 'import sys,time; print(time.time() + float(sys.argv[1]) * 3600)' "$DURATION_HOURS")"

metric_value() {
  local metrics="$1"
  local name="$2"
  awk -v metric="$name" '$1 == metric { value=$2 } END { print (value == "" ? "NA" : value) }' <<<"$metrics"
}

while python3 -c 'import sys,time; raise SystemExit(0 if time.time() < float(sys.argv[1]) else 1)' "$deadline"; do
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  temp_c="NA"
  if [[ -r /sys/class/thermal/thermal_zone0/temp ]]; then
    temp_c="$(awk '{ printf "%.1f", $1 / 1000 }' /sys/class/thermal/thermal_zone0/temp)"
  fi
  load_1m="$(awk '{ print $1 }' /proc/loadavg)"
  mem_available_mib="$(awk '/MemAvailable/ { printf "%.0f", $2 / 1024 }' /proc/meminfo)"
  disk_used_pct="$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
  running_containers="$(docker ps -q | wc -l | tr -d ' ')"
  unhealthy_containers="$(docker ps --filter health=unhealthy -q | wc -l | tr -d ' ')"
  restart_total="$(docker inspect $(docker ps -q) --format '{{.RestartCount}}' 2>/dev/null | awk '{ total += $1 } END { print total + 0 }')"
  metrics="$(docker exec prometheus wget -qO- http://backup-manager:8080/api/metrics/tor 2>/dev/null || true)"

  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$timestamp" "$temp_c" "$load_1m" "$mem_available_mib" "$disk_used_pct" \
    "$running_containers" "$unhealthy_containers" "$restart_total" \
    "$(metric_value "$metrics" tor_bootstrap_percent)" \
    "$(metric_value "$metrics" tor_circuit_established)" \
    "$(metric_value "$metrics" tor_control_port_up)" \
    "$(metric_value "$metrics" torhole_leak_test_result_available)" \
    "$(metric_value "$metrics" torhole_leak_test_pass)" \
    "$(metric_value "$metrics" torhole_tor_egress_verifier_available)" >>"$OUTPUT"

  sleep "$INTERVAL_SECONDS"
done

printf 'Read-only soak observations written to %s\n' "$OUTPUT"
