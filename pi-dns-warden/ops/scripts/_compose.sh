#!/usr/bin/env bash
# File-level directives (must precede the first command to apply file-wide):
# shellcheck disable=SC2034  # COMPOSE is consumed by the scripts that source this
# shellcheck disable=SC2317  # `return 0 2>/dev/null || exit 0` handles both sourced and direct invocation
set -euo pipefail

# Source this file to get COMPOSE as an argv array. Advanced installs that
# pre-date TORHOLE_TOPOLOGY keep the historical VLAN topology by default.
#   source ./ops/scripts/_compose.sh
#   "${COMPOSE[@]}" -f docker-compose.yml up -d

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -z "${TORHOLE_TOPOLOGY:-}" && -f "${ROOT_DIR}/.env" ]]; then
  TORHOLE_TOPOLOGY="$(awk -F= '$1 == "TORHOLE_TOPOLOGY" { value=$0; sub(/^[^=]*=/, "", value) } END { print value }' "${ROOT_DIR}/.env")"
fi
TORHOLE_TOPOLOGY="${TORHOLE_TOPOLOGY:-vlan}"
case "$TORHOLE_TOPOLOGY" in
  single-lan|vlan) ;;
  *)
    echo "ERROR: TORHOLE_TOPOLOGY must be single-lan or vlan (got: ${TORHOLE_TOPOLOGY})." >&2
    exit 1
    ;;
esac
export TORHOLE_TOPOLOGY

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
    if [[ "$TORHOLE_TOPOLOGY" == "vlan" ]]; then
      COMPOSE+=(--profile vlan)
    fi
    return 0 2>/dev/null || exit 0
  fi
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
  if [[ "$TORHOLE_TOPOLOGY" == "vlan" ]]; then
    COMPOSE+=(--profile vlan)
  fi
  return 0 2>/dev/null || exit 0
fi

echo "ERROR: Docker Compose not found. Install docker-compose (or docker compose plugin)." >&2
exit 1
