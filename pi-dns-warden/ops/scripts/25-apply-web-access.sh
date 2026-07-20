#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/scripts/_compose.sh"

# .env and the rendered Caddy/Authelia files were validated before this
# helper was queued. Recreate only the services whose runtime environment or
# mounted auth configuration changes. The DNS privacy path is untouched.
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml \
  up -d --force-recreate --no-deps authelia reverse-proxy
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml \
  restart prometheus

bash "$ROOT_DIR/ops/scripts/23-export-local-ca.sh"
