#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

services_for() {
  local topology="$1"
  TORHOLE_TOPOLOGY="$topology" bash -c '
    set -euo pipefail
    root="$1"
    source "$root/ops/scripts/_compose.sh"
    cd "$root"
    "${COMPOSE[@]}" --env-file .env.example \
      -f docker-compose.yml -f docker-compose.monitoring.yml \
      config --services
  ' _ "$ROOT_DIR"
}

single_services="$(services_for single-lan)"
vlan_services="$(services_for vlan)"

grep -qx 'pihole_trusted' <<<"$single_services"
grep -qx 'dnscrypt_trusted' <<<"$single_services"
if grep -Eq '^(pihole_iot|dnscrypt_iot)$' <<<"$single_services"; then
  echo "ERROR: Single-LAN compose unexpectedly activates the IoT plane." >&2
  exit 1
fi

grep -qx 'pihole_iot' <<<"$vlan_services"
grep -qx 'dnscrypt_iot' <<<"$vlan_services"

TORHOLE_TOPOLOGY=single-lan TORHOLE_WEB_MODE=http bash "$ROOT_DIR/ops/scripts/13-render-prometheus.sh"
if grep -Eq 'pihole_iot|dnscrypt_iot' "$ROOT_DIR/monitoring/prometheus/prometheus.runtime.yml"; then
  echo "ERROR: Single-LAN Prometheus config contains IoT probes." >&2
  exit 1
fi
grep -q 'reverse-proxy:80' "$ROOT_DIR/monitoring/prometheus/prometheus.runtime.yml"
if grep -q 'reverse-proxy:443' "$ROOT_DIR/monitoring/prometheus/prometheus.runtime.yml"; then
  echo "ERROR: HTTP Prometheus config still probes HTTPS port 443." >&2
  exit 1
fi
grep -q 'http://pihole_trusted/admin/login' "$ROOT_DIR/monitoring/prometheus/prometheus.runtime.yml"

TORHOLE_TOPOLOGY=vlan TORHOLE_WEB_MODE=https-local bash "$ROOT_DIR/ops/scripts/13-render-prometheus.sh"
grep -q 'pihole_iot:53' "$ROOT_DIR/monitoring/prometheus/prometheus.runtime.yml"
grep -q 'dnscrypt_iot:5053' "$ROOT_DIR/monitoring/prometheus/prometheus.runtime.yml"
grep -q 'reverse-proxy:443' "$ROOT_DIR/monitoring/prometheus/prometheus.runtime.yml"

single_hosts="$(TORHOLE_TOPOLOGY=single-lan bash -c 'source "$1/ops/lib/torhole-hostnames.sh"; torhole_public_hosts_csv' _ "$ROOT_DIR")"
grep -q 'torhole' <<<"$single_hosts"
grep -q 'pihole-trusted' <<<"$single_hosts"
if grep -q 'pihole-iot' <<<"$single_hosts"; then
  echo "ERROR: Single-LAN public DNS hosts include the inactive IoT plane." >&2
  exit 1
fi

vlan_hosts="$(TORHOLE_TOPOLOGY=vlan bash -c 'source "$1/ops/lib/torhole-hostnames.sh"; torhole_public_hosts_csv' _ "$ROOT_DIR")"
grep -q 'pihole-iot' <<<"$vlan_hosts"

TORHOLE_TOPOLOGY=single-lan bash "$ROOT_DIR/ops/scripts/14-render-caddy-topology.sh"
if grep -q 'PIHOLE_IOT\|pihole_iot' "$ROOT_DIR/monitoring/caddy/topology-sites.caddy"; then
  echo "ERROR: Single-LAN Caddy config exposes the inactive IoT plane." >&2
  exit 1
fi

TORHOLE_TOPOLOGY=vlan bash "$ROOT_DIR/ops/scripts/14-render-caddy-topology.sh"
grep -q 'TORHOLE_HOST_PIHOLE_IOT' "$ROOT_DIR/monitoring/caddy/topology-sites.caddy"
grep -q 'reverse_proxy pihole_iot:80' "$ROOT_DIR/monitoring/caddy/topology-sites.caddy"

# torrc is replaced atomically, so both deployment paths must recreate the Tor
# container rather than merely restart it against the stale bind-mount inode.
grep -Fq 'up -d --force-recreate tor' "$ROOT_DIR/ops/scripts/20-up.sh"
grep -Fq 'up -d --force-recreate tor' "$ROOT_DIR/ops/scripts/40-update.sh"
grep -Fq 'confirming Tor control-port authentication' "$ROOT_DIR/ops/scripts/21-verify-privacy.sh"
# Web-access maintenance must not recreate reverse-proxy dependencies such as
# Grafana, backup-manager, or the monitoring stack.
grep -Fq 'up -d --force-recreate --no-deps authelia reverse-proxy' \
  "$ROOT_DIR/ops/scripts/25-apply-web-access.sh"
grep -Fq 'openssl x509 -checkhost "$public_hostname"' \
  "$ROOT_DIR/ops/scripts/18-render-auth.sh"

printf 'Advanced Single-LAN and VLAN topology rendering passed\n'
