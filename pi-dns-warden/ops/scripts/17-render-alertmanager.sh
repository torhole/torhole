#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${TORHOLE_ENV_FILE:-${ROOT_DIR}/.env}"
OUT_FILE="${ALERTMANAGER_OUTPUT_FILE:-${ROOT_DIR}/monitoring/alertmanager/alertmanager.yml}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env at: $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ENV_FILE"

ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-}"
ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-}"
ALERT_EMAIL_SMARTHOST="${ALERT_EMAIL_SMARTHOST:-}"
ALERT_EMAIL_AUTH_USERNAME="${ALERT_EMAIL_AUTH_USERNAME:-}"
ALERT_EMAIL_AUTH_PASSWORD="${ALERT_EMAIL_AUTH_PASSWORD:-}"
ALERT_EMAIL_REQUIRE_TLS="${ALERT_EMAIL_REQUIRE_TLS:-true}"
ALERT_EMAIL_ENABLED="${ALERT_EMAIL_ENABLED:-}"

ALERT_TELEGRAM_BOT_TOKEN="${ALERT_TELEGRAM_BOT_TOKEN:-}"
ALERT_TELEGRAM_CHAT_ID="${ALERT_TELEGRAM_CHAT_ID:-}"
ALERT_TELEGRAM_ENABLED="${ALERT_TELEGRAM_ENABLED:-}"

ALERT_DISCORD_WEBHOOK_URL="${ALERT_DISCORD_WEBHOOK_URL:-}"
ALERT_DISCORD_USERNAME="${ALERT_DISCORD_USERNAME:-Torhole}"
ALERT_DISCORD_ENABLED="${ALERT_DISCORD_ENABLED:-}"

email_enabled=0
telegram_enabled=0
discord_enabled=0

is_truthy() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ -n "$ALERT_EMAIL_TO" && -n "$ALERT_EMAIL_FROM" && -n "$ALERT_EMAIL_SMARTHOST" ]]; then
  email_enabled=1
  if [[ -n "$ALERT_EMAIL_ENABLED" ]] && ! is_truthy "$ALERT_EMAIL_ENABLED"; then
    email_enabled=0
  fi
fi

if [[ -n "$ALERT_TELEGRAM_BOT_TOKEN" && -n "$ALERT_TELEGRAM_CHAT_ID" ]]; then
  telegram_enabled=1
  if [[ -n "$ALERT_TELEGRAM_ENABLED" ]] && ! is_truthy "$ALERT_TELEGRAM_ENABLED"; then
    telegram_enabled=0
  fi
fi

if [[ -n "$ALERT_DISCORD_WEBHOOK_URL" ]]; then
  discord_enabled=1
  if [[ -n "$ALERT_DISCORD_ENABLED" ]] && ! is_truthy "$ALERT_DISCORD_ENABLED"; then
    discord_enabled=0
  fi
fi

mkdir -p "$(dirname "$OUT_FILE")"

