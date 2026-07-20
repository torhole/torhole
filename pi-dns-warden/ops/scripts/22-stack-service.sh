#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/scripts/_compose.sh"

case "${1:-}" in
  up)
    bash "$ROOT_DIR/ops/scripts/12-sync-topology.sh"
    exec "${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml up -d
    ;;
  down)
    exec "${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml down
    ;;
  *)
    echo "Usage: $0 up|down" >&2
    exit 2
    ;;
esac
