#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
TEMPLATE="${ROOT_DIR}/ops/dnscrypt-proxy.toml.template"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env at: $ENV_FILE"
  exit 1
fi
if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing template at: $TEMPLATE"
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ENV_FILE"

DNSCRYPT_RESOLVERS="${DNSCRYPT_RESOLVERS:-cloudflare-security,quad9-dnscrypt-ip4-filter-pri}"

DNSCRYPT_TIMEOUT_MS="${DNSCRYPT_TIMEOUT_MS:-5000}"
DNSCRYPT_KEEPALIVE_S="${DNSCRYPT_KEEPALIVE_S:-30}"

DNSCRYPT_CACHE_SIZE="${DNSCRYPT_CACHE_SIZE:-8192}"
DNSCRYPT_CACHE_MIN_TTL="${DNSCRYPT_CACHE_MIN_TTL:-60}"
DNSCRYPT_CACHE_MAX_TTL="${DNSCRYPT_CACHE_MAX_TTL:-86400}"
DNSCRYPT_NEG_MIN_TTL="${DNSCRYPT_NEG_MIN_TTL:-60}"
DNSCRYPT_NEG_MAX_TTL="${DNSCRYPT_NEG_MAX_TTL:-600}"

# Parse comma-separated resolver names into a TOML array
IFS=',' read -r -a RES_ARR <<< "$DNSCRYPT_RESOLVERS"
TOML_RES="["
first=1
for r in "${RES_ARR[@]}"; do
  r="$(echo "$r" | xargs)"
  [[ -z "$r" ]] && continue
  if [[ $first -eq 1 ]]; then
    TOML_RES+="'${r}'"
    first=0
  else
    TOML_RES+=", '${r}'"
  fi
done
TOML_RES+="]"

render_one() {
  local role="$1"
  local out="${ROOT_DIR}/dnscrypt/${role}/dnscrypt-proxy.toml"

  local su_var="DNSCRYPT_SOCKS_USER_${role^^}"
  local sp_var="DNSCRYPT_SOCKS_PASS_${role^^}"

  local socks_user_raw="${!su_var:-$role}"
  local socks_pass_raw="${!sp_var:-$role}"

  # URL-encode credentials so special characters don't break the proxy URL.
  # Example failures: quotes, spaces, non-ascii (like ç), etc.
  # (RFC-style percent-encoding)
  local socks_user socks_pass
  socks_user="$(V="$socks_user_raw" python3 - <<'PY'
import os, urllib.parse
print(urllib.parse.quote(os.environ['V'], safe=''))
PY
  )"
  socks_pass="$(V="$socks_pass_raw" python3 - <<'PY'
import os, urllib.parse
print(urllib.parse.quote(os.environ['V'], safe=''))
PY
  )"

  mkdir -p "$(dirname "$out")"

  sed \
    -e "s/@SOCKS_USER@/${socks_user}/g" \
    -e "s/@SOCKS_PASS@/${socks_pass}/g" \
    -e "s/@RESOLVERS@/${TOML_RES}/g" \
    -e "s/@TIMEOUT_MS@/${DNSCRYPT_TIMEOUT_MS}/g" \
    -e "s/@KEEPALIVE_S@/${DNSCRYPT_KEEPALIVE_S}/g" \
    -e "s/@CACHE_SIZE@/${DNSCRYPT_CACHE_SIZE}/g" \
    -e "s/@CACHE_MIN_TTL@/${DNSCRYPT_CACHE_MIN_TTL}/g" \
    -e "s/@CACHE_MAX_TTL@/${DNSCRYPT_CACHE_MAX_TTL}/g" \
    -e "s/@CACHE_NEG_MIN_TTL@/${DNSCRYPT_NEG_MIN_TTL}/g" \
    -e "s/@CACHE_NEG_MAX_TTL@/${DNSCRYPT_NEG_MAX_TTL}/g" \
    "$TEMPLATE" > "$out"
}

render_one trusted
if [[ "${TORHOLE_TOPOLOGY:-vlan}" == "vlan" ]]; then
  render_one iot
fi

echo "OK: dnscrypt-proxy configs rendered for ${TORHOLE_TOPOLOGY:-vlan} (DNSCRYPT_RESOLVERS=$DNSCRYPT_RESOLVERS)"
