#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/scripts/_compose.sh"

"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml ps
