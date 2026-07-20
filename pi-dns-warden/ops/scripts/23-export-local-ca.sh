#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
OUTPUT_FILE="$ROOT_DIR/monitoring/caddy/torhole-local-ca.crt"

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ENV_FILE"

if [[ "${TORHOLE_WEB_MODE:-https-local}" != "https-local" ]]; then
  rm -f "$OUTPUT_FILE"
  exit 0
fi

for _ in {1..20}; do
  if docker cp \
    reverse-proxy:/data/caddy/pki/authorities/local/root.crt \
    "$OUTPUT_FILE" >/dev/null 2>&1; then
    chmod 644 "$OUTPUT_FILE"
    echo "Local HTTPS certificate available at http://${HOST_MGMT_IP}/torhole-local-ca.crt"
    exit 0
  fi
  sleep 1
done

echo "ERROR: Caddy did not make its local CA certificate available."
exit 1
