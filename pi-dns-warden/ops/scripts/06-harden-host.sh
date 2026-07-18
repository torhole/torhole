#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env at: $ENV_FILE"
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ENV_FILE"

TRUSTED_SUBNET_CIDR="${TRUSTED_SUBNET_CIDR:-192.168.1.0/24}"
VPN_SUBNET_CIDR="${VPN_SUBNET_CIDR:-}"
HOST_MGMT_IP="${HOST_MGMT_IP:-}"

export DEBIAN_FRONTEND=noninteractive

echo "[harden] Installing minimal security packages (ufw, unattended-upgrades)"
apt-get update
apt-get install -y --no-install-recommends ufw unattended-upgrades

echo "[harden] Enabling unattended upgrades"
# Enable periodic updates
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTO'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTO
systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true

echo "[harden] Hardening SSH (keys-only, no root login)"
SSHD_CFG="/etc/ssh/sshd_config"
if [[ -f "$SSHD_CFG" ]]; then
  cp -a "$SSHD_CFG" "${SSHD_CFG}.bak.$(date +%Y%m%d%H%M%S)"

  # Set or add settings
  set_sshd_opt() {
    local key="$1"
    local val="$2"
    if grep -qiE "^\s*${key}\s+" "$SSHD_CFG"; then
      sed -i -E "s/^\s*${key}\s+.*/${key} ${val}/I" "$SSHD_CFG"
    else
      echo "${key} ${val}" >> "$SSHD_CFG"
    fi
  }

  set_sshd_opt "PermitRootLogin" "no"
  set_sshd_opt "PasswordAuthentication" "no"
  set_sshd_opt "KbdInteractiveAuthentication" "no"
  set_sshd_opt "ChallengeResponseAuthentication" "no"

  # Validate before restart
  if sshd -t -f "$SSHD_CFG"; then
    systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || true
  else
    echo "[harden] ERROR: sshd_config validation failed. Restoring backup."
    latest_bak=$(ls -1t ${SSHD_CFG}.bak.* 2>/dev/null | head -n 1 || true)
    if [[ -n "$latest_bak" ]]; then
      cp -a "$latest_bak" "$SSHD_CFG"
      systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || true
    fi
    exit 1
  fi
else
  echo "[harden] WARNING: sshd_config not found; skipping SSH hardening"
fi

echo "[harden] Configuring firewall (UFW)"
# Try to detect the current SSH client IP to prevent lockout.
CLIENT_IP=""
if [[ -n "${SSH_CONNECTION:-}" ]]; then
  CLIENT_IP="$(echo "$SSH_CONNECTION" | awk '{print $1}')"
fi

# Reset to a known baseline
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Allow SSH from Trusted LAN
ufw allow from "$TRUSTED_SUBNET_CIDR" to any port 22 proto tcp
if [[ -n "$VPN_SUBNET_CIDR" ]]; then
  ufw allow from "$VPN_SUBNET_CIDR" to any port 22 proto tcp
fi

# If you're managing the Pi from a different network, allow your current SSH client too
if [[ -n "$CLIENT_IP" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    IN_TRUSTED=$(python3 - <<PY
import ipaddress
cidr = ipaddress.ip_network("$TRUSTED_SUBNET_CIDR", strict=False)
client = ipaddress.ip_address("$CLIENT_IP")
print("1" if client in cidr else "0")
PY
    )
    if [[ "$IN_TRUSTED" != "1" ]]; then
      echo "[harden] NOTE: current SSH client ($CLIENT_IP) is outside $TRUSTED_SUBNET_CIDR. Allowing it on port 22 to prevent lockout."
      ufw allow from "$CLIENT_IP" to any port 22 proto tcp
    fi
  else
    echo "[harden] NOTE: python3 not found; skipping client IP check."
  fi
fi

# Allow reverse proxy from Trusted LAN
ufw allow from "$TRUSTED_SUBNET_CIDR" to any port 80 proto tcp
ufw allow from "$TRUSTED_SUBNET_CIDR" to any port 443 proto tcp
if [[ -n "$VPN_SUBNET_CIDR" ]]; then
  ufw allow from "$VPN_SUBNET_CIDR" to any port 80 proto tcp
  ufw allow from "$VPN_SUBNET_CIDR" to any port 443 proto tcp
fi

# Enable
ufw --force enable

echo "[harden] Done. SSH is keys-only; firewall allows management from: $TRUSTED_SUBNET_CIDR"
if [[ -n "$VPN_SUBNET_CIDR" ]]; then
  echo "[harden] VPN subnet allowed on SSH/HTTP/HTTPS: $VPN_SUBNET_CIDR"
fi
if [[ -n "$HOST_MGMT_IP" ]]; then
  echo "[harden] Host management IP: $HOST_MGMT_IP"
fi
