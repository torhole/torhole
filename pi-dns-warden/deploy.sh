#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DISABLE_RADIOS=0
SKIP_PREREQS=0
HARDEN_HOST=0
SET_HOSTNAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --disable-radios)
      DISABLE_RADIOS=1
      shift
      ;;
    --skip-prereqs)
      SKIP_PREREQS=1
      shift
      ;;
    --harden-host)
      HARDEN_HOST=1
      shift
      ;;
    --hostname)
      SET_HOSTNAME="${2:-}"
      if [[ -z "$SET_HOSTNAME" ]]; then
        echo "--hostname requires a value"
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      echo "Usage: sudo ./deploy.sh [--disable-radios] [--harden-host] [--hostname <name>] [--skip-prereqs]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo ./deploy.sh"
  exit 1
fi

# Preflight: on x86_64, upstream amd64 images (e.g. dockhand) ship glibc built
# for the x86-64-v2 microarchitecture level. A VM with a default/kvm64-class
# vCPU crash-loops with "Fatal glibc error: CPU does not support x86-64-v2".
# Fail fast here instead. (ARM hosts like the Pi 5 use different images — skip.)
if [[ "$(uname -m)" == "x86_64" ]]; then
  V2_MISSING=""
  for flag in cx16 lahf_lm popcnt sse4_1 sse4_2 ssse3; do
    grep -qw "$flag" /proc/cpuinfo || V2_MISSING="$V2_MISSING $flag"
  done
  if [[ -n "$V2_MISSING" ]]; then
    echo "ERROR: CPU does not meet x86-64-v2 (missing:$V2_MISSING)."
    echo "Containers such as dockhand will crash-loop with a fatal glibc error."
    echo "On Proxmox: qm set <vmid> --cpu x86-64-v2-AES, then cold-restart the VM"
    echo "(a reboot from inside the guest is NOT enough to change the CPU type)."
    exit 1
  fi
fi

cd "$ROOT_DIR"

if [[ ! -f ".env" ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example"
  echo "Edit .env then re-run: sudo ./deploy.sh"
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ROOT_DIR/.env"
source "$ROOT_DIR/ops/lib/torhole-hostnames.sh"

# This script is the existing Advanced deployment engine. Older production
# .env files have no edition key, so they remain Advanced by default. Fail
# closed if Home was selected in the wizard: silently launching the Advanced
# stack would make the edition choice meaningless and could create conflicts
# with the Home compose project.
TORHOLE_EDITION="${TORHOLE_EDITION:-advanced}"
if [[ "$TORHOLE_EDITION" != "advanced" ]]; then
  echo "ERROR: pi-dns-warden/deploy.sh only activates Torhole Advanced."
  echo "Home is selected in .env, but automatic profile switching is not available yet."
  echo "No services were changed."
  exit 1
fi

# Topology and capability are separate concerns. Advanced single-LAN runs
# the same operational stack with one DNS plane; Advanced VLAN adds the IoT
# plane. Missing topology preserves the historical two-plane deployment.
TORHOLE_TOPOLOGY="${TORHOLE_TOPOLOGY:-vlan}"
if [[ "$TORHOLE_TOPOLOGY" != "single-lan" && "$TORHOLE_TOPOLOGY" != "vlan" ]]; then
  echo "ERROR: TORHOLE_TOPOLOGY must be single-lan or vlan."
  exit 1
fi
export TORHOLE_TOPOLOGY

need() {
  local v="$1"
  if [[ -z "${!v:-}" ]]; then
    echo "Missing required .env value: $v"
    exit 1
  fi
}

need TZ
need PARENT_IF
need TRUSTED_PARENT
need TRUSTED_SUBNET_CIDR
need TRUSTED_GATEWAY
need PIHOLE_TRUSTED_IP
need PIHOLE_TRUSTED_PASSWORD
need TORHOLE_ADMIN_USER
need TORHOLE_ADMIN_PASSWORD
need TOR_CONTROL_PASSWORD
need HOST_MGMT_IP

TORHOLE_WEB_MODE="${TORHOLE_WEB_MODE:-https-local}"
case "$TORHOLE_WEB_MODE" in
  http) TORHOLE_WEB_SCHEME="http" ;;
  https-local|https-custom) TORHOLE_WEB_SCHEME="https" ;;
  *)
    echo "ERROR: TORHOLE_WEB_MODE must be http, https-local, or https-custom."
    exit 1
    ;;
esac
export TORHOLE_WEB_MODE TORHOLE_WEB_SCHEME

if [[ "$TORHOLE_TOPOLOGY" == "vlan" ]]; then
  need IOT_PARENT
  need TRUSTED_VLAN_ID
  need IOT_VLAN_ID
  need IOT_SUBNET_CIDR
  need IOT_GATEWAY
  need PIHOLE_IOT_IP
  need PIHOLE_IOT_PASSWORD
fi

# Optional but used for nicer output and for host firewall allow rules.
HOST_MGMT_IP="${HOST_MGMT_IP:-}"

if [[ $SKIP_PREREQS -eq 0 ]]; then
  echo "[1/13] Installing prerequisites"
  bash ./ops/scripts/00-prereqs.sh
else
  echo "[1/13] Skipping prerequisites"
fi

REBOOT_REQUIRED=0

if [[ $HARDEN_HOST -eq 1 ]]; then
  echo "[2/13] Hardening host (safe baseline)"
  bash ./ops/scripts/06-harden-host.sh
else
  echo "[2/13] Skipping host hardening"
fi

if [[ -n "$SET_HOSTNAME" ]]; then
  echo "[3/13] Setting hostname: $SET_HOSTNAME"
  hostnamectl set-hostname "$SET_HOSTNAME"
  REBOOT_REQUIRED=1
else
  echo "[3/13] Skipping hostname set"
