#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
STATE_DIR="/var/lib/pi-dns-warden-watchdog"
STATE_FILE="${STATE_DIR}/prometheus-down"
PAUSE_FILE="${ROOT_DIR}/run/watchdog.pause"
HOSTNAME_VALUE="$(hostname)"
LEGACY_WATCHDOG_URL="http://127.0.0.1:9090/-/healthy"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env at: $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ENV_FILE"

PROMETHEUS_WATCHDOG_CONTAINER_NAME="${PROMETHEUS_WATCHDOG_CONTAINER_NAME:-prometheus}"
PROMETHEUS_WATCHDOG_NETWORK="${PROMETHEUS_WATCHDOG_NETWORK:-pi-dns-warden_dns_int}"
PROMETHEUS_WATCHDOG_PORT="${PROMETHEUS_WATCHDOG_PORT:-9090}"
PROMETHEUS_WATCHDOG_PATH="${PROMETHEUS_WATCHDOG_PATH:-/-/healthy}"
PROMETHEUS_WATCHDOG_URL="${PROMETHEUS_WATCHDOG_URL:-}"
PROMETHEUS_WATCHDOG_TIMEOUT_S="${PROMETHEUS_WATCHDOG_TIMEOUT_S:-10}"
ALERT_TELEGRAM_BOT_TOKEN="${ALERT_TELEGRAM_BOT_TOKEN:-}"
ALERT_TELEGRAM_CHAT_ID="${ALERT_TELEGRAM_CHAT_ID:-}"

mkdir -p "$STATE_DIR"

if [[ -f "$PAUSE_FILE" ]]; then
  exit 0
fi

discover_watchdog_url() {
  local ip

  ip="$(
    docker inspect \
      -f "{{with index .NetworkSettings.Networks \"${PROMETHEUS_WATCHDOG_NETWORK}\"}}{{.IPAddress}}{{end}}" \
      "$PROMETHEUS_WATCHDOG_CONTAINER_NAME" 2>/dev/null || true
  )"

  if [[ -z "$ip" ]]; then
    return 1
  fi

  printf 'http://%s:%s%s\n' "$ip" "$PROMETHEUS_WATCHDOG_PORT" "$PROMETHEUS_WATCHDOG_PATH"
}

prometheus_container_running() {
  local running

  running="$(
    docker inspect -f '{{.State.Running}}' "$PROMETHEUS_WATCHDOG_CONTAINER_NAME" 2>/dev/null || true
  )"

  [[ "$running" == "true" ]]
}

send_telegram() {
  local message="$1"

  if [[ -z "$ALERT_TELEGRAM_BOT_TOKEN" || -z "$ALERT_TELEGRAM_CHAT_ID" ]]; then
    return 0
  fi

  curl -fsS --max-time 15 \
    -X POST \
    -d "chat_id=${ALERT_TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${message}" \
    "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
    >/dev/null
}

if [[ -z "$PROMETHEUS_WATCHDOG_URL" || "$PROMETHEUS_WATCHDOG_URL" == "$LEGACY_WATCHDOG_URL" ]]; then
  PROMETHEUS_WATCHDOG_URL="$(discover_watchdog_url || true)"
fi

if prometheus_container_running && [[ -n "$PROMETHEUS_WATCHDOG_URL" ]] && curl -fsS --max-time "$PROMETHEUS_WATCHDOG_TIMEOUT_S" "$PROMETHEUS_WATCHDOG_URL" >/dev/null; then
  if [[ -f "$STATE_FILE" ]]; then
    rm -f "$STATE_FILE"
    send_telegram "[RESOLVED] PrometheusDownWatchdog
Host: ${HOSTNAME_VALUE}
Summary: Prometheus watchdog recovered
Description: External watchdog can reach ${PROMETHEUS_WATCHDOG_URL} again."
  fi
  exit 0
fi

if [[ -f "$STATE_FILE" ]]; then
  exit 0
fi

date -u +"%Y-%m-%dT%H:%M:%SZ" > "$STATE_FILE"
send_telegram "[FIRING] PrometheusDownWatchdog
Host: ${HOSTNAME_VALUE}
Summary: Prometheus is unreachable
Description: External watchdog could not reach ${PROMETHEUS_WATCHDOG_URL}."
