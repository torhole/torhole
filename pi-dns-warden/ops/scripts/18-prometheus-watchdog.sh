#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${TORHOLE_ENV_FILE:-${ROOT_DIR}/.env}"
STATE_DIR="${PROMETHEUS_WATCHDOG_STATE_DIR:-/var/lib/pi-dns-warden-watchdog}"
STATE_FILE="${STATE_DIR}/prometheus-down"
TELEGRAM_SENT_FILE="${STATE_DIR}/prometheus-down.telegram-sent"
EMAIL_SENT_FILE="${STATE_DIR}/prometheus-down.email-sent"
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
ALERT_TELEGRAM_ENABLED="${ALERT_TELEGRAM_ENABLED:-}"
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-}"
ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-}"
ALERT_EMAIL_SMARTHOST="${ALERT_EMAIL_SMARTHOST:-}"
ALERT_EMAIL_AUTH_USERNAME="${ALERT_EMAIL_AUTH_USERNAME:-}"
ALERT_EMAIL_AUTH_PASSWORD="${ALERT_EMAIL_AUTH_PASSWORD:-}"
ALERT_EMAIL_REQUIRE_TLS="${ALERT_EMAIL_REQUIRE_TLS:-true}"
ALERT_EMAIL_ENABLED="${ALERT_EMAIL_ENABLED:-}"

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

is_truthy() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

telegram_configured() {
  [[ -n "$ALERT_TELEGRAM_BOT_TOKEN" && -n "$ALERT_TELEGRAM_CHAT_ID" ]] &&
    { [[ -z "$ALERT_TELEGRAM_ENABLED" ]] || is_truthy "$ALERT_TELEGRAM_ENABLED"; }
}

email_configured() {
  [[ -n "$ALERT_EMAIL_TO" && -n "$ALERT_EMAIL_FROM" && -n "$ALERT_EMAIL_SMARTHOST" ]] &&
    { [[ -z "$ALERT_EMAIL_ENABLED" ]] || is_truthy "$ALERT_EMAIL_ENABLED"; }
}

send_telegram() {
  local message="$1"

  curl -fsS --max-time 15 \
    -X POST \
    -d "chat_id=${ALERT_TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${message}" \
    "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
    >/dev/null
}

send_email() {
  local subject="$1"
  local message="$2"
  local smtp_url="$ALERT_EMAIL_SMARTHOST"
  local -a curl_args

  case "$smtp_url" in
    smtp://*|smtps://*) ;;
    *) smtp_url="smtp://${smtp_url}" ;;
  esac

  curl_args=(
    -fsS
    --max-time 20
    --url "$smtp_url"
    --mail-from "$ALERT_EMAIL_FROM"
    --mail-rcpt "$ALERT_EMAIL_TO"
    --upload-file -
  )
  if [[ -n "$ALERT_EMAIL_AUTH_USERNAME" ]]; then
    curl_args+=(--user "${ALERT_EMAIL_AUTH_USERNAME}:${ALERT_EMAIL_AUTH_PASSWORD}")
  fi
  if is_truthy "$ALERT_EMAIL_REQUIRE_TLS"; then
    curl_args+=(--ssl-reqd)
  fi

  printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\n\r\n%s\r\n' \
    "$ALERT_EMAIL_FROM" "$ALERT_EMAIL_TO" "$subject" "$message" |
    curl "${curl_args[@]}" >/dev/null
}

if [[ -z "$PROMETHEUS_WATCHDOG_URL" || "$PROMETHEUS_WATCHDOG_URL" == "$LEGACY_WATCHDOG_URL" ]]; then
  PROMETHEUS_WATCHDOG_URL="$(discover_watchdog_url || true)"
fi

if prometheus_container_running && [[ -n "$PROMETHEUS_WATCHDOG_URL" ]] && curl -fsS --max-time "$PROMETHEUS_WATCHDOG_TIMEOUT_S" "$PROMETHEUS_WATCHDOG_URL" >/dev/null; then
  if [[ -f "$STATE_FILE" ]]; then
    resolved_message="[RESOLVED] PrometheusDownWatchdog
Host: ${HOSTNAME_VALUE}
Summary: Prometheus watchdog recovered
Description: External watchdog can reach ${PROMETHEUS_WATCHDOG_URL} again."
    if [[ -f "$TELEGRAM_SENT_FILE" ]]; then
      if ! telegram_configured || send_telegram "$resolved_message"; then
        rm -f "$TELEGRAM_SENT_FILE"
      else
        echo "Prometheus watchdog: Telegram recovery delivery failed; will retry." >&2
      fi
    fi
    if [[ -f "$EMAIL_SENT_FILE" ]]; then
      if ! email_configured || send_email "[RESOLVED] PrometheusDownWatchdog" "$resolved_message"; then
        rm -f "$EMAIL_SENT_FILE"
      else
        echo "Prometheus watchdog: email recovery delivery failed; will retry." >&2
      fi
    fi
    if [[ ! -f "$TELEGRAM_SENT_FILE" && ! -f "$EMAIL_SENT_FILE" ]]; then
      rm -f "$STATE_FILE"
    fi
  fi
  exit 0
fi

new_outage=0
if [[ ! -f "$STATE_FILE" ]]; then
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$STATE_FILE"
  new_outage=1
fi

firing_message="[FIRING] PrometheusDownWatchdog
Host: ${HOSTNAME_VALUE}
Summary: Prometheus is unreachable
Description: External watchdog could not reach ${PROMETHEUS_WATCHDOG_URL:-an auto-discovered endpoint}."

# Mark a channel only after curl succeeds. A transient delivery failure is
# retried on the next timer run without re-notifying channels that succeeded.
if telegram_configured && [[ ! -f "$TELEGRAM_SENT_FILE" ]]; then
  if send_telegram "$firing_message"; then
    : > "$TELEGRAM_SENT_FILE"
  else
    echo "Prometheus watchdog: Telegram delivery failed; will retry." >&2
  fi
fi

if email_configured && [[ ! -f "$EMAIL_SENT_FILE" ]]; then
  if send_email "[FIRING] PrometheusDownWatchdog" "$firing_message"; then
    : > "$EMAIL_SENT_FILE"
  else
    echo "Prometheus watchdog: email delivery failed; will retry." >&2
  fi
fi

if [[ $new_outage -eq 1 ]] && ! telegram_configured && ! email_configured; then
  echo "Prometheus watchdog: Prometheus is down, but no watchdog notification channel is configured." >&2
fi
