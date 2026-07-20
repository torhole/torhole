#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/scripts/_compose.sh"

bash "$ROOT_DIR/ops/scripts/12-sync-topology.sh"

bash "$ROOT_DIR/ops/scripts/14-build-admin-ui.sh"
bash "$ROOT_DIR/ops/scripts/17-render-alertmanager.sh"
bash "$ROOT_DIR/ops/scripts/18-render-auth.sh"
bash "$ROOT_DIR/ops/scripts/16-render-reverse-proxy-dns.sh"
bash "$ROOT_DIR/ops/scripts/19-validate-stack.sh"
bash "$ROOT_DIR/ops/scripts/50-backup.sh"
bash "$ROOT_DIR/ops/scripts/20-render-torrc.sh"
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml pull --ignore-buildable
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml build tor pihole-exporter backup-manager
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml up -d --force-recreate tor
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml up -d
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml ps
