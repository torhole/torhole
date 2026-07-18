#!/usr/bin/env bash

# Load a dotenv file as literal key/value data. Unlike `source`, this never
# evaluates command substitutions, expansions, redirects, or shell syntax.
load_env_file() {
  local env_file="$1"
  local parsed_file
  local key
  local value

  if [[ ! -f "$env_file" ]]; then
    echo "Missing env file: $env_file" >&2
    return 1
  fi

  parsed_file="$(mktemp)"
  if ! python3 - "$env_file" >"$parsed_file" <<'PY'
import re
import shlex
import sys

path = sys.argv[1]
key_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

with open(path, "r", encoding="utf-8") as handle:
    for line_number, raw_line in enumerate(handle, 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            print(f"{path}:{line_number}: expected KEY=VALUE", file=sys.stderr)
            raise SystemExit(1)

        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not key_pattern.fullmatch(key):
            print(f"{path}:{line_number}: invalid environment key {key!r}", file=sys.stderr)
            raise SystemExit(1)

        raw_value = raw_value.strip()
        if raw_value.startswith(("'", '"')):
            try:
                parts = shlex.split(raw_value, comments=True, posix=True)
            except ValueError as exc:
                print(f"{path}:{line_number}: invalid quoted value: {exc}", file=sys.stderr)
                raise SystemExit(1)
            if len(parts) > 1:
                print(f"{path}:{line_number}: unexpected tokens after quoted value", file=sys.stderr)
                raise SystemExit(1)
            value = parts[0] if parts else ""
        else:
            value = re.split(r"\s+#", raw_value, maxsplit=1)[0].rstrip()

        sys.stdout.buffer.write(key.encode("utf-8") + b"\0")
        sys.stdout.buffer.write(value.encode("utf-8") + b"\0")
PY
  then
    rm -f "$parsed_file"
    return 1
  fi

  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    printf -v "$key" '%s' "$value"
    # shellcheck disable=SC2163  # $key holds the variable NAME to export — correct indirection, not a literal
    export "$key"
  done <"$parsed_file"

  rm -f "$parsed_file"
}
