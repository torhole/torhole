#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

marker="$tmp_dir/command-executed"

# 1) The literal loader must parse a dotenv file as data — never evaluating
#    quotes, comments, or (below) command substitutions.
env_file="$tmp_dir/test.env"
cat > "$env_file" <<EOF
SAFE_VALUE=hello
QUOTED_VALUE="hello world"
COMMENTED_VALUE=value # ignored comment
EOF

load_env_file "$env_file"
[[ "$SAFE_VALUE" == "hello" ]]      || { echo "SAFE_VALUE=[$SAFE_VALUE]" >&2; exit 1; }
[[ "$QUOTED_VALUE" == "hello world" ]] || { echo "QUOTED_VALUE=[$QUOTED_VALUE]" >&2; exit 1; }
[[ "$COMMENTED_VALUE" == "value" ]] || { echo "COMMENTED_VALUE=[$COMMENTED_VALUE]" >&2; exit 1; }

# 2) set_config_value must preserve a command-substitution payload as data
#    in .env and never execute it. Note payload holds a literal
#    "$(touch ...)" string — if any layer evaluated it, the marker file would
#    be created.
payload="\$(touch \"$marker\")"
PAYLOAD="$payload" TORHOLE_ROOT_DIR="$tmp_dir" python3 - "$ROOT_DIR/monitoring/backup-manager/server.py" <<'PY'
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("backup_manager_server", sys.argv[1])
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
server.set_config_value("TZ", os.environ["PAYLOAD"])
PY

# The substitution must not have run...
[[ ! -e "$marker" ]] || { echo "command substitution WAS executed (marker exists)" >&2; exit 1; }

# ...and loading the serialized value must reproduce the exact payload,
# regardless of safe dotenv quoting added by the writer.
load_env_file "$tmp_dir/.env"
[[ "$TZ" == "$payload" ]] || { echo "API value did not round-trip through the loader" >&2; exit 1; }
[[ ! -e "$marker" ]] || { echo "loader executed the command substitution" >&2; exit 1; }

printf 'API-written command substitution remained literal and did not execute\n'
