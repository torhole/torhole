#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

CFG="/boot/firmware/config.txt"
if [[ ! -f "$CFG" ]]; then
  CFG="/boot/config.txt"
fi

if [[ ! -f "$CFG" ]]; then
  echo "ERROR: config.txt not found in /boot/firmware/ or /boot/"
  exit 1
fi

backup="${CFG}.$(date +%Y%m%d-%H%M%S).bak"
cp -a "$CFG" "$backup"
echo "Backup created: $backup"

add_line() {
  local line="$1"
  if grep -qxF "$line" "$CFG"; then
    echo "Already set: $line"
  else
    echo "$line" >> "$CFG"
    echo "Added: $line"
  fi
}

# Raspberry Pi 5 overlays
add_line "dtoverlay=disable-wifi-pi5"
add_line "dtoverlay=disable-bt-pi5"

echo
echo "Done. Reboot required: sudo reboot"
