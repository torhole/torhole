#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST_DIR="$ROOT_DIR/monitoring/caddy/v2"
EXPORT_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$EXPORT_DIR"
}
trap cleanup EXIT

echo "Building the Torhole admin UI in an isolated Node container..."
docker build \
  --target export \
  --output "type=local,dest=${EXPORT_DIR}" \
  -f "$ROOT_DIR/monitoring/torhole-ui-v2/Dockerfile.export" \
  "$ROOT_DIR"

if [[ ! -f "$EXPORT_DIR/index.html" ]]; then
  echo "ERROR: admin UI build did not produce index.html."
  exit 1
fi

install -d -m 0755 "$DEST_DIR"
cp -a "$EXPORT_DIR/." "$DEST_DIR/"
find "$DEST_DIR" -type d -exec chmod 0755 {} +
find "$DEST_DIR" -type f -exec chmod 0644 {} +
echo "OK: Torhole admin UI built at monitoring/caddy/v2/."
