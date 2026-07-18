#!/usr/bin/env bash
# Render the HashedControlPassword line in tor/torrc from TOR_CONTROL_PASSWORD
# in .env. Idempotent. Safe to run repeatedly. Refuses to overwrite the
# file if anything fails, preserving the last good hash.
#
# This keeps .env as the single source of truth for the control-port
# password: server.py already reads TOR_CONTROL_PASSWORD to talk to
# tor:9051, and this script makes sure the hashed form tor itself
# validates against stays in sync.
#
# Designed to run on the deploy host, not the developer laptop — the
# running `tor` container is used as the source of truth for
# `tor --hash-password`. If the container isn't running yet (fresh
# install), it falls back to building the image with `docker compose
# build tor` first, then uses `docker compose run --rm tor` for the hash
# step.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
TORRC="$ROOT_DIR/tor/torrc"
BEGIN_MARKER="# BEGIN HASHED_CONTROL_PASSWORD (generated)"
END_MARKER="# END HASHED_CONTROL_PASSWORD"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "20-render-torrc: $ENV_FILE not found" >&2
  exit 1
fi
if [[ ! -f "$TORRC" ]]; then
  echo "20-render-torrc: $TORRC not found" >&2
  exit 1
fi

# Read TOR_CONTROL_PASSWORD without sourcing .env (which would leak
# unrelated vars into this shell). Strip CR and surrounding quotes.
#
# NOTE: use `tail -n1` so that if .env accidentally contains two
# TOR_CONTROL_PASSWORD= lines (e.g. a botched rotation), we pick the
# same literal value that the shared safe dotenv loader in deploy.sh reads. POSIX
# shell semantics take the last assignment wins — head -n1 here would
# silently desync the hash from the running server.py view.
PASSWORD="$(grep -E '^TOR_CONTROL_PASSWORD=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'\$/\\1/")"
# Trim leading and trailing whitespace (spaces, tabs) only. Interior
# whitespace is preserved because a legitimate password may contain it.
PASSWORD="${PASSWORD#"${PASSWORD%%[![:space:]]*}"}"   # trim leading
PASSWORD="${PASSWORD%"${PASSWORD##*[![:space:]]}"}"   # trim trailing
if [[ -z "$PASSWORD" ]]; then
  echo "20-render-torrc: TOR_CONTROL_PASSWORD is unset or empty in $ENV_FILE" >&2
  echo "  (If this is a fresh install, set it in .env first — see .env.example)" >&2
  exit 1
fi

# Refuse to run if the marker block isn't present in torrc — means either
# the file has drifted or a stale version is deployed.
if ! grep -qF "$BEGIN_MARKER" "$TORRC" || ! grep -qF "$END_MARKER" "$TORRC"; then
  echo "20-render-torrc: $TORRC is missing the BEGIN/END marker block" >&2
  echo "  Refusing to write. Re-deploy the committed torrc and retry." >&2
  exit 1
fi

# Verify BEGIN appears before END on different lines. If a future
# maintainer hand-swaps the markers, the awk replacement below would
# silently drop everything after the BEGIN line, producing a torrc
# missing AvoidDiskWrites / HardwareAccel / the END marker — tor might
# still start with silently degraded config. Refuse to run in that case.
BEGIN_LINE=$(grep -nF "$BEGIN_MARKER" "$TORRC" | head -n1 | cut -d: -f1)
END_LINE=$(grep -nF "$END_MARKER" "$TORRC" | head -n1 | cut -d: -f1)
if [[ -z "$BEGIN_LINE" || -z "$END_LINE" || "$BEGIN_LINE" -ge "$END_LINE" ]]; then
  echo "20-render-torrc: BEGIN/END markers misordered or duplicated in $TORRC" >&2
  echo "  Expected BEGIN before END on different lines. Got BEGIN=$BEGIN_LINE END=$END_LINE." >&2
  exit 1
fi

# Generate the hash. Prefer the already-running tor container (matches the
# runtime binary exactly). Fall back to `docker compose run --rm tor` for
# fresh installs where the container hasn't started yet.
#
# Capture tor's stderr into a temp file so that if tor --hash-password
# (or the docker compose build) fails we can surface the real error
# instead of a bare "did not return a hashed value". The trap is set
# now and augmented later when $TMP is also created — rm -f tolerates
# either file being absent.
HASH_STDERR="$(mktemp)"
TMP=""
trap 'rm -f "$TMP" "$HASH_STDERR"' EXIT

# Note: `set -e` would abort on a failing command inside $(...), which
# would skip the explicit empty-hash check below. The `|| true` tail on
# each command substitution preserves the explicit check path.
if docker ps --format '{{.Names}}' | grep -qx tor; then
  HASH="$(docker exec tor tor --hash-password "$PASSWORD" 2>"$HASH_STDERR" | tail -n1 || true)"
else
  echo "20-render-torrc: tor container not running, building + running ephemerally..."
  if ! ( cd "$ROOT_DIR" && docker compose build tor ) >"$HASH_STDERR" 2>&1; then
    echo "20-render-torrc: docker compose build tor failed:" >&2
    sed 's/^/    /' "$HASH_STDERR" >&2
    exit 1
  fi
  HASH="$( cd "$ROOT_DIR" && docker compose run --rm --entrypoint tor tor --hash-password "$PASSWORD" 2>"$HASH_STDERR" | tail -n1 || true )"
fi

if [[ -z "$HASH" || "${HASH:0:3}" != "16:" ]]; then
  echo "20-render-torrc: tor --hash-password did not return a hashed value" >&2
  echo "  got: ${HASH:-<empty>}" >&2
  if [[ -s "$HASH_STDERR" ]]; then
    echo "  tor stderr:" >&2
    sed 's/^/    /' "$HASH_STDERR" >&2
  fi
  exit 1
fi

# Write to a temp file beside torrc so the mv stays on the same
# filesystem. Preserve the existing torrc permissions — tor runs as a
# non-root user inside the container and needs the file to stay
# world-readable. mktemp defaults to 0600 which breaks the container.
# The EXIT trap set earlier already cleans up $TMP once it's populated.
TMP="$(mktemp "${TORRC}.XXXXXX")"

# Copy existing mode onto the temp file (fall back to 0644 if stat fails).
if MODE="$(stat -c '%a' "$TORRC" 2>/dev/null)"; then
  :
elif MODE="$(stat -f '%Lp' "$TORRC" 2>/dev/null)"; then
  :
else
  MODE="644"
fi
# Whitelist modes that guarantee the "others-read" bit — tor inside the
# container runs as a non-root user and needs world-readable torrc.
# The last octal digit must be 4, 5, 6, or 7 (i.e. bit 4 set). Anything
# else (600, 640, 660, 000, …) gets clamped to 644.
if [[ ! "$MODE" =~ ^[0-7][0-7][4-7]$ ]]; then
  MODE="644"
fi
chmod "$MODE" "$TMP"

awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" -v hash="$HASH" '
  $0 == begin { print; print "HashedControlPassword " hash; skip=1; next }
  $0 == end   { skip=0; print; next }
  !skip       { print }
' "$TORRC" > "$TMP"

if ! grep -qF "HashedControlPassword ${HASH}" "$TMP"; then
  echo "20-render-torrc: refusing to write torrc — marker block missing or hash not injected" >&2
  exit 1
fi

mv "$TMP" "$TORRC"
chmod "$MODE" "$TORRC"
echo "20-render-torrc: updated $TORRC (HashedControlPassword refreshed from .env)"
