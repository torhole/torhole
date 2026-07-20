#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/scripts/_compose.sh"

bash "$ROOT_DIR/ops/scripts/12-sync-topology.sh"

bash "$ROOT_DIR/ops/scripts/17-render-alertmanager.sh"
bash "$ROOT_DIR/ops/scripts/18-render-auth.sh"
bash "$ROOT_DIR/ops/scripts/14-render-caddy-topology.sh"
bash "$ROOT_DIR/ops/scripts/16-render-reverse-proxy-dns.sh"
bash "$ROOT_DIR/ops/scripts/19-validate-stack.sh"
bash "$ROOT_DIR/ops/scripts/20-render-torrc.sh"
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml pull --ignore-buildable
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml build tor pihole-exporter backup-manager
# 20-render-torrc.sh atomically replaces the bind-mounted file. An existing
# container remains attached to the old inode even across `docker restart`, so
# it must be recreated before Tor can read the new control-password hash.
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml up -d --force-recreate tor
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml up -d
# Access mode and certificate files are bind-mounted. Compose does not detect
# their content changing when the public scheme remains HTTPS, so make Caddy
# reopen the rendered config and certificate on every maintenance deploy.
docker restart reverse-proxy >/dev/null
# Prometheus does not automatically reload a changed bind-mounted config.
# Restart it so topology/web-mode target changes take effect immediately.
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml restart prometheus
bash "$ROOT_DIR/ops/scripts/23-export-local-ca.sh"
"${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml ps
