#!/usr/bin/env bash
# Deploy in-flight dev changes from local laptop to the running torhole host.
# Run from the repo root: bash ops/scripts/70-deploy-dev.sh [host] [--sso]
#
# What this does:
#   Phase 1 (always): build the admin UI, sync the build + backup-manager
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

UI_SRC_DIR="$ROOT_DIR/monitoring/torhole-ui"
# Vite outDir is ../caddy/admin-ui (see vite.config.ts). This path lives under
# the Caddy directory because it is served from /srv/admin-ui at the site root.
# Do not change it to dist/; the development workflow depends on this layout.
UI_BUILD_DIR="$ROOT_DIR/monitoring/caddy/admin-ui"

echo "==> Building admin UI (monitoring/torhole-ui)..."
if [[ ! -d "$UI_SRC_DIR" ]]; then
  echo "ERROR: $UI_SRC_DIR not found." >&2
  exit 1
fi
( cd "$UI_SRC_DIR" && npm run build --silent )

if [[ ! -f "$UI_BUILD_DIR/index.html" ]]; then
  echo "ERROR: $UI_BUILD_DIR/index.html missing after build." >&2
  echo "       Refusing to deploy a stale artifact set." >&2
  exit 1
fi

echo "==> Phase 1: syncing admin UI build + backup-manager..."
rsync -av --delete --checksum \
  "$UI_BUILD_DIR/" \
  "$REMOTE:$REMOTE_DIR/monitoring/caddy/admin-ui/"

rsync -av --checksum \
  "$ROOT_DIR/monitoring/backup-manager/server.py" \
  "$REMOTE:$REMOTE_DIR/monitoring/backup-manager/"

# backup-manager COPYs server.py into the image, so a plain restart
# will not pick up changes. Rebuild.
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d --build backup-manager"
echo "==> Phase 1 done. Admin UI + new API endpoints live."

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