fi

if [[ $DISABLE_RADIOS -eq 1 ]]; then
  echo "[4/13] Disabling Wi-Fi and Bluetooth"
  bash ./ops/scripts/05-disable-radios.sh
  REBOOT_REQUIRED=1
else
  echo "[4/13] Skipping radio disable"
fi

echo "[5/13] Preparing ${TORHOLE_TOPOLOGY} network interfaces"
bash ./ops/scripts/10-vlan-interfaces.sh

echo "[6/13] Installing systemd units (host network + stack autostart)"
install_unit() {
  local template="$1"
  local unit_name="$2"
  local dst="/etc/systemd/system/${unit_name}"

  if [[ ! -f "$template" ]]; then
    echo "ERROR: missing systemd template: $template"
    exit 1
  fi

  sed "s|@ROOT_DIR@|${ROOT_DIR}|g" "$template" > "$dst"
}

install_unit "${ROOT_DIR}/ops/systemd/pihole-tor-vlans.service.template" "pihole-tor-vlans.service"
install_unit "${ROOT_DIR}/ops/systemd/pihole-tor.service.template" "pihole-tor.service"
install_unit "${ROOT_DIR}/ops/systemd/pihole-tor-prometheus-watchdog.service.template" "pihole-tor-prometheus-watchdog.service"
install_unit "${ROOT_DIR}/ops/systemd/pihole-tor-prometheus-watchdog.timer.template" "pihole-tor-prometheus-watchdog.timer"

systemctl daemon-reload
systemctl enable --now pihole-tor-vlans.service
systemctl enable --now pihole-tor-prometheus-watchdog.timer

echo "[7/13] Building Torhole admin UI"
bash ./ops/scripts/14-build-admin-ui.sh

echo "[8/13] Rendering dnscrypt-proxy configs"
bash ./ops/scripts/15-render-dnscrypt.sh

echo "[9/13] Rendering reverse proxy DNS config"
bash ./ops/scripts/16-render-reverse-proxy-dns.sh

echo "[10/13] Rendering alertmanager config"
bash ./ops/scripts/17-render-alertmanager.sh

echo "[11/13] Rendering shared auth config"
bash ./ops/scripts/18-render-auth.sh

echo "[12/13] Validating rendered config"
bash ./ops/scripts/19-validate-stack.sh

echo "[13/13] Starting and verifying containers"
bash ./ops/scripts/20-up.sh
bash ./ops/scripts/24-configure-blocklists.sh
bash ./ops/scripts/21-verify-privacy.sh

echo
echo "Enabling stack autostart (systemd): pihole-tor.service"
systemctl enable pihole-tor.service

# Enable autostart for the whole stack (do not force a restart now)
systemctl enable pihole-tor.service

echo
echo "=== Deployment complete ==="
echo "Pi-hole DNS endpoints"
if [[ "$TORHOLE_TOPOLOGY" == "single-lan" ]]; then
  echo "  Flat LAN: ${PIHOLE_TRUSTED_IP}"
else
  echo "  Trusted:  ${PIHOLE_TRUSTED_IP}"
  echo "  IoT:      ${PIHOLE_IOT_IP}"
fi
echo
echo "Web UIs"
if [[ "$TORHOLE_TOPOLOGY" == "single-lan" ]]; then
  echo "  Pi-hole UI (direct LAN IP): http://${PIHOLE_TRUSTED_IP}/admin"
else
  echo "  Trusted Pi-hole UI (direct VLAN IP): http://${PIHOLE_TRUSTED_IP}/admin"
fi
if [[ -n "${HOST_MGMT_IP}" ]]; then
  echo "  Torhole by IP:      http://${HOST_MGMT_IP}/"
  echo "  Reverse proxy:      ${TORHOLE_WEB_SCHEME}://${TORHOLE_HOST_TORHOLE}.${REVERSE_PROXY_DOMAIN}"
  echo "  Grafana:            ${TORHOLE_WEB_SCHEME}://${TORHOLE_HOST_GRAFANA}.${REVERSE_PROXY_DOMAIN}"
  echo "  Prometheus:         ${TORHOLE_WEB_SCHEME}://${TORHOLE_HOST_PROMETHEUS}.${REVERSE_PROXY_DOMAIN}"
  echo "  Alertmanager:       ${TORHOLE_WEB_SCHEME}://${TORHOLE_HOST_ALERTMANAGER}.${REVERSE_PROXY_DOMAIN}"
  echo "  Dockhand:           ${TORHOLE_WEB_SCHEME}://${TORHOLE_HOST_DOCKHAND}.${REVERSE_PROXY_DOMAIN}"
  echo "  Pi-hole Trusted:    ${TORHOLE_WEB_SCHEME}://${TORHOLE_HOST_PIHOLE_TRUSTED}.${REVERSE_PROXY_DOMAIN}/admin/"
  if [[ "$TORHOLE_TOPOLOGY" == "vlan" ]]; then
    echo "  Pi-hole IoT:        ${TORHOLE_WEB_SCHEME}://${TORHOLE_HOST_PIHOLE_IOT}.${REVERSE_PROXY_DOMAIN}/admin/"
  fi
else
  echo "  Reverse proxy:      ${TORHOLE_WEB_SCHEME}://${TORHOLE_HOST_TORHOLE}.<your-domain>"
fi
echo
if [[ "$TORHOLE_TOPOLOGY" == "single-lan" ]]; then
  echo "Router/DHCP: set the LAN DNS server to ${PIHOLE_TRUSTED_IP}."
else
  echo "Router/DHCP: set each VLAN DNS server to its matching Pi-hole IP above."
fi

if [[ $REBOOT_REQUIRED -eq 1 ]]; then
  echo
  echo "Reboot recommended: sudo reboot"
fi
