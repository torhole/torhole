#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

failed=0
while IFS= read -r script; do
  if [[ ! -x "$script" ]]; then
    echo "ERROR: deployment script is not executable: ${script#"$ROOT_DIR"/}"
    failed=1
  fi
done < <(find "$ROOT_DIR/ops/scripts" -maxdepth 1 -type f -name '*.sh' ! -name '_recovery.sh' | sort)

if [[ ! -x "$ROOT_DIR/deploy.sh" ]]; then
  echo "ERROR: deploy.sh is not executable"
  failed=1
fi

if [[ ! -x "$ROOT_DIR/monitoring/docker-socket-proxy/entrypoint.sh" ]]; then
  echo "ERROR: Docker socket proxy entrypoint is not executable"
  failed=1
fi

if [[ "$failed" != "0" ]]; then
  exit 1
fi

echo "Executable-mode checks passed."
