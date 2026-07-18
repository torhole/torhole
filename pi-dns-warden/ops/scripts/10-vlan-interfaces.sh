#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env at: $ENV_FILE"
  echo "Create it with: cp .env.example .env"
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ENV_FILE"

need() {
  local v="$1"
  if [[ -z "${!v:-}" ]]; then
    echo "Missing required env var: $v"
    exit 1
  fi
}

need PARENT_IF
need TRUSTED_VLAN_ID
need IOT_VLAN_ID

# Explicit parent interface names used by docker macvlan networks.
# Example for UniFi (common case):
#   TRUSTED_PARENT=eth0        (untagged)
#   IOT_PARENT=eth0.50         (tagged)
TRUSTED_PARENT="${TRUSTED_PARENT:-${PARENT_IF}.${TRUSTED_VLAN_ID}}"
IOT_PARENT="${IOT_PARENT:-${PARENT_IF}.${IOT_VLAN_ID}}"

modprobe 8021q || true

create_vlan() {
  local base_if="$1"
  local vid="$2"
  local ifname="${base_if}.${vid}"

  if ip link show "$base_if" >/dev/null 2>&1; then
    :
  else
    echo "ERROR: parent interface not found: $base_if"
    exit 1
  fi

  if ip link show "$ifname" >/dev/null 2>&1; then
    echo "Exists: $ifname"
  else
    echo "Creating: $ifname (VLAN $vid on $base_if)"
    ip link add link "$base_if" name "$ifname" type vlan id "$vid"
  fi

  ip link set "$ifname" up
}

ensure_iface() {
  # If desired interface has a dot (eth0.50), ensure it exists by creating a VLAN sub-interface.
  # If it's plain (eth0), do nothing.
  local desired="$1"
  local vid="$2"

  if [[ "$desired" == *.* ]]; then
    create_vlan "$PARENT_IF" "$vid"
  else
    if ip link show "$desired" >/dev/null 2>&1; then
      echo "Using untagged parent: $desired"
    else
      echo "ERROR: interface not found: $desired"
      exit 1
    fi
  fi
}

ensure_iface "$TRUSTED_PARENT" "$TRUSTED_VLAN_ID"
ensure_iface "$IOT_PARENT" "$IOT_VLAN_ID"

echo "OK: VLAN interfaces ready."