{
  echo "route:"
  echo "  receiver: default"
  # Preserve the target identity in each group. Several rules can fire for
  # multiple jobs/planes at once; grouping only by alertname made CommonLabels
  # and CommonAnnotations empty and produced notifications with no diagnosis.
  echo "  group_by: ['alertname', 'job', 'instance', 'role', 'name']"
  echo "  group_wait: 30s"
  echo "  group_interval: 5m"
  echo "  repeat_interval: 1h"
  echo
  echo "receivers:"
  echo "  - name: default"

  if [[ $email_enabled -eq 1 ]]; then
    echo "    email_configs:"
    echo "      - to: '${ALERT_EMAIL_TO}'"
    echo "        from: '${ALERT_EMAIL_FROM}'"
    echo "        smarthost: '${ALERT_EMAIL_SMARTHOST}'"
    if [[ -n "$ALERT_EMAIL_AUTH_USERNAME" ]]; then
      echo "        auth_username: '${ALERT_EMAIL_AUTH_USERNAME}'"
    fi
    if [[ -n "$ALERT_EMAIL_AUTH_PASSWORD" ]]; then
      echo "        auth_password: '${ALERT_EMAIL_AUTH_PASSWORD}'"
    fi
    echo "        require_tls: ${ALERT_EMAIL_REQUIRE_TLS}"
    echo "        send_resolved: true"
    echo "        headers:"
    echo "          Subject: '[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}'"
    echo "        text: |"
    echo "          {{ range .Alerts }}"
    echo "          Severity: {{ .Labels.severity }}"
    echo "          Summary: {{ .Annotations.summary }}"
    echo "          Description: {{ .Annotations.description }}"
    echo "          {{ with .Labels.instance }}Instance: {{ . }}{{ end }}"
    echo "          {{ with .Labels.role }}Role: {{ . }}{{ end }}"
    echo "          {{ with .Labels.name }}Container: {{ . }}{{ end }}"
    echo "          {{ with .Annotations.runbook_url }}Runbook: {{ . }}{{ end }}"
    echo "          {{ if .Annotations.dashboard_uid }}Dashboard: {{ .Annotations.dashboard_uid }}{{ with .Annotations.panel_id }} (panel {{ . }}){{ end }}{{ end }}"
    echo "          StartsAt: {{ .StartsAt }}"
    echo "          EndsAt: {{ .EndsAt }}"
    echo "          {{ end }}"
  fi

  if [[ $telegram_enabled -eq 1 ]]; then
    echo "    telegram_configs:"
    echo "      - bot_token: '${ALERT_TELEGRAM_BOT_TOKEN}'"
    echo "        chat_id: ${ALERT_TELEGRAM_CHAT_ID}"
    echo "        send_resolved: true"
    echo "        message: |"
    echo "          [{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}"
    echo "          {{ range .Alerts }}"
    echo "          Severity: {{ .Labels.severity }}"
    echo "          Summary: {{ .Annotations.summary }}"
    echo "          Description: {{ .Annotations.description }}"
    echo "          {{ with .Labels.instance }}Instance: {{ . }}{{ end }}"
    echo "          {{ with .Labels.role }}Role: {{ . }}{{ end }}"
    echo "          {{ with .Labels.name }}Container: {{ . }}{{ end }}"
    echo "          {{ with .Annotations.runbook_url }}Runbook: {{ . }}{{ end }}"
    echo "          {{ if .Annotations.dashboard_uid }}Dashboard: {{ .Annotations.dashboard_uid }}{{ with .Annotations.panel_id }} panel {{ . }}{{ end }}{{ end }}"
    echo "          {{ end }}"
  fi

  if [[ $discord_enabled -eq 1 ]]; then
    echo "    discord_configs:"
    echo "      - webhook_url: '${ALERT_DISCORD_WEBHOOK_URL}'"
    echo "        username: '${ALERT_DISCORD_USERNAME}'"
    echo "        send_resolved: true"
    echo "        title: '[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}'"
    echo "        message: |"
    echo "          {{ range .Alerts }}"
    echo "          Severity: {{ .Labels.severity }}"
    echo "          Summary: {{ .Annotations.summary }}"
    echo "          Description: {{ .Annotations.description }}"
    echo "          {{ with .Labels.instance }}Instance: {{ . }}{{ end }}"
    echo "          {{ with .Labels.role }}Role: {{ . }}{{ end }}"
    echo "          {{ with .Labels.name }}Container: {{ . }}{{ end }}"
    echo "          {{ with .Annotations.runbook_url }}Runbook: {{ . }}{{ end }}"
    echo "          {{ if .Annotations.dashboard_uid }}Dashboard: {{ .Annotations.dashboard_uid }}{{ with .Annotations.panel_id }} panel {{ . }}{{ end }}{{ end }}"
    echo "          {{ end }}"
  fi

  if [[ $email_enabled -eq 0 && $telegram_enabled -eq 0 && $discord_enabled -eq 0 ]]; then
    echo "    # No notification integrations configured."
    echo "    # Populate ALERT_EMAIL_*, ALERT_TELEGRAM_*, and/or ALERT_DISCORD_* in .env to enable delivery."
  fi
} > "$OUT_FILE"

echo "OK: alertmanager config rendered (email=$email_enabled telegram=$telegram_enabled discord=$discord_enabled)"
