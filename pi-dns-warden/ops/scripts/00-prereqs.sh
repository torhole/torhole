#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "Installing base tools..."
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  git \
  iproute2 \
  rfkill \
  jq \
  python3

echo "Installing Docker (official repository method)..."

# If Docker CLI is already present and the Compose plugin is available, don't touch the installation.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "Docker + Compose plugin already present. Skipping Docker installation."
  systemctl enable --now docker || true
else

# Uninstall conflicting/unofficial packages (safe if not installed)
# Ref: Docker Debian install docs
# shellcheck disable=SC2046  # intentional word-split: each package name must be a separate argument
apt-get remove -y $(dpkg --get-selections docker.io docker-compose docker-doc podman-docker containerd runc 2>/dev/null | cut -f1) 2>/dev/null || true

# Add Docker's official GPG key and repository
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
if [[ -z "$CODENAME" ]]; then
  echo "ERROR: could not determine VERSION_CODENAME from /etc/os-release"
  exit 1
fi

tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get update

# Install Docker Engine + CLI + Compose plugin
apt-get install -y --no-install-recommends \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

fi

systemctl enable --now docker

# Add the invoking user to the docker group (optional convenience)
if [[ -n "${SUDO_USER:-}" ]] && id "$SUDO_USER" >/dev/null 2>&1; then
  usermod -aG docker "$SUDO_USER" || true
fi

echo "OK: prerequisites installed."
echo "Verify: docker --version && docker compose version"
echo "NOTE: log out/in (or run: newgrp docker) to use docker without sudo."
