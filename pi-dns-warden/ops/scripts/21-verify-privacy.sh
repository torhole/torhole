#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Standalone verification must be deterministic. Do not depend on deploy.sh
# having exported the installation environment in a parent shell.
# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ROOT_DIR/.env"

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/scripts/_compose.sh"

compose_files=(-f docker-compose.yml -f docker-compose.monitoring.yml)
expected_services="$("${COMPOSE[@]}" "${compose_files[@]}" config --services | sort)"

echo "[verify] waiting for every Advanced service to remain running"
for attempt in {1..18}; do
  running_services="$("${COMPOSE[@]}" "${compose_files[@]}" ps --services --status running | sort)"
  missing_services="$(comm -23 \
    <(printf '%s\n' "$expected_services") \
    <(printf '%s\n' "$running_services"))"
  # The temporary bootstrap container intentionally shares this Compose
  # project during a web installation, so the running set may be a superset.
  # Fail only when a service required by the selected topology is missing.
  if [[ -z "$missing_services" ]]; then
    break
  fi
  if [[ "$attempt" == "18" ]]; then
    echo "ERROR: not every Advanced service reached the running state."
    echo "Missing services:"
    while IFS= read -r missing; do
      [[ -n "$missing" ]] && printf '  %s\n' "$missing"
    done <<<"$missing_services"
    "${COMPOSE[@]}" "${compose_files[@]}" ps
    exit 1
  fi
  sleep 5
done

echo "[verify] confirming password-protected IP recovery access"
recovery_url="http://${HOST_MGMT_IP}/v2/"
unauthenticated_code=""
for attempt in {1..10}; do
  unauthenticated_code="$(
    curl --silent --noproxy '*' --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 5 "$recovery_url" || true
  )"
  [[ "$unauthenticated_code" == "401" ]] && break
  sleep 1
done
if [[ "$unauthenticated_code" != "401" ]]; then
  echo "ERROR: IP recovery returned ${unauthenticated_code:-no response} without authentication; expected 401."
  exit 1
fi
authenticated_code="$(
  curl --silent --noproxy '*' --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --user "${TORHOLE_ADMIN_USER}:${TORHOLE_ADMIN_PASSWORD}" \
    "$recovery_url" || true
)"
if [[ "$authenticated_code" != "200" ]]; then
  echo "ERROR: IP recovery returned ${authenticated_code:-no response} with the Torhole admin login; expected 200."
  exit 1
fi

PIHOLE_CONTAINERS=(pihole_trusted)
DNSCRYPT_CONTAINERS=(dnscrypt-trusted)
if [[ "$TORHOLE_TOPOLOGY" == "vlan" ]]; then
  PIHOLE_CONTAINERS+=(pihole_iot)
  DNSCRYPT_CONTAINERS+=(dnscrypt-iot)
fi

echo "[verify] resolving DNS through every active Pi-hole plane"
for container in "${PIHOLE_CONTAINERS[@]}"; do
  answer=""
  for attempt in {1..18}; do
    # dig may print transport failures such as "communications error" to
    # stdout even with +short. Accept only an IPv4 response so error text can
    # never turn a failed privacy-path check into a false pass.
    answer="$(
      docker exec "$container" dig +short +time=3 +tries=1 @127.0.0.1 example.com A 2>/dev/null \
        | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print; exit }' \
        || true
    )"
    [[ -n "$answer" ]] && break
    sleep 5
  done
  if [[ -z "$answer" ]]; then
    echo "ERROR: ${container} could not resolve example.com through the private DNS path."
    exit 1
  fi
  echo "  ${container}: ${answer}"
done

echo "[verify] confirming Tor egress with the Tor Project"
tor_check=""
for attempt in {1..3}; do
  if tor_check="$(
    docker exec tor curl --silent --show-error --fail --max-time 30 \
      --socks5-hostname 127.0.0.1:9050 \
      https://check.torproject.org/api/ip
  )"; then
    break
  fi
  if [[ "$attempt" != "3" ]]; then
    echo "  Tor Project check reset; retrying (${attempt}/3)."
    sleep 5
  fi
done
if [[ -z "$tor_check" ]]; then
  echo "ERROR: could not complete the Tor Project egress check after 3 attempts."
  exit 1
fi
if ! python3 -c \
  'import json, sys; raise SystemExit(0 if json.load(sys.stdin).get("IsTor") is True else 1)' \
  <<<"$tor_check"; then
  echo "ERROR: the Tor Project did not confirm the Advanced stack's SOCKS egress as Tor."
  exit 1
fi

echo "[verify] confirming Tor control-port authentication"
if ! control_result="$("${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml exec -T backup-manager \
  python3 -c 'import server, sys; values = server.read_env_values_safe(); ok, detail = server._tor_control_command(values, "GETINFO version"); print("authenticated" if ok else detail); sys.exit(0 if ok else 1)' 2>&1)"; then
  echo "ERROR: Tor control-port authentication failed: ${control_result}" >&2
  exit 1
fi
echo "  ${control_result}"

echo "[verify] confirming dnscrypt-proxy has no direct egress network"
for container in "${DNSCRYPT_CONTAINERS[@]}"; do
  mapfile -t networks < <(
    docker inspect "$container" \
      --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
      | awk 'NF'
  )
  if [[ "${#networks[@]}" != "1" ]]; then
    echo "ERROR: ${container} is attached to ${#networks[@]} networks; expected one internal network."
    exit 1
  fi
  if [[ "$(docker network inspect "${networks[0]}" --format '{{.Internal}}')" != "true" ]]; then
    echo "ERROR: ${container} network ${networks[0]} is not internal."
    exit 1
  fi
done

echo "OK: Advanced ${TORHOLE_TOPOLOGY} services, active DNS plane(s), Tor egress, and bypass protection verified."
