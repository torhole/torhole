#!/usr/bin/env bash
set -euo pipefail

# A profile-disabled service is not automatically stopped by every Compose
# version. When an operator changes Advanced from VLAN to Single-LAN, stop the
# retired IoT containers explicitly so restart policies cannot keep an
# undeclared DNS plane alive. Bind-mounted Pi-hole/dnscrypt data is preserved.
if [[ "${TORHOLE_TOPOLOGY:-vlan}" != "single-lan" ]]; then
  exit 0
fi

for container in pihole_iot dnscrypt-iot; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    echo "Stopping inactive Single-LAN container: $container"
    docker stop "$container" >/dev/null
  fi
done
