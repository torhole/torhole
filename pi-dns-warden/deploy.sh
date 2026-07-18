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
need IOT_PARENT
need TRUSTED_VLAN_ID
need IOT_VLAN_ID
need TRUSTED_SUBNET_CIDR
need TRUSTED_GATEWAY
need IOT_SUBNET_CIDR
need IOT_GATEWAY
need PIHOLE_TRUSTED_IP
need PIHOLE_IOT_IP
need PIHOLE_TRUSTED_PASSWORD
need PIHOLE_IOT_PASSWORD
need TORHOLE_ADMIN_USER
need TORHOLE_ADMIN_PASSWORD
need TOR_CONTROL_PASSWORD

# Optional but used for nicer output and for host firewall allow rules.
HOST_MGMT_IP="${HOST_MGMT_IP:-}"

if [[ $SKIP_PREREQS -eq 0 ]]; then
  echo "[1/12] Installing prerequisites"
  ./ops/scripts/00-prereqs.sh
else
  echo "[1/12] Skipping prerequisites"
fi

REBOOT_REQUIRED=0

if [[ $HARDEN_HOST -eq 1 ]]; then
  echo "[2/12] Hardening host (safe baseline)"
  ./ops/scripts/06-harden-host.sh
else
  echo "[2/12] Skipping host hardening"
fi

if [[ -n "$SET_HOSTNAME" ]]; then
  echo "[3/12] Setting hostname: $SET_HOSTNAME"
  hostnamectl set-hostname "$SET_HOSTNAME"
  REBOOT_REQUIRED=1
else
  echo "[3/12] Skipping hostname set"
fi

if [[ $DISABLE_RADIOS -eq 1 ]]; then
  echo "[4/12] Disabling Wi-Fi and Bluetooth"
  ./ops/scripts/05-disable-radios.sh
  REBOOT_REQUIRED=1
else
  echo "[4/12] Skipping radio disable"
fi

echo "[5/12] Creating VLAN interfaces"
./ops/scripts/10-vlan-interfaces.sh

echo "[6/12] Installing systemd units (VLAN + stack autostart)"
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

echo "[7/12] Rendering dnscrypt-proxy configs"
./ops/scripts/15-render-dnscrypt.sh

echo "[8/12] Rendering reverse proxy DNS config"
./ops/scripts/16-render-reverse-proxy-dns.sh

echo "[9/12] Rendering alertmanager config"
./ops/scripts/17-render-alertmanager.sh

echo "[10/12] Rendering shared auth config"
./ops/scripts/18-render-auth.sh

echo "[11/12] Validating rendered config"
./ops/scripts/19-validate-stack.sh

echo "==> Rendering tor/torrc from .env (TOR_CONTROL_PASSWORD)..."
bash "$ROOT_DIR/ops/scripts/20-render-torrc.sh"

echo "[12/12] Starting containers"
./ops/scripts/20-up.sh

echo
echo "Enabling stack autostart (systemd): pihole-tor.service"
systemctl enable pihole-tor.service

# Enable autostart for the whole stack (do not force a restart now)
systemctl enable pihole-tor.service

echo
echo "=== Deployment complete ==="
echo "Pi-hole endpoints"
echo "  Trusted: ${PIHOLE_TRUSTED_IP}"
echo "  IoT:     ${PIHOLE_IOT_IP}"
echo
echo "Web UIs"
echo "  Trusted Pi-hole UI (direct VLAN IP): http://${PIHOLE_TRUSTED_IP}/admin"
if [[ -n "${HOST_MGMT_IP}" ]]; then
  echo "  Reverse proxy:      https://${TORHOLE_HOST_TORHOLE}.${REVERSE_PROXY_DOMAIN}"
  echo "  Grafana:            https://${TORHOLE_HOST_GRAFANA}.${REVERSE_PROXY_DOMAIN}"
  echo "  Prometheus:         https://${TORHOLE_HOST_PROMETHEUS}.${REVERSE_PROXY_DOMAIN}"
  echo "  Alertmanager:       https://${TORHOLE_HOST_ALERTMANAGER}.${REVERSE_PROXY_DOMAIN}"
  echo "  Dockhand:           https://${TORHOLE_HOST_DOCKHAND}.${REVERSE_PROXY_DOMAIN}"
  echo "  Pi-hole Trusted:    https://${TORHOLE_HOST_PIHOLE_TRUSTED}.${REVERSE_PROXY_DOMAIN}/admin/"
  echo "  Pi-hole IoT:        https://${TORHOLE_HOST_PIHOLE_IOT}.${REVERSE_PROXY_DOMAIN}/admin/"
else
  echo "  Reverse proxy:      https://${TORHOLE_HOST_TORHOLE}.<your-domain>"
fi
echo
echo "UniFi: set each VLAN DHCP DNS server to its Pi-hole IP above."

if [[ $REBOOT_REQUIRED -eq 1 ]]; then
  echo
  echo "Reboot recommended: sudo reboot"
fi
