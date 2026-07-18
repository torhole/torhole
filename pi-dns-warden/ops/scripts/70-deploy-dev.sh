#!/usr/bin/env bash
# Deploy in-flight dev changes from local laptop to the running torhole host.
# Run from the repo root: bash ops/scripts/70-deploy-dev.sh [host] [--sso]
#
# What this does:
#   Phase 1 (always): build v2 UI, sync the built dist + backup-manager
#                     server.py, rebuild backup-manager so COPY'd server.py
#                     is picked up.
#   Phase 2 (--sso):  sync Authelia config + Caddyfile, restart
#                     authelia + reverse-proxy.
#
# Usage:
#   bash ops/scripts/70-deploy-dev.sh hp@torhole          # UI + API only
#   bash ops/scripts/70-deploy-dev.sh hp@torhole --sso    # full SSO switch

set -euo pipefail

REMOTE="${1:-hp@torhole}"
REMOTE_DIR="/opt/pi-dns-warden"
SSO="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

V2_SRC_DIR="$ROOT_DIR/monitoring/torhole-ui-v2"
# Vite outDir is ../caddy/v2 (see vite.config.ts). This path lives under the
# caddy dir because /v2 is served directly by Caddy from /srv/v2. Do NOT
# change to dist/ — the dev workflow depends on this layout.
V2_BUILD_DIR="$ROOT_DIR/monitoring/caddy/v2"

echo "==> Building v2 UI (monitoring/torhole-ui-v2)..."
if [[ ! -d "$V2_SRC_DIR" ]]; then
  echo "ERROR: $V2_SRC_DIR not found. This script only targets the v2 UI;" >&2
  echo "       the legacy torhole-ui tree was removed." >&2
  exit 1
fi
( cd "$V2_SRC_DIR" && npm run build --silent )

if [[ ! -f "$V2_BUILD_DIR/index.html" ]]; then
  echo "ERROR: $V2_BUILD_DIR/index.html missing after build." >&2
  echo "       Refusing to deploy a stale artifact set." >&2
  exit 1
fi

echo "==> Phase 1: syncing v2 build + backup-manager..."
rsync -av --delete --checksum \
  "$V2_BUILD_DIR/" \
  "$REMOTE:$REMOTE_DIR/monitoring/caddy/v2/"

rsync -av --checksum \
  "$ROOT_DIR/monitoring/backup-manager/server.py" \
  "$REMOTE:$REMOTE_DIR/monitoring/backup-manager/"

# backup-manager COPYs server.py into the image, so a plain restart
# will not pick up changes. Rebuild.
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d --build backup-manager"
echo "==> Phase 1 done. v2 UI + new API endpoints live."

if [[ "$SSO" != "--sso" ]]; then
  echo
  echo "Skipping SSO switch. Re-run with --sso to apply the Authelia + Caddy auth changes."
  exit 0
fi

echo
echo "==> Phase 2: SSO switch (Authelia regex + Caddyfile)..."

rsync -av --checksum \
  "$ROOT_DIR/ops/scripts/18-render-auth.sh" \
  "$REMOTE:$REMOTE_DIR/ops/scripts/"

ssh "$REMOTE" "cd $REMOTE_DIR && bash ops/scripts/18-render-auth.sh"

rsync -av --checksum \
  "$ROOT_DIR/monitoring/caddy/Caddyfile" \
  "$ROOT_DIR/monitoring/caddy/auth-snippets.caddy" \
  "$REMOTE:$REMOTE_DIR/monitoring/caddy/"

echo "==> Restarting authelia and reverse-proxy..."
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose -f docker-compose.yml -f docker-compose.monitoring.yml restart authelia reverse-proxy"

echo
echo "==> Waiting 5s for Caddy to reload..."
sleep 5

echo "==> Checking Caddy logs..."
ssh "$REMOTE" "docker logs reverse-proxy --tail 15 2>&1"

echo
echo "==> Phase 2 done. SSO is now active for all services."
