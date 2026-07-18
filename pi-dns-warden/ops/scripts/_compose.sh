#!/usr/bin/env bash
# File-level directives (must precede the first command to apply file-wide):
# shellcheck disable=SC2034  # COMPOSE is consumed by the scripts that source this
# shellcheck disable=SC2317  # `return 0 2>/dev/null || exit 0` handles both sourced and direct invocation
set -euo pipefail

# Source this file to get COMPOSE as an argv array:
#   source ./ops/scripts/_compose.sh
#   "${COMPOSE[@]}" -f docker-compose.yml up -d

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
    return 0 2>/dev/null || exit 0
  fi
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
  return 0 2>/dev/null || exit 0
fi

echo "ERROR: Docker Compose not found. Install docker-compose (or docker compose plugin)." >&2
exit 1
