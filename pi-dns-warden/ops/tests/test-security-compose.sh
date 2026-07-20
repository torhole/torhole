#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_json="$(mktemp)"
trap 'rm -f "$compose_json"' EXIT

docker compose \
  --env-file "$ROOT_DIR/.env.example" \
  -f "$ROOT_DIR/docker-compose.yml" \
  -f "$ROOT_DIR/docker-compose.monitoring.yml" \
  config --format json >"$compose_json"

python3 - "$compose_json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    config = json.load(handle)

services = config["services"]
dockhand_networks = set(services["dockhand"]["networks"])
proxy_networks = set(services["reverse-proxy"]["networks"])

assert dockhand_networks == {"admin_net"}, dockhand_networks
assert "admin_net" in proxy_networks
assert "dns_int" not in dockhand_networks
assert "BACKUP_MANAGER_API_TOKEN" in services["backup-manager"]["environment"]
assert "BACKUP_MANAGER_API_TOKEN" in services["reverse-proxy"]["environment"]
assert services["grafana"]["environment"]["GF_PLUGINS_PREINSTALL_DISABLED"] == "true"
assert config["networks"]["admin_net"]["internal"] is True
PY

grep -F 'header_up Authorization "Bearer {$BACKUP_MANAGER_API_TOKEN}"' \
  "$ROOT_DIR/monitoring/caddy/Caddyfile" >/dev/null

printf 'compose isolates Dockhand and wires backend authentication\n'
