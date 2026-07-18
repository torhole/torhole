#!/usr/bin/env bash
set -euo pipefail

# Wrapper to run Docker Compose on systems where the package name / command differs.
# - Prefer: docker compose (Compose v2 CLI plugin)
# - Fallback: docker-compose (classic binary)

if docker compose version >/dev/null 2>&1; then
  exec docker compose "$@"
elif command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose "$@"
else
  echo "ERROR: Docker Compose not found. Install docker-compose-plugin (preferred) or docker-compose." >&2
  exit 1
fi
