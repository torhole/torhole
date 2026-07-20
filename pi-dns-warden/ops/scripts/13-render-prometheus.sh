#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="${ROOT_DIR}/monitoring/prometheus/prometheus.yml"
OUTPUT="${ROOT_DIR}/monitoring/prometheus/prometheus.runtime.yml"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "$SOURCE" ]]; then
  echo "Missing Prometheus source config: $SOURCE" >&2
  exit 1
fi

TORHOLE_TOPOLOGY="${TORHOLE_TOPOLOGY:-}"
TORHOLE_WEB_MODE="${TORHOLE_WEB_MODE:-}"
if [[ ( -z "$TORHOLE_TOPOLOGY" || -z "$TORHOLE_WEB_MODE" ) && -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/ops/lib/load-env.sh"
  load_env_file "$ENV_FILE"
fi
TORHOLE_TOPOLOGY="${TORHOLE_TOPOLOGY:-vlan}"
TORHOLE_WEB_MODE="${TORHOLE_WEB_MODE:-https-local}"

case "$TORHOLE_TOPOLOGY" in
  vlan)
    cp "$SOURCE" "$OUTPUT"
    ;;
  single-lan)
    # Keep the common monitoring stack identical, but do not create probes
    # (and therefore false alerts) for the intentionally absent IoT plane.
    awk '!/pihole_iot:53/ && !/dnscrypt_iot:5053/ && !/http:\/\/pihole_iot\/admin\/login/' \
      "$SOURCE" >"$OUTPUT"
    ;;
  *)
    echo "TORHOLE_TOPOLOGY must be single-lan or vlan." >&2
    exit 1
    ;;
esac

if [[ "$TORHOLE_WEB_MODE" == "http" ]]; then
  sed -i.bak 's/"reverse-proxy:443"/"reverse-proxy:80"/' "$OUTPUT"
  rm -f "${OUTPUT}.bak"
fi

echo "OK: Prometheus targets rendered for Advanced ${TORHOLE_TOPOLOGY} (${TORHOLE_WEB_MODE})."
