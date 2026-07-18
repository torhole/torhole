#!/usr/bin/env bash
set -euo pipefail

# Backwards-compatible wrapper (older docs used this filename).
# Use the main renderer:
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/15-render-dnscrypt.sh"
