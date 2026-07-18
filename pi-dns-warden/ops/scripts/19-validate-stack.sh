#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# When this script runs inside backup-manager, ROOT_DIR is /workspace
# (the in-container view) but `docker run -v` resolves bind paths against
# the host filesystem, where the same files live at /opt/pi-dns-warden.
# TORHOLE_HOST_ROOT_DIR is set in the backup-manager compose env for this
# reason. When run on the host directly, fall back to ROOT_DIR.
HOST_ROOT="${TORHOLE_HOST_ROOT_DIR:-$ROOT_DIR}"

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/scripts/_compose.sh"
# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/torhole-hostnames.sh"

PROMETHEUS_IMAGE="${PROMETHEUS_IMAGE:-prom/prometheus:latest}"
ALERTMANAGER_IMAGE="${ALERTMANAGER_IMAGE:-prom/alertmanager:latest}"
REVERSE_PROXY_IMAGE="${REVERSE_PROXY_IMAGE:-caddy:latest}"
ALLOY_IMAGE="${ALLOY_IMAGE:-grafana/alloy:latest}"
AUTHELIA_IMAGE="${AUTHELIA_IMAGE:-authelia/authelia:latest}"

echo "[validate] compose render"
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml config -q

echo "[validate] prometheus config"
docker run --rm \
  --entrypoint promtool \
  -v "$HOST_ROOT/monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$HOST_ROOT/monitoring/prometheus/alert.rules.yml:/etc/prometheus/alert.rules.yml:ro" \
  "$PROMETHEUS_IMAGE" \
  check config /etc/prometheus/prometheus.yml

echo "[validate] prometheus rules"
docker run --rm \
  --entrypoint promtool \
  -v "$HOST_ROOT/monitoring/prometheus/alert.rules.yml:/etc/prometheus/alert.rules.yml:ro" \
  "$PROMETHEUS_IMAGE" \
  check rules /etc/prometheus/alert.rules.yml

echo "[validate] alertmanager config"
docker run --rm \
  --entrypoint amtool \
  -v "$HOST_ROOT/monitoring/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
  "$ALERTMANAGER_IMAGE" \
  check-config /etc/alertmanager/alertmanager.yml

echo "[validate] caddy config"
# Caddyfile imports auth-snippets.caddy as a sibling so we mount the whole
# caddy/ dir, not just the single file. REVERSE_PROXY_DOMAIN is interpolated
# at parse time and must be passed through for validate to succeed.
docker run --rm \
  -e "REVERSE_PROXY_DOMAIN=${REVERSE_PROXY_DOMAIN:-validate.invalid}" \
  -e "TORHOLE_HOST_TORHOLE=${TORHOLE_HOST_TORHOLE}" \
  -e "TORHOLE_HOST_AUTH=${TORHOLE_HOST_AUTH}" \
  -e "TORHOLE_HOST_GRAFANA=${TORHOLE_HOST_GRAFANA}" \
  -e "TORHOLE_HOST_PROMETHEUS=${TORHOLE_HOST_PROMETHEUS}" \
  -e "TORHOLE_HOST_ALERTMANAGER=${TORHOLE_HOST_ALERTMANAGER}" \
  -e "TORHOLE_HOST_DOCKHAND=${TORHOLE_HOST_DOCKHAND}" \
  -e "TORHOLE_HOST_PIHOLE_TRUSTED=${TORHOLE_HOST_PIHOLE_TRUSTED}" \
  -e "TORHOLE_HOST_PIHOLE_IOT=${TORHOLE_HOST_PIHOLE_IOT}" \
  -e "TORHOLE_ALIAS_TORHOLE=${TORHOLE_ALIAS_TORHOLE}" \
  -e "TORHOLE_ALIAS_GRAFANA=${TORHOLE_ALIAS_GRAFANA}" \
  -e "TORHOLE_ALIAS_PROMETHEUS=${TORHOLE_ALIAS_PROMETHEUS}" \
  -e "TORHOLE_ALIAS_ALERTMANAGER=${TORHOLE_ALIAS_ALERTMANAGER}" \
  -e "TORHOLE_ALIAS_DOCKHAND=${TORHOLE_ALIAS_DOCKHAND}" \
  -e "TORHOLE_ALIAS_PIHOLE_TRUSTED=${TORHOLE_ALIAS_PIHOLE_TRUSTED}" \
  -e "TORHOLE_ALIAS_PIHOLE_IOT=${TORHOLE_ALIAS_PIHOLE_IOT}" \
  -v "$HOST_ROOT/monitoring/caddy:/etc/caddy:ro" \
  "$REVERSE_PROXY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile

if [[ -f "$ROOT_DIR/monitoring/authelia/configuration.yml" ]]; then
  echo "[validate] authelia config"
  docker run --rm \
    -v "$HOST_ROOT/monitoring/authelia:/config:ro" \
    -v authelia_validate_data:/var/lib/authelia \
    "$AUTHELIA_IMAGE" \
    authelia config validate --config /config/configuration.yml
fi

if [[ -f "$ROOT_DIR/monitoring/alloy/config.alloy" ]]; then
  echo "[validate] alloy config"
  docker run --rm \
    -v "$HOST_ROOT/monitoring/alloy/config.alloy:/etc/alloy/config.alloy:ro" \
    "$ALLOY_IMAGE" \
    validate /etc/alloy/config.alloy
fi

echo "[validate] dashboard json"
for dashboard in "$ROOT_DIR"/monitoring/grafana/dashboards/*.json; do
  python3 -m json.tool "$dashboard" >/dev/null
done

if [[ -f "$ROOT_DIR/monitoring/pihole-exporter/exporter.py" ]]; then
  echo "[validate] pihole exporter python"
  python3 -m py_compile "$ROOT_DIR/monitoring/pihole-exporter/exporter.py"
fi

if [[ -f "$ROOT_DIR/monitoring/backup-manager/server.py" ]]; then
  echo "[validate] backup manager python"
  python3 -m py_compile "$ROOT_DIR/monitoring/backup-manager/server.py"
fi

echo "OK: stack configuration validated"
